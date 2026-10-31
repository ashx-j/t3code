import type { ServerProvider, ServerProviderSlashCommand, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

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

/** A plugin already handles a slash command with this name. */
export class PluginSlashCommandTakenError extends Schema.TaggedError<PluginSlashCommandTakenError>()(
  "PluginSlashCommandTakenError",
  { name: Schema.String, pluginName: Schema.String },
) {
  override get message(): string {
    return `${this.pluginName} already handles /${this.name}.`;
  }
}

/** The text to send instead, a block, or nothing to leave the text as it is. */
type DispatchOutcome =
  | { readonly text: string }
  | { readonly block: string; readonly pluginName: string }
  | undefined;

/** The host makes hooks safe: bounded and fail-open. */
type BeforeDispatchHook = (message: PluginOutgoingMessage) => Effect.Effect<DispatchOutcome>;

export interface PluginSlashCommand {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly name: string;
  readonly description?: string;
  readonly inputHint?: string;
}

export type PluginTextGenerationKind =
  | "threadTitle"
  | "commitMessage"
  | "prContent"
  | "branchName"
  | "reviewGuide";

/** A plugin's answer for one generation, unchecked, or nothing. The host bounds it. */
type TextGenerator = (input: Schema.JsonObject) => Effect.Effect<unknown>;

type SkillFolder = { readonly plugin: string; readonly skills: string };

/** What plugins give agents: instruction texts, and the folders of plugins that ship skills. */
export interface PluginAgentContext {
  readonly instructions: ReadonlyArray<string>;
  readonly skillFolders: ReadonlyArray<SkillFolder>;
}

/** Runs a plugin's slash command; `args` is the text after `/name`. The host bounds it. */
type SlashCommandHandler = (
  message: PluginOutgoingMessage & { readonly args: string },
) => Effect.Effect<DispatchOutcome>;

const SLASH_COMMAND = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/;

/** Adds plugin slash commands to every provider's lists, replacing provider commands of the same name. */
export const withPluginSlashCommands = <P extends ServerProvider>(
  providers: ReadonlyArray<P>,
  commands: ReadonlyArray<PluginSlashCommand>,
): ReadonlyArray<P> => {
  if (commands.length === 0) return providers;
  const names = new Set(commands.map((command) => command.name));
  const listed: ReadonlyArray<ServerProviderSlashCommand> = commands.map((command) => ({
    name: command.name,
    ...(command.description === undefined ? {} : { description: command.description }),
    ...(command.inputHint === undefined ? {} : { input: { hint: command.inputHint } }),
  }));
  const merge = (items: ReadonlyArray<ServerProviderSlashCommand>) => [
    ...items.filter((item) => !names.has(item.name)),
    ...listed,
  ];
  return providers.map((provider) => ({
    ...provider,
    slashCommands: merge(provider.slashCommands),
    ...(provider.workspaceSnapshots === undefined
      ? {}
      : {
          workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
            ...snapshot,
            slashCommands: merge(snapshot.slashCommands),
          })),
        }),
  }));
};

/** The registry behind the `PluginHooks` reference. */
export interface PluginHooksRegistry {
  /** Adds a hook and returns the effect that removes it. */
  readonly addBeforeDispatch: (hook: BeforeDispatchHook) => Effect.Effect<Effect.Effect<void>>;
  /**
   * The text to send. A plugin's slash command runs its handler instead of the hooks; other slash
   * commands pass unchanged. Otherwise every hook sees the message in order, and a block stops the
   * rest.
   */
  readonly beforeDispatch: (
    message: PluginOutgoingMessage,
  ) => Effect.Effect<string, PluginMessageBlockedError>;
  /** Adds a slash command and returns the effect that removes it. */
  readonly addSlashCommand: (
    command: PluginSlashCommand,
    handler: SlashCommandHandler,
  ) => Effect.Effect<Effect.Effect<void>, PluginSlashCommandTakenError>;
  readonly currentSlashCommands: Effect.Effect<ReadonlyArray<PluginSlashCommand>>;
  /** Adds a generator that T3 asks before its own, and returns the effect that removes it. */
  readonly addTextGenerator: (
    kind: PluginTextGenerationKind,
    generator: TextGenerator,
  ) => Effect.Effect<Effect.Effect<void>>;
  /** Adds instructions for agents and returns the effect that removes them. */
  readonly addAgentInstructions: (text: string) => Effect.Effect<Effect.Effect<void>>;
  /** Replaces the folders of active plugins that ship skills. */
  readonly setSkillFolders: (folders: ReadonlyArray<SkillFolder>) => Effect.Effect<void>;
  /** Nothing while no plugin gives agents anything, so turns stay as they were. */
  readonly agentContext: Effect.Effect<PluginAgentContext | undefined>;
  /** The generators for `kind`, in the order plugins added them. */
  readonly textGenerators: (
    kind: PluginTextGenerationKind,
  ) => Effect.Effect<ReadonlyArray<TextGenerator>>;
  /** The current commands, then the list after every change. */
  readonly slashCommands: Stream.Stream<ReadonlyArray<PluginSlashCommand>>;
}

// A reference with an inert default, so orchestration and its tests need no plugin wiring; the
// server provides the real registry to both the dispatch path and the plugin host.
export class PluginHooks extends Context.Reference<PluginHooksRegistry>("t3/plugins/PluginHooks", {
  defaultValue: () => ({
    addBeforeDispatch: () => Effect.succeed(Effect.void),
    beforeDispatch: (message) => Effect.succeed(message.text),
    addSlashCommand: () => Effect.succeed(Effect.void),
    currentSlashCommands: Effect.succeed([]),
    addTextGenerator: () => Effect.succeed(Effect.void),
    textGenerators: () => Effect.succeed([]),
    addAgentInstructions: () => Effect.succeed(Effect.void),
    setSkillFolders: () => Effect.void,
    // @effect-diagnostics-next-line effectSucceedWithVoid:off - The optional context needs undefined, not void.
    agentContext: Effect.succeed(undefined),
    // Stays open like the real registry's stream, so a stream zipped with it keeps running.
    slashCommands: Stream.concat(Stream.make([]), Stream.never),
  }),
}) {}

const applyOutcome = (text: string, outcome: DispatchOutcome) =>
  outcome === undefined
    ? Effect.succeed(text)
    : "block" in outcome
      ? Effect.fail(
          new PluginMessageBlockedError({ pluginName: outcome.pluginName, reason: outcome.block }),
        )
      : Effect.succeed(outcome.text);

const make = Effect.gen(function* () {
  const hooks = yield* Ref.make<ReadonlyArray<{ readonly run: BeforeDispatchHook }>>([]);
  const instructions = yield* Ref.make<ReadonlyArray<{ readonly text: string }>>([]);
  const skillFolders = yield* Ref.make<ReadonlyArray<SkillFolder>>([]);
  const generators = yield* Ref.make<
    ReadonlyArray<{ readonly kind: PluginTextGenerationKind; readonly run: TextGenerator }>
  >([]);
  const commands = yield* SubscriptionRef.make<
    ReadonlyArray<{ readonly command: PluginSlashCommand; readonly run: SlashCommandHandler }>
  >([]);
  const runHooks = (message: PluginOutgoingMessage) =>
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
                  .pipe(Effect.flatMap((outcome) => applyOutcome(text, outcome))),
            ),
      ),
    );
  return {
    addBeforeDispatch: (hook) =>
      Effect.sync(() => ({ run: hook })).pipe(
        Effect.tap((entry) => Ref.update(hooks, (all) => [...all, entry])),
        Effect.map((entry) => Ref.update(hooks, (all) => all.filter((other) => other !== entry))),
      ),
    beforeDispatch: (message) => {
      const trimmed = message.text.trimStart();
      if (!trimmed.startsWith("/")) return runHooks(message);
      const match = SLASH_COMMAND.exec(trimmed);
      if (match === null) return Effect.succeed(message.text);
      return SubscriptionRef.get(commands).pipe(
        Effect.flatMap((all) => {
          const entry = all.find((candidate) => candidate.command.name === match[1]);
          return entry === undefined
            ? Effect.succeed(message.text)
            : entry
                .run({ ...message, args: match[2]?.trim() ?? "" })
                .pipe(Effect.flatMap((outcome) => applyOutcome(message.text, outcome)));
        }),
      );
    },
    addSlashCommand: (command, handler) =>
      SubscriptionRef.modifyEffect(commands, (all) => {
        const taken = all.find((entry) => entry.command.name === command.name);
        if (taken !== undefined) {
          return Effect.fail(
            new PluginSlashCommandTakenError({
              name: command.name,
              pluginName: taken.command.pluginName,
            }),
          );
        }
        const entry = { command, run: handler };
        return Effect.succeed([
          SubscriptionRef.update(commands, (current) => current.filter((other) => other !== entry)),
          [...all, entry],
        ] as const);
      }),
    addTextGenerator: (kind, generator) =>
      Effect.sync(() => ({ kind, run: generator })).pipe(
        Effect.tap((entry) => Ref.update(generators, (all) => [...all, entry])),
        Effect.map((entry) =>
          Ref.update(generators, (all) => all.filter((other) => other !== entry)),
        ),
      ),
    addAgentInstructions: (text) =>
      Effect.sync(() => ({ text })).pipe(
        Effect.tap((entry) => Ref.update(instructions, (all) => [...all, entry])),
        Effect.map((entry) =>
          Ref.update(instructions, (all) => all.filter((other) => other !== entry)),
        ),
      ),
    setSkillFolders: (folders) => Ref.set(skillFolders, folders),
    agentContext: Effect.all([Ref.get(instructions), Ref.get(skillFolders)]).pipe(
      Effect.map(([texts, folders]) =>
        texts.length === 0 && folders.length === 0
          ? undefined
          : { instructions: texts.map((entry) => entry.text), skillFolders: folders },
      ),
    ),
    textGenerators: (kind) =>
      Ref.get(generators).pipe(
        Effect.map((all) => all.filter((entry) => entry.kind === kind).map((entry) => entry.run)),
      ),
    currentSlashCommands: SubscriptionRef.get(commands).pipe(
      Effect.map((all) => all.map((entry) => entry.command)),
    ),
    slashCommands: SubscriptionRef.changes(commands).pipe(
      Stream.map((all) => all.map((entry) => entry.command)),
    ),
  } satisfies PluginHooksRegistry;
});

export const layer = Layer.effect(PluginHooks, make);
