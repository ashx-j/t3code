import type {
  PluginAcpAgent,
  PluginProviderDriver,
  PluginProviderRuntime,
  PluginSourceControlDriver,
  PluginSourceControlRuntime,
} from "./providers.ts";
import type { JsonObject, JsonValue } from "./shared.ts";

/** `read` methods need the caller's `orchestration:read` scope, `write` methods `orchestration:operate`. */
export type PluginRpcAccess = "read" | "write";

export interface PluginRpcContext {
  /** Aborts when the caller goes away or the plugin deactivates. */
  readonly signal: AbortSignal;
}

export type PluginRpcHandler = (
  input: JsonValue | undefined,
  context: PluginRpcContext,
) => JsonValue | Promise<JsonValue>;

/** How every rejected API call fails. `code` names the server's error; treat it as opaque. */
export interface PluginApiError extends Error {
  readonly code: string;
}

export interface PluginStoredEvent {
  /** Orchestration sequence number. Pass it as `afterSequence` to resume after this event. */
  readonly sequence: number;
  readonly type: string;
  /** The orchestration domain event as the server encodes it on the wire. */
  readonly event: JsonObject;
}

export interface PluginMcpTool {
  /** Agents see the tool as `plg_<pluginId>_<name>`. Letters, digits, `_` and `-`. */
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool's arguments. */
  readonly inputSchema: JsonObject;
  /**
   * Every agent sees the tool. A `write` tool runs only for an agent in a thread set to Full
   * access and not in Plan mode, or an outside agent approved with Full access; others get a
   * refusal that says so. Agents from linked environments can't call it.
   */
  readonly access: PluginRpcAccess;
}

export type PluginMcpToolHandler = (
  input: JsonObject,
  context: {
    readonly signal: AbortSignal;
    /** The thread whose agent called the tool, or null for an MCP client outside a thread. */
    readonly threadId: string | null;
  },
) => JsonValue | Promise<JsonValue>;

export interface PluginHttpRequest {
  readonly method: string;
  /** The path after `/api/plugins/<pluginId>`, starting with `/`. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface PluginHttpResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

export type PluginHttpHandler = (
  request: PluginHttpRequest,
  context: { readonly signal: AbortSignal },
) => PluginHttpResponse | Promise<PluginHttpResponse>;

export interface PluginOutgoingMessage {
  readonly threadId: string;
  readonly messageId: string;
  readonly text: string;
  readonly createdBy: "user" | "agent";
  /**
   * Where the message came from. `server` is text T3 or a plugin wrote, such as "Continue where
   * you left off." after a usage limit, a delegated task's report or a plugin's `sendMessage`.
   */
  readonly creationSource: "web" | "mobile" | "mcp" | "provider" | "server";
  /** What is attached; the files themselves stay with the server. */
  readonly attachments: ReadonlyArray<{
    readonly type: string;
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
  }>;
  /** The model the message asked for; absent when the thread keeps its current one. */
  readonly model?: { readonly instanceId: string; readonly model: string };
}

export interface PluginCompletedRun {
  readonly runId: string;
  readonly threadId: string;
  /** `completed`, `interrupted`, `failed`, `cancelled` or `rolled_back`. */
  readonly status: string;
  /** The run as the server encodes it on the wire. */
  readonly run: JsonObject;
}

/**
 * Nothing leaves the message as it is. `appendText` adds a paragraph after it, `text` replaces it,
 * and `block` stops it: the sender gets the reason, after the plugin's name, and keeps their draft.
 */
export type PluginBeforeDispatchResult =
  | void
  | { readonly appendText: string }
  | { readonly text: string }
  | { readonly block: string };

export type PluginApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "acceptAlways"
  | "decline"
  | "cancel";

/** An approval or a question an agent is waiting on. */
export interface PluginRuntimeRequest {
  readonly threadId: string;
  readonly requestId: string;
  readonly runId: string | null;
  /** `command`, `file-read`, `file-change`, `mcp-elicitation` and `permission` are approvals; `user_input` is a question. */
  readonly kind: string;
  /** Approvals: what the agent wants to do, such as the command line. */
  readonly prompt?: string;
  readonly reason?: string;
  /** Approvals for an MCP server: its name. */
  readonly appName?: string;
  /** Approvals: the decisions this request offers. Empty for questions. */
  readonly decisions: ReadonlyArray<PluginApprovalDecision>;
  /** Approvals: whether a `decline` can carry `feedback` for the agent. */
  readonly canDeclineWithFeedback: boolean;
  /** Questions: answer each by its `id`. Empty for approvals. */
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
    readonly multiSelect: boolean;
    readonly allowCustomAnswer: boolean;
  }>;
}

/**
 * Nothing leaves the request to the user. An approval takes one of the request's `decisions`;
 * `feedback` is sent only with `decline` where `canDeclineWithFeedback`. A question takes
 * `answers` keyed by question id: an option's label, custom text, or several labels.
 */
export type PluginRuntimeRequestAnswer =
  | void
  | { readonly decision: PluginApprovalDecision; readonly feedback?: string }
  | { readonly answers: Readonly<Record<string, string | ReadonlyArray<string>>> };

export interface PluginSlashCommandInvocation {
  readonly threadId: string;
  readonly messageId: string;
  readonly name: string;
  /** The text after `/name`, trimmed. */
  readonly args: string;
  readonly createdBy: "user" | "agent";
  readonly attachments: PluginOutgoingMessage["attachments"];
}

/**
 * `text` is sent to the agent in place of the command, `block` stops the message with a reason the
 * sender sees, and nothing sends the command as typed. `reply` (Markdown, up to 20,000 characters)
 * answers in the thread: the command and the reply are recorded as a finished turn, and the agent
 * neither runs nor sees them.
 */
export type PluginSlashCommandResult =
  | void
  | { readonly text: string }
  | { readonly block: string }
  | { readonly reply: string };

/** What each kind of generated text receives and returns. */
export interface PluginTextGenerationTasks {
  readonly threadTitle: {
    readonly input: {
      readonly cwd: string;
      /** The message the title is for. */
      readonly message: string;
      readonly previousTitle?: string;
      readonly instructions?: string;
    };
    readonly output: { readonly title: string };
  };
  readonly commitMessage: {
    readonly input: {
      readonly cwd: string;
      readonly branch: string | null;
      readonly stagedSummary: string;
      readonly stagedPatch: string;
      /** Whether T3 also wants a branch name for the commit. */
      readonly includeBranch: boolean;
      /** The commit style the user picked in Settings, with the repository's examples. */
      readonly instructions?: string;
      /** How the user wants branches named, sent with `includeBranch`. */
      readonly branchInstructions?: string;
    };
    readonly output: { readonly subject: string; readonly body: string; readonly branch?: string };
  };
  readonly prContent: {
    readonly input: {
      readonly cwd: string;
      readonly baseBranch: string;
      readonly headBranch: string;
      readonly commitSummary: string;
      readonly diffSummary: string;
      readonly diffPatch: string;
      /** The repository's pull request template, if it has one. */
      readonly template?: string;
      readonly threadContext?: string;
      /** The pull request style the user picked in Settings, with the repository's examples. */
      readonly instructions?: string;
    };
    readonly output: { readonly title: string; readonly body: string };
  };
  readonly branchName: {
    readonly input: { readonly cwd: string; readonly message: string };
    readonly output: { readonly branch: string };
  };
  readonly reviewGuide: {
    readonly input: {
      readonly cwd: string;
      readonly number: number;
      readonly title: string;
      readonly description: string;
      readonly baseBranch: string;
      readonly baseCommit: string;
      readonly instructions?: string;
    };
    /** Each stop as the review guide's contract defines it. */
    readonly output: { readonly stops: ReadonlyArray<JsonObject> };
  };
}

export interface PluginLogger {
  readonly debug: (message: string, fields?: JsonObject) => void;
  readonly info: (message: string, fields?: JsonObject) => void;
  readonly warn: (message: string, fields?: JsonObject) => void;
  readonly error: (message: string, fields?: JsonObject) => void;
}

/** What `activate` receives. Everything is scoped to one activation and released on deactivate. */
export interface PluginApi {
  readonly version: 1;
  readonly id: string;
  readonly rootDir: string;
  readonly log: PluginLogger;
  readonly settings: {
    /**
     * The saved settings, secret values included. Fields nobody saved read as the `default` in
     * the manifest's `settingsSchema`, at the top level and for fields that are not secrets.
     */
    readonly get: () => Promise<JsonObject>;
    /** Yields the settings as `get` reads them after each change, until deactivation. */
    readonly changes: () => AsyncIterable<JsonObject>;
  };
  /** Keys starting with `t3.` are T3's own: `list` leaves them out, and `set` and `delete` refuse them. */
  readonly storage: {
    readonly get: (key: string) => Promise<JsonValue | undefined>;
    readonly set: (key: string, value: JsonValue) => Promise<void>;
    readonly delete: (key: string) => Promise<void>;
    readonly list: (prefix?: string) => Promise<ReadonlyArray<string>>;
  };
  readonly rpc: {
    /** Answers `plugins.invoke` calls for `method` from clients and agents. */
    readonly register: (
      method: string,
      handler: PluginRpcHandler,
      options: { readonly access: PluginRpcAccess },
    ) => void;
    /** Sends `value` to every `plugins.subscribe` caller on `channel`. Any session that can read this environment may subscribe, so never publish secrets. */
    readonly publish: (channel: string, value: JsonValue) => void;
  };
  /** Runs when the plugin is disabled or reloaded, or the server stops; at once if that already happened. */
  readonly onDeactivate: (cleanup: () => void | Promise<void>) => void;
  readonly events: {
    /**
     * Stored orchestration events of `types` in sequence order, after `afterSequence`, or from now
     * when omitted. Ends when the plugin deactivates or `signal` aborts. Events stored before the
     * call all arrive; after that, a consumer more than 1024 events behind loses the oldest, so
     * handle events quickly and store the last `sequence` to resume from after a restart.
     */
    readonly stored: (options: {
      readonly types: ReadonlyArray<string>;
      readonly afterSequence?: number;
      readonly signal?: AbortSignal;
    }) => AsyncIterable<PluginStoredEvent>;
  };
  readonly threads: {
    /**
     * Threads, newest activity first: those not archived, or with `archived: true` only the
     * archived ones. Deleted threads are never listed, and other calls treat them as not found.
     */
    readonly list: (options?: {
      readonly projectId?: string;
      readonly archived?: boolean;
    }) => Promise<ReadonlyArray<JsonObject>>;
    readonly read: (threadId: string) => Promise<JsonObject>;
    /**
     * Sends `text` to the thread's agent as a message from an agent, not the user, so send hooks
     * see `createdBy: "agent"`. Resolves once accepted.
     */
    readonly sendMessage: (input: {
      readonly threadId: string;
      readonly text: string;
      readonly mode?: "auto" | "queue" | "steer";
    }) => Promise<void>;
    /**
     * Shows a note in the thread, after its latest finished run, starting with the plugin's name.
     * It starts no turn, isn't sent to the agent and doesn't mark the thread unread. The summary
     * is cut at 200 characters and the detail at 20,000.
     */
    readonly notify: (input: {
      readonly threadId: string;
      readonly summary: string;
      readonly detail?: string;
      readonly outcome?: "completed" | "failed" | "updated";
    }) => Promise<void>;
    readonly interrupt: (threadId: string) => Promise<void>;
    readonly rename: (threadId: string, title: string) => Promise<void>;
    /**
     * Starts a thread in a project, with `message` as its first message if given. The model and
     * runtime mode default to the project's, as in the composer; a runtime mode the provider does
     * not offer steps down. `workspace` defaults to the project folder.
     */
    readonly create: (input: {
      readonly projectId: string;
      readonly title: string;
      readonly message?: string;
      readonly model?: { readonly instanceId: string; readonly model: string };
      readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
      readonly interactionMode?: "default" | "plan";
      readonly workspace?:
        | { readonly type: "root"; readonly branch?: string }
        | { readonly type: "worktree"; readonly baseRef: string; readonly branch?: string }
        | { readonly type: "existing_worktree"; readonly worktreePath: string };
    }) => Promise<{ readonly threadId: string }>;
    readonly archive: (threadId: string) => Promise<void>;
    readonly unarchive: (threadId: string) => Promise<void>;
    /** Deletes the thread as the client's delete does. */
    readonly delete: (threadId: string) => Promise<void>;
    /** Marks the thread done; a running turn settles it when it ends. */
    readonly settle: (threadId: string) => Promise<void>;
    readonly unsettle: (threadId: string) => Promise<void>;
    /** Hides the thread until `until`, a `Date` or an ISO date-time string. */
    readonly snooze: (threadId: string, until: Date | string) => Promise<void>;
    readonly unsnooze: (threadId: string) => Promise<void>;
  };
  readonly projects: {
    readonly list: () => Promise<ReadonlyArray<JsonObject>>;
    readonly read: (projectId: string) => Promise<JsonObject | undefined>;
    /** Adds a project for a folder on the server; resolves with the project. */
    readonly create: (input: {
      readonly title: string;
      readonly workspaceRoot: string;
      readonly createWorkspaceRootIfMissing?: boolean;
    }) => Promise<JsonObject>;
    /**
     * Changes a project's fields, such as `title`, `archived`, `pinned` or `scripts`, as the
     * project settings do; resolves with the project.
     */
    readonly update: (projectId: string, patch: JsonObject) => Promise<JsonObject>;
  };
  readonly secrets: {
    /**
     * Asks the user for a secret in a thread with a turn in progress, on the card agents' requests
     * use, and waits until they answer, the turn ends, `timeoutMs` (1 second to 1 hour, default
     * 10 minutes) passes, `signal` aborts or the plugin deactivates. A saved value is handed over
     * once and not kept. Rejects when the thread has no turn in progress.
     */
    readonly request: (input: {
      readonly threadId: string;
      /** The card's title, such as "Deploy token". */
      readonly label: string;
      /** What it is for and where to get it. */
      readonly reason: string;
      readonly placeholder?: string;
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    }) => Promise<
      | { readonly status: "saved"; readonly value: string }
      | { readonly status: "declined" | "cancelled" | "timed_out" }
    >;
  };
  readonly worktrees: {
    /**
     * The git worktrees of a project's repository: the main checkout, then the others by path,
     * leaving out any whose folder is gone. `branch` is null for a detached checkout. Rejects when
     * the project's folder is not in a git repository.
     */
    readonly list: (
      projectId: string,
    ) => Promise<ReadonlyArray<{ readonly path: string; readonly branch: string | null }>>;
  };
  readonly schedule: {
    /**
     * Calls `handler` every `everyMs` (at least 1000) until the plugin deactivates or the returned
     * function is called. Runs never overlap: the next wait starts when a run finishes.
     */
    readonly every: (everyMs: number, handler: () => void | Promise<void>) => () => void;
    /**
     * Calls `handler` at `time` (24-hour `HH:MM` in the server's local time) on each of
     * `weekdays` (0 is Sunday, 6 is Saturday; every day when omitted), until the plugin
     * deactivates or the returned function is called. Runs never overlap: a time that passes
     * while a run is still going is skipped.
     */
    readonly at: (
      when: { readonly time: string; readonly weekdays?: ReadonlyArray<number> },
      handler: () => void | Promise<void>,
    ) => () => void;
  };
  readonly turns: {
    /**
     * Runs each time a run ends, in order; a failed run the user retries arrives again when it ends.
     * The plugin's storage keeps the position, so runs that end while the plugin is off are
     * delivered when it starts again. The first registration starts from now. Register handlers in
     * the same order on every activation. Slash command replies are not runs and never arrive.
     */
    readonly afterRunCompleted: (
      handler: (run: PluginCompletedRun) => void | Promise<void>,
    ) => void;
    /**
     * Asked about each approval or question an agent raises until a hook answers, plugins in id
     * order. The user may answer first, which aborts `signal`. A hook slower than 10 seconds, one
     * that throws, or one whose answer does not fit or the server refuses is skipped; with no
     * answer the user decides.
     */
    readonly onRuntimeRequest: (
      handler: (
        request: PluginRuntimeRequest,
        context: { readonly signal: AbortSignal },
      ) => PluginRuntimeRequestAnswer | Promise<PluginRuntimeRequestAnswer>,
    ) => void;
    /**
     * Sees each message, edited queued message and delegated task prompt before it is sent, after
     * earlier hooks' changes, plugins in id order. A block stops the rest; a hook slower than 2
     * seconds or one that throws is skipped. Only a block applies to a slash command, a name T3,
     * the agent or a plugin lists. A task prompt's `threadId` is the task's new thread.
     */
    readonly beforeDispatch: (
      hook: (
        message: PluginOutgoingMessage,
      ) => PluginBeforeDispatchResult | Promise<PluginBeforeDispatchResult>,
    ) => void;
  };
  readonly slashCommands: {
    /**
     * Lists `/name` with every provider's commands; messages starting with it run `handler` instead
     * of being sent, unless a send hook blocks them, and throwing or 10 seconds blocks the message.
     * Names are lowercase letters, digits and `-`, not T3 Code's; a provider's own command of the
     * name wins, and of plugins sharing one, the id that sorts first.
     */
    readonly register: (
      command: {
        readonly name: string;
        readonly description?: string;
        /** Shown after the name while the user types arguments. */
        readonly inputHint?: string;
      },
      handler: (
        invocation: PluginSlashCommandInvocation,
        context: { readonly signal: AbortSignal },
      ) => PluginSlashCommandResult | Promise<PluginSlashCommandResult>,
    ) => void;
  };
  readonly textGeneration: {
    /**
     * Runs `prompt` on the text generation model chosen in T3 Code's settings and resolves with
     * its answer. Claude, Codex, OpenCode, Cursor, Grok, Pi and Antigravity models can answer; any
     * other rejects with code `TextGenerationUnsupportedError`. `signal` stops the wait.
     */
    readonly generate: (input: {
      readonly prompt: string;
      readonly signal?: AbortSignal;
    }) => Promise<string>;
    /**
     * Supplies `kind` of text before T3 Code generates it, until the plugin deactivates. T3 cleans
     * up the answer as it does model output. Plugins are asked in id order. Nothing, a wrong
     * shape, an error or 30 seconds without an answer leaves it to the next plugin, then to T3
     * Code's own generator.
     */
    readonly register: <K extends keyof PluginTextGenerationTasks>(
      kind: K,
      generate: (
        input: PluginTextGenerationTasks[K]["input"],
        context: { readonly signal: AbortSignal },
      ) =>
        | PluginTextGenerationTasks[K]["output"]
        | void
        | Promise<PluginTextGenerationTasks[K]["output"] | void>,
    ) => void;
  };
  readonly agents: {
    /**
     * Adds `text` (up to 4,000 bytes) to the instructions T3 Code gives Claude and Codex agents,
     * from their next turn or session until the plugin deactivates. A `skills/` folder of
     * `<name>/SKILL.md` skills beside the manifest reaches the same agents with no code.
     */
    readonly addInstructions: (text: string) => void;
  };
  readonly providers: {
    /** T3 Code's own Effect and provider modules, which a driver must build with. */
    readonly runtime: PluginProviderRuntime;
    /**
     * Adds a provider driver until the plugin deactivates. Its saved instances start, and so
     * does a default one unless `metadata.hasDefaultInstance` is false. Rejects a kind T3 Code
     * or another plugin already provides. Types are in `@t3tools/plugin-sdk/server/providers`.
     */
    readonly registerDriver: <Config>(driver: PluginProviderDriver<Config>) => Promise<void>;
    /**
     * Adds an ACP agent T3 Code runs by its command, with no Effect code: the shared ACP adapter
     * with the base capabilities, a settings form for the command and arguments, and no text
     * generation. Agents that need vendor hooks write a driver with `registerDriver`.
     */
    readonly registerAcpAgent: (agent: PluginAcpAgent) => Promise<void>;
  };
  readonly sourceControl: {
    readonly runtime: PluginSourceControlRuntime;
    /**
     * Adds a source control host until the plugin deactivates: its definition joins remote
     * recognition after the built-in hosts, and its driver is built once. Clients show it with the
     * generic host presentation. Rejects a kind T3 Code or another plugin already provides.
     */
    readonly registerDriver: (driver: PluginSourceControlDriver) => Promise<void>;
  };
  readonly mcp: {
    /** Offers a tool to agents in every thread until the plugin deactivates. */
    readonly registerTool: (tool: PluginMcpTool, handler: PluginMcpToolHandler) => void;
  };
  readonly http: {
    /**
     * Serves `method path` under `/api/plugins/<pluginId>` with the same sign-in as the rest of
     * `/api`: GET needs the `orchestration:read` scope, other methods `orchestration:operate`. A
     * path ending in `/*` answers every path below it; the longest match wins. Handlers never see
     * the `authorization`, `cookie` or `dpop` headers.
     */
    readonly route: (
      method: "GET" | "POST" | "PUT" | "DELETE",
      path: string,
      handler: PluginHttpHandler,
    ) => void;
  };
  readonly server: {
    readonly version: string;
    /** This environment's descriptor: id, label, platform and capabilities. */
    readonly environment: () => Promise<JsonObject>;
    /** The server settings with secrets redacted, as clients see them. */
    readonly settings: () => Promise<JsonObject>;
  };
}

export interface PluginDefinition {
  readonly activate: (api: PluginApi) => void | Promise<void>;
}

/** Types a server plugin. The CommonJS entry sets `module.exports` to the result. */
export const definePlugin = (definition: PluginDefinition): PluginDefinition => definition;
