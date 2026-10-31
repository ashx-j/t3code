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
  /** Every agent sees the tool; calling a `write` tool needs a session that may change things. */
  readonly access: PluginRpcAccess;
}

export type PluginMcpToolHandler = (
  input: JsonObject,
  context: { readonly signal: AbortSignal },
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
 * sender sees, and nothing sends the command as typed.
 */
export type PluginSlashCommandResult =
  | void
  | { readonly text: string }
  | { readonly block: string };

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
    readonly get: () => Promise<JsonObject>;
    /** Yields the settings, secret values included, after each change until deactivation. */
    readonly changes: () => AsyncIterable<JsonObject>;
  };
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
     * when omitted. Ends when the plugin deactivates or `signal` aborts. A consumer more than
     * 1024 events behind loses the oldest, so handle events quickly and store the last `sequence`
     * to resume from after a restart.
     */
    readonly stored: (options: {
      readonly types: ReadonlyArray<string>;
      readonly afterSequence?: number;
      readonly signal?: AbortSignal;
    }) => AsyncIterable<PluginStoredEvent>;
  };
  readonly threads: {
    readonly list: (options?: {
      readonly projectId?: string;
    }) => Promise<ReadonlyArray<JsonObject>>;
    readonly read: (threadId: string) => Promise<JsonObject>;
    /** Sends `text` to the thread's agent as the user would; resolves once accepted. */
    readonly sendMessage: (input: {
      readonly threadId: string;
      readonly text: string;
      readonly mode?: "auto" | "queue" | "steer";
    }) => Promise<void>;
    /**
     * Shows a note in the thread, after its latest finished run, starting with the plugin's name.
     * It starts no turn, isn't sent to the agent and doesn't mark the thread unread.
     */
    readonly notify: (input: {
      readonly threadId: string;
      readonly summary: string;
      readonly detail?: string;
      readonly outcome?: "completed" | "failed" | "updated";
    }) => Promise<void>;
    readonly interrupt: (threadId: string) => Promise<void>;
    readonly rename: (threadId: string, title: string) => Promise<void>;
  };
  readonly projects: {
    readonly list: () => Promise<ReadonlyArray<JsonObject>>;
    readonly read: (projectId: string) => Promise<JsonObject | undefined>;
  };
  readonly schedule: {
    /**
     * Calls `handler` every `everyMs` (at least 1000) until the plugin deactivates or the returned
     * function is called. Runs never overlap: the next wait starts when a run finishes.
     */
    readonly every: (everyMs: number, handler: () => void | Promise<void>) => () => void;
  };
  readonly turns: {
    /**
     * Runs once for each run that ends, in order. The plugin's storage keeps the position, so runs
     * that end while the plugin is off are delivered when it starts again. The first registration
     * starts from now. Register handlers in the same order on every activation.
     */
    readonly afterRunCompleted: (
      handler: (run: PluginCompletedRun) => void | Promise<void>,
    ) => void;
    /**
     * Asked about each approval or question an agent raises while the plugin is active, after
     * hooks registered before it, until one answers. The user sees the request meanwhile and may
     * answer first, which aborts `signal`. A hook slower than 10 seconds, one that throws or one
     * whose answer does not fit the request is skipped, and with no answer the user decides.
     */
    readonly onRuntimeRequest: (
      handler: (
        request: PluginRuntimeRequest,
        context: { readonly signal: AbortSignal },
      ) => PluginRuntimeRequestAnswer | Promise<PluginRuntimeRequestAnswer>,
    ) => void;
    /**
     * Sees each user or agent message before it is sent, except slash commands, after hooks
     * registered before it and with their changes. A block stops the rest. A hook slower than
     * 2 seconds or one that throws is skipped.
     */
    readonly beforeDispatch: (
      hook: (
        message: PluginOutgoingMessage,
      ) => PluginBeforeDispatchResult | Promise<PluginBeforeDispatchResult>,
    ) => void;
  };
  readonly slashCommands: {
    /**
     * Lists `/name` with every provider's commands; user and agent messages starting with it run
     * `handler` on the server instead of being sent. Throwing or taking over 10 seconds blocks the
     * message. Names are lowercase letters, digits and `-`, not T3 Code's or another plugin's.
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
  readonly mcp: {
    /** Offers a tool to agents in every thread until the plugin deactivates. */
    readonly registerTool: (tool: PluginMcpTool, handler: PluginMcpToolHandler) => void;
  };
  readonly http: {
    /**
     * Serves `method path` under `/api/plugins/<pluginId>` with the same sign-in as the rest of
     * `/api`. A path ending in `/*` answers every path below it; the longest match wins.
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
