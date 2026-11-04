// @effect-diagnostics nodeBuiltinImport:off - AsyncLocalStorage has no Effect counterpart, and it
// must follow plugin code through Node's own callbacks.
import * as NodeAsyncHooks from "node:async_hooks";

import { CommandId, type PluginId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { PluginActivation } from "../PluginApi.ts";

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
 * code starts, so a failure whose stack shows only Node's internals is still the plugin's.
 */
export const pluginCodeScope = new NodeAsyncHooks.AsyncLocalStorage<PluginId>();

/** What every facade group needs from the activation it belongs to. */
export interface FacadeContext {
  readonly pluginId: PluginId;
  readonly activation: PluginActivation;
  readonly context: Context.Context<never>;
  /** Runs the plugin's own code, such as a handler, in its scope. */
  readonly asPlugin: <A>(run: () => A) => A;
  /** Records a failure of a plugin callback that only T3 waits on, such as a schedule handler. */
  readonly reportFailure: (error: unknown) => void;
  /**
   * Runs an effect as a Promise that rejects with an `Error` carrying the failure's `_tag` as `code`.
   * Map results inside the effect: a `.then` on the Promise is a new one that nothing handles.
   */
  readonly call: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  /** Runs an effect in the background for the plugin; failures are logged, not thrown. */
  readonly fork: <A, E>(effect: Effect.Effect<A, E>) => void;
  /** Exposes a stream as an iterable that ends when the plugin deactivates or `signal` aborts. */
  readonly iterate: <A, E>(stream: Stream.Stream<A, E>, signal?: AbortSignal) => AsyncIterable<A>;
}

const PLUGIN_COMMAND_PREFIX = "command:plugin:";

/** A fresh id for a command a plugin causes, which names the plugin. */
export const newCommandId = (pluginId: string, crypto: Crypto.Crypto) =>
  crypto.randomUUIDv4().pipe(
    Effect.orDie,
    Effect.map((id) => CommandId.make(`${PLUGIN_COMMAND_PREFIX}${pluginId}:${id}`)),
  );

export const isPluginCommand = (commandId: CommandId) =>
  commandId.startsWith(PLUGIN_COMMAND_PREFIX);

/**
 * Hands a plugin a promise whose failure only the plugin sees: one it never awaits must not be an
 * unhandled rejection, which stops the server.
 */
const forPlugin = <A>(promise: Promise<A>): Promise<A> => {
  promise.catch(() => undefined);
  return promise;
};

/** A plugin API call refused before it ran, such as one with a bad argument. */
export const refused = (error: Error): Promise<never> => forPlugin(Promise.reject(error));

/** Carries its plugin, so a failure no plugin code handles is still the plugin's. */
export class PluginApiCallError extends Error {
  readonly code: string;
  readonly pluginId: PluginId;
  constructor(pluginId: PluginId, code: string, message: string) {
    super(message);
    this.name = "PluginApiError";
    this.code = code;
    this.pluginId = pluginId;
  }
}

/** Completes when `signal` aborts, at once if it already has. */
export const abortEffect = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    const onAbort = () => resume(Effect.void);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

/** Interrupts `effect` when the plugin deactivates or the plugin's own `signal` aborts. */
export const stopOnAbort =
  (activation: PluginActivation, signal: AbortSignal | undefined) =>
  <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.raceFirst(
      effect,
      abortEffect(
        signal === undefined
          ? activation.controller.signal
          : AbortSignal.any([signal, activation.controller.signal]),
      ).pipe(Effect.andThen(Effect.interrupt)),
    );

export const makeFacadeContext = (input: {
  readonly pluginId: PluginId;
  readonly activation: PluginActivation;
  readonly context: Context.Context<never>;
  /** Where `reportFailure` sends failures; the host shows them on the plugin's row. */
  readonly onFailure?: (error: unknown) => void;
}): FacadeContext => {
  const { activation, context, pluginId } = input;
  // T3's work for a call is not the plugin's code, so it leaves the plugin's scope.
  const runExit = <A, E>(effect: Effect.Effect<A, E>) =>
    pluginCodeScope.exit(() => Effect.runPromiseExitWith(context)(effect));
  return {
    pluginId,
    activation,
    context,
    asPlugin: (run) => pluginCodeScope.run(pluginId, run),
    reportFailure:
      input.onFailure ??
      ((error) =>
        Effect.runForkWith(context)(
          Effect.logWarning("plugin code failed", { pluginId, reason: errorText(error) }),
        )),
    // Cleanups may still save state; afterwards a disabled plugin's leftovers cannot act.
    call: (effect) =>
      activation.ended.signal.aborted
        ? refused(
            new PluginApiCallError(
              pluginId,
              "PluginDeactivated",
              "This plugin activation has ended.",
            ),
          )
        : forPlugin(
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
                pluginId,
                code,
                error instanceof Error ? error.message : "The plugin API call failed.",
              );
            }),
          ),
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
