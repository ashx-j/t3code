import type { PluginId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

import type { PluginActivation } from "../PluginApi.ts";

/** What every facade group needs from the activation it belongs to. */
export interface FacadeContext {
  readonly pluginId: PluginId;
  readonly activation: PluginActivation;
  readonly context: Context.Context<never>;
  /** Runs an effect as a Promise that rejects with an `Error` carrying the failure's `_tag` as `code`. */
  readonly call: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  /** Runs an effect in the background for the plugin; failures are logged, not thrown. */
  readonly fork: <A, E>(effect: Effect.Effect<A, E>) => void;
  /** Exposes a stream as an iterable that ends when the plugin deactivates or `signal` aborts. */
  readonly iterate: <A, E>(stream: Stream.Stream<A, E>, signal?: AbortSignal) => AsyncIterable<A>;
}

class PluginApiCallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PluginApiError";
    this.code = code;
  }
}

const abortEffect = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    const onAbort = () => resume(Effect.void);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

export const makeFacadeContext = (input: {
  readonly pluginId: PluginId;
  readonly activation: PluginActivation;
  readonly context: Context.Context<never>;
}): FacadeContext => {
  const { activation, context, pluginId } = input;
  const runExit = Effect.runPromiseExitWith(context);
  return {
    ...input,
    call: (effect) =>
      runExit(effect).then((exit) => {
        if (Exit.isSuccess(exit)) return exit.value;
        const error = Cause.squash(exit.cause);
        const code =
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          typeof error._tag === "string"
            ? error._tag
            : "PluginApiFailure";
        throw new PluginApiCallError(
          code,
          error instanceof Error ? error.message : "The plugin API call failed.",
        );
      }),
    fork: (effect) => {
      Effect.runForkWith(context)(
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("plugin background work failed", {
              pluginId,
              cause: Cause.pretty(cause).slice(0, 500),
            }),
          ),
        ),
      );
    },
    iterate: (stream, signal) =>
      Stream.toAsyncIterableWith(
        stream.pipe(
          Stream.interruptWhen(abortEffect(activation.controller.signal)),
          signal === undefined ? (self) => self : Stream.interruptWhen(abortEffect(signal)),
        ),
        context,
      ),
  };
};
