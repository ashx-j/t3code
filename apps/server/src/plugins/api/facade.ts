// @effect-diagnostics nodeBuiltinImport:off - AsyncLocalStorage has no Effect counterpart, and it
// must follow plugin code through Node's own callbacks.
import * as NodeAsyncHooks from "node:async_hooks";

import type { PluginId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const MAX_ERROR_CHARS = 500;

/** A plugin error's text for logs, states and replies, bounded. */
export const errorText = (cause: unknown) => {
  let text = "Unknown error";
  try {
    text =
      cause instanceof Error && typeof cause.message === "string" ? cause.message : String(cause);
  } catch {
    // Plugin code can throw values whose conversion to a string throws again.
  }
  return text.slice(0, MAX_ERROR_CHARS);
};

/** Plugin code threw or rejected. Its message is the plugin's own. */
export class PluginCodeError extends Schema.TaggedError<PluginCodeError>()("PluginCodeError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return errorText(this.cause);
  }
}

/**
 * The plugin whose code is running, carried through every timer, promise and Node callback that
 * code starts, so a failure whose stack shows only Node's internals is still the plugin's. The host
 * runs no server code before Node 24, where this needs promise hooks.
 */
export const pluginCodeScope = new NodeAsyncHooks.AsyncLocalStorage<PluginId>();

/** What every facade group needs from the activation it belongs to. */
export interface FacadeContext {
  /** Runs an effect in the background for the plugin; failures are logged, not thrown. */
  readonly fork: <A, E>(effect: Effect.Effect<A, E>) => void;
}

export const makeFacadeContext = (input: {
  readonly pluginId: PluginId;
  readonly context: Context.Context<never>;
}): FacadeContext => {
  const { context, pluginId } = input;
  return {
    fork: (effect) => {
      pluginCodeScope.exit(() =>
        Effect.runForkWith(context)(
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("plugin background work failed", {
                pluginId,
                cause: Cause.pretty(cause).slice(0, 500),
              }),
            ),
          ),
        ),
      );
    },
  };
};
