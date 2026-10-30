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
  readonly text: string;
  readonly createdBy: "user" | "agent";
}

/** Nothing leaves the message as it is; `appendText` adds a paragraph; `veto` stops the send. */
export type PluginBeforeDispatchResult =
  | void
  | { readonly appendText: string }
  | { readonly veto: string };

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
     * Stored orchestration events of `types`, after `afterSequence`, or from now when omitted.
     * Ends when the plugin deactivates or `signal` aborts. A consumer more than 1024 events
     * behind loses the oldest; compare `sequence` and resume with `afterSequence`.
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
    /** Sees each user or agent message before it is sent; a hook slower than 2 seconds or one that throws is skipped. */
    readonly beforeDispatch: (
      hook: (
        message: PluginOutgoingMessage,
      ) => PluginBeforeDispatchResult | Promise<PluginBeforeDispatchResult>,
    ) => void;
  };
  readonly mcp: {
    /** Offers a tool to agents in every thread until the plugin deactivates. */
    readonly registerTool: (tool: PluginMcpTool, handler: PluginMcpToolHandler) => void;
  };
  readonly http: {
    /** Serves `method path` under `/api/plugins/<pluginId>` with the same sign-in as the rest of `/api`. */
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
