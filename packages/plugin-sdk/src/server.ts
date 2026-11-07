import type { JsonObject, JsonValue, PluginRpcMap } from "./shared.ts";

/** `read` methods need the caller's `orchestration:read` scope, `write` methods `orchestration:operate`. */
export type PluginRpcAccess = "read" | "write";

export interface PluginRpcContext {
  /** Aborts when the caller goes away or the plugin deactivates. */
  readonly signal: AbortSignal;
}

/** Answers one method of a `PluginRpcMap`. */
export type PluginRpcHandler<
  Method extends PluginRpcMap["methods"][string] = PluginRpcMap["methods"][string],
> = (
  input: Method["input"],
  context: PluginRpcContext,
) => Method["output"] | Promise<Method["output"]>;

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

export interface PluginHttpRequest {
  readonly method: string;
  /** The path after `/api/plugins/<pluginId>`, starting with `/`. */
  readonly path: string;
  /** A key repeated in the query string keeps its last value. */
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  /** The body decoded as UTF-8 text, so binary bodies arrive corrupted. */
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

/** One option a model takes, such as reasoning effort, by the id a thread's model sets it with. */
export interface PluginModelOption {
  readonly id: string;
  /** Every value the option accepts. */
  readonly values: ReadonlyArray<string | boolean>;
  /** What the model uses when a thread sets nothing. */
  readonly default?: string | boolean | undefined;
}

/** A provider instance from Settings → Providers, with the models it offers. */
export interface PluginProviderInstance {
  /** What `threads.create` takes as `model.instanceId`. */
  readonly instanceId: string;
  /** The kind of provider, such as `codex` or `claudeAgent`. */
  readonly driver: string;
  readonly displayName: string | null;
  readonly enabled: boolean;
  /** `ready`, `warning`, `error` or `disabled`. */
  readonly status: string;
  readonly models: ReadonlyArray<{
    /** What `threads.create` takes as `model.model`. */
    readonly id: string;
    readonly name: string;
    readonly options: ReadonlyArray<PluginModelOption>;
  }>;
}

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
  readonly storage: {
    readonly get: (key: string) => Promise<JsonValue | undefined>;
    readonly set: (key: string, value: JsonValue) => Promise<void>;
    readonly delete: (key: string) => Promise<void>;
    readonly list: (prefix?: string) => Promise<ReadonlyArray<string>>;
  };
  readonly rpc: {
    /**
     * Answers `plugins.invoke` calls for `method` from clients. `input` has the type `Rpc` gives
     * it, but a client can call any method with any JSON, so check input before acting on it.
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
     * Sends `text` to the thread's agent as a message from an agent, not the user. Resolves once
     * accepted.
     */
    readonly sendMessage: (input: {
      readonly threadId: string;
      readonly text: string;
      readonly mode?: "auto" | "queue" | "steer";
      /**
       * Once a send with this key is accepted, sending with it again, also after a restart, sends
       * nothing and resolves, even if `text` changed. Up to 256 characters, apart from `create`'s.
       */
      readonly idempotencyKey?: string;
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
      readonly model?: {
        readonly instanceId: string;
        readonly model: string;
        /**
         * Such as `[{ id: "reasoningEffort", value: "high" }]`, from `providers.list`. An option
         * the model doesn't take, or a value it doesn't accept, rejects with code
         * `PluginThreadModelOptionsError` and a message listing what it takes.
         */
        readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
      };
      readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
      readonly interactionMode?: "default" | "plan";
      readonly workspace?:
        | { readonly type: "root"; readonly branch?: string }
        | { readonly type: "worktree"; readonly baseRef: string; readonly branch?: string }
        | { readonly type: "existing_worktree"; readonly worktreePath: string };
      /**
       * Once a create with this key is accepted, creating with it again, also after a restart,
       * starts no new thread or turn and resolves with the same `threadId`, even if other fields
       * changed. Up to 256 characters.
       */
      readonly idempotencyKey?: string;
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
  readonly providers: {
    /**
     * The provider instances clients list, with each model and the options it takes. Read it
     * for the ids and values `threads.create` accepts, since they differ per provider.
     */
    readonly list: () => Promise<ReadonlyArray<PluginProviderInstance>>;
  };
  readonly http: {
    /**
     * Serves `method path` under `/api/plugins/<pluginId>` with `/api`'s sign-in: GET needs
     * `orchestration:read`, so read-only sessions reach it and it must not change anything; other
     * methods need `orchestration:operate`. A path ending in `/*` answers every path below it, the
     * longest match winning. Handlers never see the `authorization`, `cookie` or `dpop` headers.
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
