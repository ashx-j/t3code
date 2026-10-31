import type { PluginApi } from "@t3tools/plugin-sdk/server";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as PluginHooks from "../PluginHooks.ts";
import type { FacadeContext } from "./facade.ts";

// T3's own generators call a model and take seconds, so a plugin gets as long before T3 takes over.
const TEXT_GENERATION_DEADLINE = Duration.seconds(30);
const KINDS = new Set(["threadTitle", "commitMessage", "prContent", "branchName", "reviewGuide"]);
const isKind = (kind: string): kind is PluginHooks.PluginTextGenerationKind => KINDS.has(kind);

export const makeTextGenerationApi = (
  facade: FacadeContext,
  services: { readonly hooks: PluginHooks.PluginHooksRegistry },
): PluginApi["textGeneration"] => ({
  register: (kind, generate) => {
    const { activation, pluginId } = facade;
    if (activation.controller.signal.aborted) {
      throw new Error("This plugin activation has ended.");
    }
    if (!isKind(kind)) throw new TypeError(`"${kind}" is not a kind of text T3 Code generates.`);
    const remove = Effect.runSyncWith(facade.context)(
      services.hooks.addTextGenerator(kind, (input) =>
        Effect.tryPromise((signal) =>
          Promise.resolve().then(() =>
            // withPluginTextGeneration builds each kind's input to match its task type.
            generate(input as never, {
              signal: AbortSignal.any([signal, activation.controller.signal]),
            }),
          ),
        ).pipe(
          Effect.timeoutOption(TEXT_GENERATION_DEADLINE),
          // An answer from a plugin turned off meanwhile leaves the text to T3.
          Effect.map((result) =>
            activation.controller.signal.aborted ? undefined : Option.getOrUndefined(result),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("plugin text generator failed", {
              pluginId,
              kind,
              failure: String(cause).slice(0, 500),
            }).pipe(Effect.as(undefined)),
          ),
        ),
      ),
    );
    activation.controller.signal.addEventListener(
      "abort",
      () => Effect.runForkWith(facade.context)(remove),
      { once: true },
    );
  },
});
