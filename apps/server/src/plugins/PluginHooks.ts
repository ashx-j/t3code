import type {
  OrchestrationV2CreationSource,
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSlashCommand,
  ThreadId,
} from "@t3tools/contracts";
import { T3_SLASH_COMMAND_NAMES } from "@t3tools/shared/slashCommands";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
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
  /** `server` for text T3 or a plugin wrote, such as a usage-limit resume. */
  readonly creationSource: OrchestrationV2CreationSource;
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

/** The plugin already registered a slash command with this name. */
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

/** A slash command's answer, recorded in the thread instead of sending the message. */
export interface PluginCommandReply {
  readonly reply: string;
}

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

/** A skill an active plugin ships in `skills/<folder>/SKILL.md`. */
export interface PluginSkill {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly folder: string;
  /** The `name` in its frontmatter, which Codex invokes it by. */
  readonly name?: string;
  readonly description?: string;
  readonly path: string;
}

/** What plugins give agents: instruction texts, and the folders of plugins that ship skills. */
export interface PluginAgentContext {
  readonly instructions: ReadonlyArray<string>;
  readonly skillFolders: ReadonlyArray<SkillFolder>;
}

/** Runs a plugin's slash command; `args` is the text after `/name`. The host bounds it. */
type SlashCommandHandler = (
  message: PluginOutgoingMessage & { readonly args: string },
) => Effect.Effect<DispatchOutcome | PluginCommandReply>;

// Loose, because providers name commands with ":" and "_" (`/plugin:cmd`, `/mcp__server__prompt`).
// A name in no list is still text; only plugin registration uses the strict pattern.
const SLASH_COMMAND = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/;

/**
 * Adds plugin slash commands to every provider's lists. A provider's own command of the same
 * name, such as `/review`, stays and the plugin's is left out of that list.
 */
export const withPluginSlashCommands = <P extends ServerProvider>(
  providers: ReadonlyArray<P>,
  commands: ReadonlyArray<PluginSlashCommand>,
): ReadonlyArray<P> => {
  if (commands.length === 0) return providers;
  const listed: ReadonlyArray<ServerProviderSlashCommand> = commands.map((command) => ({
    name: command.name,
    ...(command.description === undefined ? {} : { description: command.description }),
    ...(command.inputHint === undefined ? {} : { input: { hint: command.inputHint } }),
  }));
  const merge = (items: ReadonlyArray<ServerProviderSlashCommand>) => {
    const own = new Set(items.map((item) => item.name));
    return [...items, ...listed.filter((command) => !own.has(command.name))];
  };
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

/**
 * Adds plugin skills to the lists of the providers that receive them, under the name each one
 * invokes them by: Claude namespaces a plugin folder's skills by the folder's manifest name (the
 * plugin id) and their folder, Codex uses the frontmatter name. A provider's own skill of the
 * same name stays and the plugin's is left out, as with slash commands.
 */
export const withPluginSkills = <P extends ServerProvider>(
  providers: ReadonlyArray<P>,
  skills: ReadonlyArray<PluginSkill>,
): ReadonlyArray<P> => {
  if (skills.length === 0) return providers;
  const listFor = (driver: string): ReadonlyArray<ServerProviderSkill> | undefined => {
    if (driver !== "claudeAgent" && driver !== "codex") return undefined;
    return skills.map((skill) => ({
      name:
        driver === "codex"
          ? (skill.name ?? skill.folder)
          : `${skill.pluginId}:${skill.folder.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
      path: skill.path,
      enabled: true,
      scope: "plugin",
      displayName: `${skill.pluginName}: ${skill.name ?? skill.folder}`,
      ...(skill.description === undefined ? {} : { description: skill.description }),
    }));
  };
  return providers.map((provider) => {
    const listed = listFor(provider.driver);
    if (listed === undefined) return provider;
    const merge = (items: ReadonlyArray<ServerProviderSkill>) => {
      const own = new Set(items.map((item) => item.name));
      return [...items, ...listed.filter((skill) => !own.has(skill.name))];
    };
    return {
      ...provider,
      skills: merge(provider.skills),
      ...(provider.workspaceSnapshots === undefined
        ? {}
        : {
            workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
              ...snapshot,
              skills: merge(snapshot.skills),
            })),
          }),
    };
  });
};

/** Adds plugin slash commands and skills to the provider lists clients receive. */
export const withPluginItems = <P extends ServerProvider>(
  providers: ReadonlyArray<P>,
  commands: ReadonlyArray<PluginSlashCommand>,
  skills: ReadonlyArray<PluginSkill>,
): ReadonlyArray<P> => withPluginSkills(withPluginSlashCommands(providers, commands), skills);

/** The names of a provider instance's own slash commands, with those of the thread's workspace. */
type ProviderSlashCommandNames = (
  instanceId: string,
  threadId: ThreadId,
) => Effect.Effect<ReadonlyArray<string>>;

/** The registry behind the `PluginHooks` reference. */
export interface PluginHooksRegistry {
  /** Adds a plugin's hook and returns the effect that removes it. */
  readonly addBeforeDispatch: (
    pluginId: string,
    hook: BeforeDispatchHook,
  ) => Effect.Effect<Effect.Effect<void>>;
  /**
   * The text to send, or a plugin's reply to record instead. Every hook sees the message in plugin
   * id order, and a block stops the rest. A slash command, a name in T3's, the provider's or a
   * plugin's list, skips the hooks; a plugin's command then runs its handler.
   */
  readonly beforeDispatch: (
    message: PluginOutgoingMessage,
    /** Read only when a plugin would run: a replay of an accepted command goes out unchanged. */
    alreadyAccepted: Effect.Effect<boolean>,
    /**
     * The provider instance the message goes to, read only when a plugin's slash command
     * matches: a command the provider has too goes to the provider, as its lists show.
     */
    providerInstanceId?: Effect.Effect<string | undefined>,
  ) => Effect.Effect<string | PluginCommandReply, PluginMessageBlockedError>;
  /**
   * Runs the hooks, not slash commands, on text that reaches an agent without a new message: a
   * queued message's edit or a delegated task's prompt. `message` is read only when a hook would
   * run; nothing there means the text is not the sender's own, so it passes unchanged. A command
   * may only be blocked, and with no model in `message`, any `/name` counts as one.
   */
  readonly beforeRewrite: (
    text: string,
    message: Effect.Effect<PluginOutgoingMessage | undefined>,
    alreadyAccepted: Effect.Effect<boolean>,
  ) => Effect.Effect<string, PluginMessageBlockedError>;
  /** Whether a hook or slash command would see a message, so sends must keep a thread's order. */
  readonly handlesMessages: Effect.Effect<boolean>;
  /** Sets where `beforeDispatch` reads providers' own commands. The plugin host supplies it. */
  readonly setProviderSlashCommands: (names: ProviderSlashCommandNames) => Effect.Effect<void>;
  /**
   * Adds a slash command and returns the effect that removes it. When plugins share a name, the
   * one whose id sorts first handles it, whatever order they started in.
   */
  readonly addSlashCommand: (
    command: PluginSlashCommand,
    handler: SlashCommandHandler,
  ) => Effect.Effect<Effect.Effect<void>, PluginSlashCommandTakenError>;
  readonly currentSlashCommands: Effect.Effect<ReadonlyArray<PluginSlashCommand>>;
  /** Adds a plugin's generator, asked before T3's own, and returns the effect that removes it. */
  readonly addTextGenerator: (
    pluginId: string,
    kind: PluginTextGenerationKind,
    generator: TextGenerator,
  ) => Effect.Effect<Effect.Effect<void>>;
  /**
   * Adds instructions for agents and returns the effect that removes them. They are kept in plugin
   * id order, so a plugin's restart changes neither Claude's process key nor Codex's context keys.
   */
  readonly addAgentInstructions: (
    pluginId: string,
    text: string,
  ) => Effect.Effect<Effect.Effect<void>>;
  /** Replaces the folders of active plugins that ship skills, and the skills in them. */
  readonly setSkillFolders: (
    folders: ReadonlyArray<SkillFolder>,
    skills: ReadonlyArray<PluginSkill>,
  ) => Effect.Effect<void>;
  readonly currentSkills: Effect.Effect<ReadonlyArray<PluginSkill>>;
  /** The current skills, then the list after every change. */
  readonly skills: Stream.Stream<ReadonlyArray<PluginSkill>>;
  /** Nothing while no plugin gives agents anything, so turns stay as they were. */
  readonly agentContext: Effect.Effect<PluginAgentContext | undefined>;
  /** The generators for `kind`, in plugin id order. */
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
    beforeRewrite: (text) => Effect.succeed(text),
    handlesMessages: Effect.succeed(false),
    setProviderSlashCommands: () => Effect.void,
    addSlashCommand: () => Effect.succeed(Effect.void),
    currentSlashCommands: Effect.succeed([]),
    addTextGenerator: () => Effect.succeed(Effect.void),
    textGenerators: () => Effect.succeed([]),
    addAgentInstructions: () => Effect.succeed(Effect.void),
    setSkillFolders: () => Effect.void,
    currentSkills: Effect.succeed([]),
    // @effect-diagnostics-next-line effectSucceedWithVoid:off - The optional context needs undefined, not void.
    agentContext: Effect.succeed(undefined),
    // These stay open like the real registry's streams, so a stream zipped with one keeps running.
    slashCommands: Stream.concat(Stream.make([]), Stream.never),
    skills: Stream.concat(Stream.make([]), Stream.never),
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

const applyCommandOutcome = (
  text: string,
  outcome: DispatchOutcome | PluginCommandReply,
): Effect.Effect<string | PluginCommandReply, PluginMessageBlockedError> =>
  outcome !== undefined && "reply" in outcome
    ? Effect.succeed(outcome)
    : applyOutcome(text, outcome);

type SlashCommandEntry = {
  readonly command: PluginSlashCommand;
  readonly run: SlashCommandHandler;
};

/**
 * Adds `entry` among other plugins' entries in id order, after the plugin's own, so the order in
 * which plugins finished starting never decides which one runs first.
 */
export const inPluginOrder = <E extends { readonly pluginId: string }>(
  all: ReadonlyArray<E>,
  entry: E,
): ReadonlyArray<E> => {
  const after = all.findIndex((other) => other.pluginId > entry.pluginId);
  return after === -1 ? [...all, entry] : [...all.slice(0, after), entry, ...all.slice(after)];
};

/** The commands that handle their names: of plugins sharing one, the id that sorts first. */
const handling = (all: ReadonlyArray<SlashCommandEntry>) =>
  all.filter(
    (entry) =>
      !all.some(
        (other) =>
          other.command.name === entry.command.name &&
          other.command.pluginId < entry.command.pluginId,
      ),
  );

const make = Effect.gen(function* () {
  const hooks = yield* Ref.make<
    ReadonlyArray<{ readonly pluginId: string; readonly run: BeforeDispatchHook }>
  >([]);
  const instructions = yield* Ref.make<
    ReadonlyArray<{ readonly pluginId: string; readonly text: string }>
  >([]);
  const skillFolders = yield* Ref.make<ReadonlyArray<SkillFolder>>([]);
  const skills = yield* SubscriptionRef.make<ReadonlyArray<PluginSkill>>([]);
  const generators = yield* Ref.make<
    ReadonlyArray<{
      readonly pluginId: string;
      readonly kind: PluginTextGenerationKind;
      readonly run: TextGenerator;
    }>
  >([]);
  const commands = yield* SubscriptionRef.make<ReadonlyArray<SlashCommandEntry>>([]);
  const providerCommands = yield* Ref.make<ProviderSlashCommandNames>(() => Effect.succeed([]));
  // `<instance>/<command>` pairs already logged, so a busy thread logs its collision once.
  const loggedCollisions = new Set<string>();
  const providerHas = (
    name: string,
    threadId: ThreadId,
    providerInstanceId: Effect.Effect<string | undefined> | undefined,
    shadowed: PluginSlashCommand | undefined,
  ): Effect.Effect<boolean> =>
    providerInstanceId === undefined
      ? Effect.succeed(false)
      : providerInstanceId.pipe(
          Effect.flatMap((instanceId) =>
            instanceId === undefined
              ? Effect.succeed(false)
              : Ref.get(providerCommands).pipe(
                  Effect.flatMap((names) => names(instanceId, threadId)),
                  Effect.map((names) => names.includes(name)),
                  Effect.tap((has) => {
                    const key = `${instanceId}/${name}`;
                    if (!has || shadowed === undefined || loggedCollisions.has(key)) {
                      return Effect.void;
                    }
                    loggedCollisions.add(key);
                    return Effect.logWarning(
                      "a provider's own slash command is used instead of a plugin's",
                      { pluginId: shadowed.pluginId, command: name, instanceId },
                    );
                  }),
                ),
          ),
        );
  // A plugin sees a message once: a replayed command id was handled when it was first accepted.
  const unlessAccepted = <A>(
    alreadyAccepted: Effect.Effect<boolean>,
    text: string,
    run: Effect.Effect<A, PluginMessageBlockedError>,
  ) =>
    alreadyAccepted.pipe(
      Effect.flatMap((accepted): Effect.Effect<string | A, PluginMessageBlockedError> =>
        accepted ? Effect.succeed(text) : run,
      ),
    );
  // A name in T3's, the provider's or a plugin's list. Without the message's provider, any `/name`
  // may be a command.
  const isCommand = (text: string, message: PluginOutgoingMessage): Effect.Effect<boolean> => {
    const name = SLASH_COMMAND.exec(text.trimStart())?.[1];
    if (name === undefined) return Effect.succeed(false);
    const instanceId = message.model?.instanceId;
    if (instanceId === undefined || T3_SLASH_COMMAND_NAMES.has(name)) return Effect.succeed(true);
    return SubscriptionRef.get(commands).pipe(
      Effect.flatMap((all) =>
        all.some((entry) => entry.command.name === name)
          ? Effect.succeed(true)
          : providerHas(name, message.threadId, Effect.succeed(instanceId), undefined),
      ),
    );
  };
  // Hooks never see a command: changed text would change what it does, and blocking one would keep
  // T3, the provider or a plugin from doing its job.
  const runHooks = (message: PluginOutgoingMessage, alreadyAccepted: Effect.Effect<boolean>) =>
    Ref.get(hooks).pipe(
      Effect.flatMap((all) =>
        all.length === 0
          ? Effect.succeed(message.text)
          : unlessAccepted(
              alreadyAccepted,
              message.text,
              Effect.reduce(
                all,
                () => message.text,
                (text, entry) =>
                  entry
                    .run({ ...message, text })
                    .pipe(Effect.flatMap((outcome) => applyOutcome(text, outcome))),
              ),
            ),
      ),
    );
  return {
    addBeforeDispatch: (pluginId, hook) =>
      Effect.sync(() => ({ pluginId, run: hook })).pipe(
        Effect.tap((entry) => Ref.update(hooks, (all) => inPluginOrder(all, entry))),
        Effect.map((entry) => Ref.update(hooks, (all) => all.filter((other) => other !== entry))),
      ),
    beforeDispatch: (message, alreadyAccepted, providerInstanceId) => {
      // Text that only starts with a slash, such as a path or "/please", is not a command; only a
      // name in T3's, the provider's or a plugin's list is.
      const match = SLASH_COMMAND.exec(message.text.trimStart());
      const name = match?.[1];
      if (name === undefined) return runHooks(message, alreadyAccepted);
      return Effect.all([SubscriptionRef.get(commands), Ref.get(hooks)]).pipe(
        Effect.flatMap(([all, hooked]) => {
          const entry = handling(all).find((candidate) => candidate.command.name === name);
          if (T3_SLASH_COMMAND_NAMES.has(name)) return Effect.succeed(message.text);
          if (entry === undefined && hooked.length === 0) return Effect.succeed(message.text);
          return providerHas(name, message.threadId, providerInstanceId, entry?.command).pipe(
            Effect.flatMap((owned) =>
              owned
                ? Effect.succeed(message.text)
                : entry === undefined
                  ? runHooks(message, alreadyAccepted)
                  : unlessAccepted(
                      alreadyAccepted,
                      message.text,
                      entry
                        .run({ ...message, args: match?.[2]?.trim() ?? "" })
                        .pipe(
                          Effect.flatMap((outcome) => applyCommandOutcome(message.text, outcome)),
                        ),
                    ),
            ),
          );
        }),
      );
    },
    beforeRewrite: (text, message, alreadyAccepted) =>
      Ref.get(hooks).pipe(
        Effect.flatMap((all) =>
          all.length === 0
            ? Effect.succeed(text)
            : message.pipe(
                Effect.flatMap((read) =>
                  read === undefined
                    ? Effect.succeed(text)
                    : isCommand(text, read).pipe(
                        Effect.flatMap((command) =>
                          command
                            ? Effect.succeed(text)
                            : runHooks({ ...read, text }, alreadyAccepted),
                        ),
                      ),
                ),
              ),
        ),
      ),
    handlesMessages: Effect.all([Ref.get(hooks), SubscriptionRef.get(commands)]).pipe(
      Effect.map(([hooked, listed]) => hooked.length > 0 || listed.length > 0),
    ),
    setProviderSlashCommands: (names) => Ref.set(providerCommands, names),
    addSlashCommand: (command, handler) =>
      SubscriptionRef.modifyEffect(commands, (all) => {
        const same = all.filter((entry) => entry.command.name === command.name);
        if (same.some((entry) => entry.command.pluginId === command.pluginId)) {
          return Effect.fail(
            new PluginSlashCommandTakenError({
              name: command.name,
              pluginName: command.pluginName,
            }),
          );
        }
        const entry = { command, run: handler };
        const added = [...all, entry];
        const used = handling(added).find((other) => other.command.name === command.name);
        return (
          same.length === 0
            ? Effect.void
            : Effect.logWarning("plugins share a slash command name; one of them handles it", {
                command: command.name,
                usedPluginId: used?.command.pluginId,
                plugins: [...same, entry].map((other) => other.command.pluginId),
              })
        ).pipe(
          Effect.as([
            SubscriptionRef.update(commands, (current) =>
              current.filter((other) => other !== entry),
            ),
            added,
          ] as const),
        );
      }),
    addTextGenerator: (pluginId, kind, generator) =>
      Effect.sync(() => ({ pluginId, kind, run: generator })).pipe(
        Effect.tap((entry) => Ref.update(generators, (all) => inPluginOrder(all, entry))),
        Effect.map((entry) =>
          Ref.update(generators, (all) => all.filter((other) => other !== entry)),
        ),
      ),
    addAgentInstructions: (pluginId, text) =>
      Effect.sync(() => ({ pluginId, text })).pipe(
        Effect.tap((entry) => Ref.update(instructions, (all) => inPluginOrder(all, entry))),
        Effect.map((entry) =>
          Ref.update(instructions, (all) => all.filter((other) => other !== entry)),
        ),
      ),
    // Every plugin state change sets them, and each emission rebuilds every client's provider list.
    setSkillFolders: (folders, listed) =>
      Ref.set(skillFolders, folders).pipe(
        Effect.andThen(SubscriptionRef.get(skills)),
        Effect.flatMap((current) =>
          Equal.equals(current, listed) ? Effect.void : SubscriptionRef.set(skills, listed),
        ),
      ),
    currentSkills: SubscriptionRef.get(skills),
    skills: SubscriptionRef.changes(skills),
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
      Effect.map((all) => handling(all).map((entry) => entry.command)),
    ),
    slashCommands: SubscriptionRef.changes(commands).pipe(
      Stream.map((all) => handling(all).map((entry) => entry.command)),
    ),
  } satisfies PluginHooksRegistry;
});

export const layer = Layer.effect(PluginHooks, make);
