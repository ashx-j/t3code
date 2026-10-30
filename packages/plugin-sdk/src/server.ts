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
    /** Yields the settings after each change until the plugin deactivates. */
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
    /** Sends `value` to every `plugins.subscribe` caller on `channel`. */
    readonly publish: (channel: string, value: JsonValue) => void;
  };
  /** Runs when the plugin is disabled or reloaded, or the server stops. */
  readonly onDeactivate: (cleanup: () => void | Promise<void>) => void;
}

export interface PluginDefinition {
  readonly activate: (api: PluginApi) => void | Promise<void>;
}

/** Types a server plugin. The CommonJS entry sets `module.exports` to the result. */
export const definePlugin = (definition: PluginDefinition): PluginDefinition => definition;
