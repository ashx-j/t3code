import type { PluginApi, PluginBeforeDispatchResult } from "@t3tools/plugin-sdk/server";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as PluginHooks from "../PluginHooks.ts";
import type { FacadeContext } from "./facade.ts";

// A hook sits on the send path of every message, so it gets a short deadline and fails open.
const BEFORE_DISPATCH_DEADLINE = Duration.seconds(2);
const MAX_APPENDED_CHARS = 20_000;

const appendedText = (result: PluginBeforeDispatchResult) =>
  typeof result === "object" &&
  result !== null &&
  "appendText" in result &&
  typeof result.appendText === "string" &&
  result.appendText.trim().length > 0
    ? result.appendText.slice(0, MAX_APPENDED_CHARS)
    : undefined;

export const makeTurnsApi = (
  facade: FacadeContext,
  services: { readonly hooks: PluginHooks.PluginHooksRegistry },
): PluginApi["turns"] => ({
  beforeDispatch: (hook) => {
    const { activation, pluginId } = facade;
    if (activation.controller.signal.aborted) {
      throw new Error("This plugin activation has ended.");
    }
    const remove = Effect.runSyncWith(facade.context)(
      services.hooks.addBeforeDispatch((message) =>
        activation.controller.signal.aborted
          ? Effect.sync(() => undefined)
          : Effect.tryPromise(() =>
              Promise.resolve().then(() =>
                hook({
                  threadId: message.threadId,
                  text: message.text,
                  createdBy: message.createdBy,
                }),
              ),
            ).pipe(
              Effect.timeoutOption(BEFORE_DISPATCH_DEADLINE),
              Effect.map(Option.match({ onNone: () => undefined, onSome: appendedText })),
              Effect.catchCause((cause) =>
                Effect.logWarning("plugin beforeDispatch hook failed", {
                  pluginId,
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
