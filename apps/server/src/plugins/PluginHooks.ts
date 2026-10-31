import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

export interface PluginOutgoingMessage {
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly text: string;
  readonly createdBy: "user" | "agent";
  readonly attachments: ReadonlyArray<{
    readonly type: string;
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
  }>;
  /** The model the message asked for; absent when the thread keeps its current one. */
  readonly model?: { readonly instanceId: string; readonly model: string };
}

/** A plugin stopped a message. `message` is what the sender sees. */
export class PluginMessageBlockedError extends Schema.TaggedError<PluginMessageBlockedError>()(
  "PluginMessageBlockedError",
  { pluginName: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `${this.pluginName}: ${this.reason}`;
  }
}

/**
 * The text to send instead, a block, or nothing to leave the text as it is. The host makes hooks
 * safe: bounded and fail-open.
 */
type BeforeDispatchHook = (
  message: PluginOutgoingMessage,
) => Effect.Effect<
  { readonly text: string } | { readonly block: string; readonly pluginName: string } | undefined
>;

/** The registry behind the `PluginHooks` reference. */
export interface PluginHooksRegistry {
  /** Adds a hook and returns the effect that removes it. */
  readonly addBeforeDispatch: (hook: BeforeDispatchHook) => Effect.Effect<Effect.Effect<void>>;
  /** The text to send after every hook has seen the message, in order; a block stops the rest. */
  readonly beforeDispatch: (
    message: PluginOutgoingMessage,
  ) => Effect.Effect<string, PluginMessageBlockedError>;
}

// A reference with an inert default, so orchestration and its tests need no plugin wiring; the
// server provides the real registry to both the dispatch path and the plugin host.
export class PluginHooks extends Context.Reference<PluginHooksRegistry>("t3/plugins/PluginHooks", {
  defaultValue: () => ({
    addBeforeDispatch: () => Effect.succeed(Effect.void),
    beforeDispatch: (message) => Effect.succeed(message.text),
  }),
}) {}

const make = Effect.gen(function* () {
  const hooks = yield* Ref.make<ReadonlyArray<{ readonly run: BeforeDispatchHook }>>([]);
  return {
    addBeforeDispatch: (hook) =>
      Effect.sync(() => ({ run: hook })).pipe(
        Effect.tap((entry) => Ref.update(hooks, (all) => [...all, entry])),
        Effect.map((entry) => Ref.update(hooks, (all) => all.filter((other) => other !== entry))),
      ),
    beforeDispatch: (message) =>
      Ref.get(hooks).pipe(
        Effect.flatMap((all) =>
          all.length === 0
            ? Effect.succeed(message.text)
            : Effect.reduce(
                all,
                () => message.text,
                (text, entry) =>
                  entry.run({ ...message, text }).pipe(
                    Effect.flatMap((result) =>
                      result === undefined
                        ? Effect.succeed(text)
                        : "block" in result
                          ? Effect.fail(
                              new PluginMessageBlockedError({
                                pluginName: result.pluginName,
                                reason: result.block,
                              }),
                            )
                          : Effect.succeed(result.text),
                    ),
                  ),
              ),
        ),
      ),
  } satisfies PluginHooksRegistry;
});

export const layer = Layer.effect(PluginHooks, make);
