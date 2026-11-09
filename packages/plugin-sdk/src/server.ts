import type { JsonObject, PluginRpcMap } from "./shared.ts";

/** `read` methods need the caller's `orchestration:read` scope, `write` methods `orchestration:operate`. */
export type PluginRpcAccess = "read" | "write";

export interface PluginRpcContext {
  /**
   * Aborts when the caller goes away, the plugin deactivates, or the handler has not answered
   * within 30 seconds, when the call fails.
   */
  readonly signal: AbortSignal;
  /**
   * What the caller's session may call: `write` if it may call `write` methods, else `read`. A
   * `read` method can use it to tell a read-only session, such as a guest's, from the owner's.
   */
  readonly access: PluginRpcAccess;
}

/** Answers one method of a `PluginRpcMap`. */
export type PluginRpcHandler<
  Method extends PluginRpcMap["methods"][string] = PluginRpcMap["methods"][string],
> = (
  input: Method["input"],
  context: PluginRpcContext,
) => Method["output"] | Promise<Method["output"]>;

export interface PluginLogger {
  readonly debug: (message: string, fields?: JsonObject) => void;
  readonly info: (message: string, fields?: JsonObject) => void;
  readonly warn: (message: string, fields?: JsonObject) => void;
  readonly error: (message: string, fields?: JsonObject) => void;
}

/**
 * What `activate` receives. Everything is scoped to one activation and released on deactivate.
 * `Rpc` types the methods and channels clients call.
 */
export interface PluginApi<Rpc extends PluginRpcMap = PluginRpcMap> {
  /**
   * This API's version, 1 so far. T3 raises it when the API gains a member, whose doc then names
   * the version that added it, so a plugin can check it before using a member an older T3 lacks.
   * To refuse older T3 releases outright, set `engines.t3` in the manifest.
   */
  readonly version: number;
  readonly id: string;
  readonly rootDir: string;
  readonly log: PluginLogger;
  readonly rpc: {
    /**
     * Answers `plugins.invoke` calls for `method` from clients. `input` has the type `Rpc` gives
     * it, but a client can send any JSON, so check input before acting on it.
     */
    readonly register: <Method extends Extract<keyof Rpc["methods"], string>>(
      method: Method,
      handler: PluginRpcHandler<Rpc["methods"][Method]>,
      options: { readonly access: PluginRpcAccess },
    ) => void;
    /** Sends `value` to every `plugins.subscribe` caller on `channel`. Any session that can read this environment may subscribe, so never publish secrets. */
    readonly publish: <Channel extends Extract<keyof Rpc["channels"], string>>(
      channel: Channel,
      value: Rpc["channels"][Channel],
    ) => void;
  };
  /** Runs when the plugin is disabled or reloaded, or the server stops; at once if that already happened. */
  readonly onDeactivate: (cleanup: () => void | Promise<void>) => void;
}

export interface PluginDefinition<Rpc extends PluginRpcMap = PluginRpcMap> {
  readonly activate: (api: PluginApi<Rpc>) => void | Promise<void>;
}

/**
 * Types a server plugin. The CommonJS entry sets `module.exports` to the result. Pass the plugin's
 * `PluginRpcMap`, as in `definePlugin<NotesRpc>({ ... })`, to type `api.rpc`.
 */
export const definePlugin = <Rpc extends PluginRpcMap = PluginRpcMap>(
  definition: PluginDefinition<Rpc>,
): PluginDefinition<Rpc> => definition;
