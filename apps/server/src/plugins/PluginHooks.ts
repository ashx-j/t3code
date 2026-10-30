import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

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

/** Returns a paragraph to append, or nothing. The host makes hooks safe: bounded and fail-open. */
type BeforeDispatchHook = (message: PluginOutgoingMessage) => Effect.Effect<string | undefined>;

/** The registry behind the `PluginHooks` reference. */
export interface PluginHooksRegistry {
  /** Adds a hook and returns the effect that removes it. */
  readonly addBeforeDispatch: (hook: BeforeDispatchHook) => Effect.Effect<Effect.Effect<void>>;
  /** The text to send after every hook has seen the message. */
  readonly beforeDispatch: (message: PluginOutgoingMessage) => Effect.Effect<string>;
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
                  entry
                    .run({ ...message, text })
                    .pipe(
                      Effect.map((appended) =>
                        appended === undefined ? text : `${text}\n\n${appended}`,
                      ),
                    ),
              ),
        ),
      ),
  } satisfies PluginHooksRegistry;
});

export const layer = Layer.effect(PluginHooks, make);
