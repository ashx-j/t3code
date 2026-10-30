// @effect-diagnostics nodeBuiltinImport:off - plugins load through Node's CommonJS loader, which
// the FileSystem service does not wrap.
import * as NodeModule from "node:module";

import {
  AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  type PluginFailure,
  PluginId,
  type PluginManifest,
  type PluginState,
  type PluginStatus,
} from "@t3tools/contracts";
import type { PluginDefinition } from "@t3tools/plugin-sdk/server";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import {
  makePluginActivation,
  makePluginApi,
  type PluginActivation,
  type PluginApiServices,
  type PluginPublication,
} from "./PluginApi.ts";
import { discoverPlugins, type DiscoveredPlugin } from "./pluginDiscovery.ts";
import * as PluginHooks from "./PluginHooks.ts";
import * as PluginHttpRoutes from "./PluginHttpRoutes.ts";
import * as PluginMcpTools from "./PluginMcpTools.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";

const MAX_FAILURE_MESSAGE_CHARS = 500;
const WEB_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
// Plugin code that never settles must not keep a plugin loading, or Disable and Reload waiting,
// forever. The cleanup deadline covers all of a plugin's cleanups together.
const ACTIVATE_DEADLINE = Duration.seconds(30);
const CLEANUP_DEADLINE = Duration.seconds(5);
const PUBLICATION_BUFFER = 64;

export class PluginNotFoundError extends Schema.TaggedError<PluginNotFoundError>()(
  "PluginNotFoundError",
  { pluginId: PluginId },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} is not installed.`;
  }
}

export class PluginNotActiveError extends Schema.TaggedError<PluginNotActiveError>()(
  "PluginNotActiveError",
  { pluginId: PluginId, status: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} is ${this.status}.`;
  }
}

export class PluginMethodNotFoundError extends Schema.TaggedError<PluginMethodNotFoundError>()(
  "PluginMethodNotFoundError",
  { pluginId: PluginId, method: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} has no method ${this.method}.`;
  }
}

export class PluginAccessDeniedError extends Schema.TaggedError<PluginAccessDeniedError>()(
  "PluginAccessDeniedError",
  { pluginId: PluginId, method: Schema.String, requiredScope: AuthEnvironmentScope },
) {
  override get message(): string {
    return `Calling ${this.method} on plugin ${this.pluginId} needs the ${this.requiredScope} scope.`;
  }
}
export const isPluginAccessDeniedError = Schema.is(PluginAccessDeniedError);

// `reason` is the plugin's own error text, bounded. Plugins are trusted code, and their UI needs
// to show why its own call failed.
export class PluginHandlerError extends Schema.TaggedError<PluginHandlerError>()(
  "PluginHandlerError",
  { pluginId: PluginId, method: Schema.String, reason: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} failed in ${this.method}: ${this.reason}`;
  }
}

/** Plugin code threw or rejected while loading, activating, or cleaning up. */
class PluginCodeError extends Schema.TaggedError<PluginCodeError>()("PluginCodeError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return errorText(this.cause);
  }
}

export class PluginConfigError extends Schema.TaggedError<PluginConfigError>()(
  "PluginConfigError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not update ${this.path}. If it was edited by hand, fix or delete it.`;
  }
}

export class PluginHost extends Context.Service<
  PluginHost,
  {
    readonly list: Effect.Effect<ReadonlyArray<PluginState>>;
    /** The current list, then the whole list after every change. */
    readonly streamStates: Stream.Stream<ReadonlyArray<PluginState>>;
    /** Persists the flag, then waits for activation or deactivation to finish. */
    readonly setEnabled: (
      pluginId: PluginId,
      enabled: boolean,
    ) => Effect.Effect<PluginState, PluginNotFoundError | PluginConfigError>;
    /** Rescans the plugin folders and restarts this plugin with fresh code. */
    readonly reload: (
      pluginId: PluginId,
    ) => Effect.Effect<PluginState, PluginNotFoundError | PluginConfigError>;
    readonly getSettings: (
      pluginId: PluginId,
    ) => Effect.Effect<
      Schema.JsonObject,
      PluginNotFoundError | PluginNotActiveError | PluginSettingsError
    >;
    readonly updateSettings: (
      pluginId: PluginId,
      patch: Schema.JsonObject,
    ) => Effect.Effect<
      Schema.JsonObject,
      PluginNotFoundError | PluginNotActiveError | PluginSettingsError
    >;
    /** `scopes` are the caller's; methods the plugin registered as writes need the operate scope. */
    readonly invoke: (input: {
      readonly pluginId: PluginId;
      readonly method: string;
      readonly input: Schema.Json | undefined;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    }) => Effect.Effect<
      Schema.Json,
      | PluginNotFoundError
      | PluginNotActiveError
      | PluginMethodNotFoundError
      | PluginAccessDeniedError
      | PluginHandlerError
    >;
    /** Values the plugin publishes on `channel` until it deactivates. */
    readonly subscribe: (input: {
      readonly pluginId: PluginId;
      readonly channel: string;
    }) => Stream.Stream<Schema.Json, PluginNotFoundError | PluginNotActiveError>;
  }
>()("t3/plugins/PluginHost") {}

type PluginSettingsError =
  | PluginSettingsStore.PluginSettingsPersistenceError
  | PluginSettingsStore.PluginSettingsSchemaError
  | PluginSettingsStore.PluginSettingsValidationError;

// Unknown keys survive a rewrite, so a newer build's additions outlive a toggle by an older one.
const PluginsConfigFile = Schema.StructWithRest(
  Schema.Struct({
    enabled: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
    devPaths: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
type PluginsConfigFile = typeof PluginsConfigFile.Type;
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginsConfigFile));
const encodeConfig = Schema.encodeEffect(fromJsonStringPretty(PluginsConfigFile));
const isJson = Schema.is(Schema.Json);

interface PluginRecord {
  readonly plugin: DiscoveredPlugin;
  readonly status: PluginStatus;
  readonly failure?: PluginFailure;
  readonly activation?: PluginActivation;
}

const errorText = (cause: unknown) => {
  let text = "Unknown error";
  try {
    text =
      cause instanceof Error && typeof cause.message === "string" ? cause.message : String(cause);
  } catch {
    // Plugin code can throw values whose conversion to a string throws again.
  }
  return text.slice(0, MAX_FAILURE_MESSAGE_CHARS);
};

const manifestOf = (plugin: DiscoveredPlugin): PluginManifest | undefined =>
  "manifest" in plugin ? plugin.manifest : undefined;

const toState = (record: PluginRecord, enabled: boolean): PluginState => {
  const manifest = manifestOf(record.plugin);
  return {
    id: record.plugin.id,
    name: manifest?.name ?? record.plugin.id,
    ...(manifest === undefined
      ? {}
      : {
          version: manifest.version,
          ...(manifest.description === undefined ? {} : { description: manifest.description }),
          ...(manifest.settingsSchema === undefined
            ? {}
            : { settingsSchema: manifest.settingsSchema }),
          ...(manifest.contributes === undefined ? {} : { contributes: manifest.contributes }),
        }),
    permissions: manifest?.permissions ?? [],
    source: record.plugin.source,
    enabled,
    status: record.status,
    ...(record.failure === undefined ? {} : { failure: record.failure }),
    hasServer: manifest?.server !== undefined,
    hasWeb: manifest?.web !== undefined,
  };
};

// One loader for the packaged single executable and plain Node: a require created from an
// absolute path loads files from disk in both, and plugin code resolves its own imports.
const requireFromDisk = NodeModule.createRequire(process.execPath);

const isPluginDefinition = (value: unknown): value is PluginDefinition =>
  typeof value === "object" &&
  value !== null &&
  "activate" in value &&
  typeof value.activate === "function";

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<never>();
  const services: PluginApiServices = {
    version: packageJson.version,
    settings: yield* PluginSettingsStore.PluginSettingsStore,
    storage: yield* PluginStorage.PluginStorage,
    orchestrator: yield* Orchestrator.OrchestratorV2,
    eventStore: yield* OrchestrationEventStore.OrchestrationEventStore,
    threads: yield* ThreadManagementService.ThreadManagementService,
    projects: yield* ProjectStore.ProjectStoreV2,
    hooks: yield* PluginHooks.PluginHooks,
    mcpTools: yield* PluginMcpTools.PluginMcpTools,
    httpRoutes: yield* PluginHttpRoutes.PluginHttpRoutes,
    environment: yield* ServerEnvironment.ServerEnvironment,
    serverSettings: yield* ServerSettings.ServerSettingsService,
    crypto: yield* Crypto.Crypto,
  };
  const settingsStore = services.settings;

  const pluginsDir = path.join(config.stateDir, "plugins");
  const configPath = path.join(config.stateDir, "plugins.json");

  const records = yield* Ref.make<ReadonlyArray<PluginRecord>>([]);
  const pluginsConfig = yield* Ref.make<PluginsConfigFile>({});
  const changes = yield* PubSub.sliding<ReadonlyArray<PluginState>>(1);
  const lifecycle = yield* Semaphore.make(1);
  const publishLock = yield* Semaphore.make(1);
  const activations = yield* FiberMap.make<PluginId>();
  const hostScope = yield* Effect.scope;

  const currentStates = Effect.gen(function* () {
    const enabled = (yield* Ref.get(pluginsConfig)).enabled ?? {};
    return (yield* Ref.get(records)).map((record) =>
      toState(record, enabled[record.plugin.id] === true),
    );
  });
  // Reading and publishing under one lock, so a slower fiber cannot publish an older list last.
  const publishStates = publishLock.withPermits(1)(
    currentStates.pipe(
      Effect.tap((states) => services.mcpTools.setInstalledPlugins(states)),
      Effect.flatMap((states) => PubSub.publish(changes, states)),
      Effect.asVoid,
    ),
  );
  const findRecord = (pluginId: string) =>
    Ref.get(records).pipe(Effect.map((all) => all.find((record) => record.plugin.id === pluginId)));
  const stateOf = (pluginId: PluginId) =>
    currentStates.pipe(
      Effect.flatMap((states) => {
        const state = states.find((candidate) => candidate.id === pluginId);
        return state === undefined
          ? Effect.fail(new PluginNotFoundError({ pluginId }))
          : Effect.succeed(state);
      }),
    );
  // Records are replaced by id; a shadowed duplicate keeps its own failure entry.
  const setRecord = (pluginId: PluginId, update: Omit<PluginRecord, "plugin">) =>
    Ref.update(records, (all) => {
      const index = all.findIndex((record) => record.plugin.id === pluginId);
      if (index === -1) return all;
      const next = [...all];
      next[index] = { plugin: all[index]!.plugin, ...update };
      return next;
    }).pipe(Effect.andThen(publishStates));

  const readConfig = Effect.gen(function* () {
    const exists = yield* fs.exists(configPath);
    if (!exists) {
      const emptyConfig: PluginsConfigFile = {};
      return emptyConfig;
    }
    const raw = yield* fs.readFileString(configPath);
    return yield* decodeConfig(raw);
  }).pipe(Effect.mapError((cause) => new PluginConfigError({ path: configPath, cause })));

  const writeEnabled = Effect.fnUntraced(function* (pluginId: PluginId, enabled: boolean) {
    const current = yield* readConfig;
    const next: PluginsConfigFile = {
      ...current,
      enabled: { ...current.enabled, [pluginId]: enabled },
    };
    const contents = yield* encodeConfig(next).pipe(
      Effect.mapError((cause) => new PluginConfigError({ path: configPath, cause })),
    );
    yield* writeFileStringAtomically({ filePath: configPath, contents: `${contents}\n` }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new PluginConfigError({ path: configPath, cause })),
    );
    yield* Ref.set(pluginsConfig, next);
  });

  const runCleanup = (pluginId: PluginId, cleanup: () => void | Promise<void>) =>
    Effect.tryPromise({
      try: () => Promise.resolve().then(cleanup),
      catch: (cause) => new PluginCodeError({ cause }),
    }).pipe(
      Effect.catchTags({
        PluginCodeError: (error) =>
          Effect.logWarning("plugin cleanup failed", { pluginId, reason: error.message }),
      }),
    );

  // Aborts first so handlers and iterators stop, then runs cleanups newest first. Teardown also
  // runs as an interrupt finalizer, so the deadline gets an interruptible region to cut.
  const teardown = Effect.fnUntraced(function* (pluginId: PluginId, activation: PluginActivation) {
    activation.controller.abort();
    const timedOut = yield* Effect.forEach(
      activation.cleanups.toReversed(),
      (cleanup) => runCleanup(pluginId, cleanup),
      { discard: true },
    ).pipe(Effect.interruptible, Effect.timeoutOption(CLEANUP_DEADLINE), Effect.map(Option.isNone));
    if (timedOut) yield* Effect.logWarning("plugin cleanup timed out", { pluginId });
    activation.ended.abort();
    yield* PubSub.shutdown(activation.publications);
  });

  const loadDefinition = (plugin: DiscoveredPlugin, entry: string) =>
    Effect.try({
      try: () => {
        const entryPath = path.join(plugin.rootDir, entry);
        // Drop every cached module under the plugin so reload runs current code. Node still
        // holds the old instances until the server restarts.
        const prefix = `${plugin.rootDir}${path.sep}`;
        for (const cached of Object.keys(requireFromDisk.cache)) {
          if (cached.startsWith(prefix)) Reflect.deleteProperty(requireFromDisk.cache, cached);
        }
        const exported: unknown = requireFromDisk(entryPath);
        // Bundlers that compile `export default` to CommonJS put the definition on `default`.
        const definition =
          typeof exported === "object" && exported !== null && "default" in exported
            ? exported.default
            : exported;
        if (!isPluginDefinition(definition)) {
          throw new Error("The server entry does not export a plugin with an activate function.");
        }
        return definition;
      },
      catch: (cause) => new PluginCodeError({ cause }),
    });

  // Web files are served from the plugin's real folder; a path or symlink out of `within` is refused.
  const readWebFile = Effect.fnUntraced(function* (within: string, file: string) {
    const resolved = yield* fs.realPath(file).pipe(Effect.option);
    if (Option.isNone(resolved)) return { status: 404, body: "Not found." };
    const real = resolved.value;
    if (!real.startsWith(`${within}${path.sep}`)) {
      return yield* new PluginCodeError({ cause: "The file resolves outside the plugin folder." });
    }
    return {
      status: 200,
      headers: {
        "content-type":
          WEB_CONTENT_TYPES[path.extname(real).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
      },
      body: yield* fs.readFile(real),
    };
  });

  const serveWebFiles = Effect.fnUntraced(function* (plugin: DiscoveredPlugin, entry: string) {
    const register = (routePath: string, read: (requestPath: string) => string, within: string) =>
      services.httpRoutes
        .register({
          pluginId: plugin.id,
          method: "GET",
          path: routePath,
          handler: (request) =>
            Effect.runPromiseWith(context)(readWebFile(within, read(request.path))),
        })
        .pipe(Effect.orDie);
    yield* register("/web.js", () => path.join(plugin.rootDir, entry), plugin.rootDir);
    const assetsDir = yield* fs.realPath(path.join(plugin.rootDir, "assets")).pipe(Effect.option);
    if (Option.isSome(assetsDir)) {
      yield* register(
        "/assets/*",
        (requestPath) =>
          path.join(assetsDir.value, decodeURIComponent(requestPath.slice("/assets/".length))),
        assetsDir.value,
      );
    }
  });

  const activatePlugin = Effect.fnUntraced(function* (plugin: DiscoveredPlugin) {
    const manifest = manifestOf(plugin);
    if (manifest === undefined) return;
    if (!satisfiesSemverRange(packageJson.version, manifest.engines.t3)) {
      return yield* setRecord(plugin.id, {
        status: "failed",
        failure: {
          stage: "compatibility",
          message: `Needs T3 Code ${manifest.engines.t3}; this server is ${packageJson.version}.`,
        },
      });
    }
    if (manifest.web !== undefined) yield* serveWebFiles(plugin, manifest.web);
    if (manifest.server === undefined) {
      return yield* setRecord(plugin.id, { status: "active" });
    }
    yield* setRecord(plugin.id, { status: "loading" });
    const definition = yield* Effect.exit(loadDefinition(plugin, manifest.server));
    if (definition._tag === "Failure") {
      return yield* setRecord(plugin.id, {
        status: "failed",
        failure: { stage: "load", message: errorText(Cause.squash(definition.cause)) },
      });
    }
    const activation = makePluginActivation(
      yield* PubSub.sliding<PluginPublication>(PUBLICATION_BUFFER),
    );
    const api = makePluginApi({
      id: plugin.id,
      rootDir: plugin.rootDir,
      settingsSchema: manifest.settingsSchema,
      activation,
      context,
      services,
    });
    const activated = yield* Effect.tryPromise({
      try: () => Promise.resolve().then(() => definition.value.activate(api)),
      catch: (cause) => new PluginCodeError({ cause }),
    }).pipe(
      Effect.timeoutOption(ACTIVATE_DEADLINE),
      Effect.onInterrupt(() => teardown(plugin.id, activation)),
      Effect.exit,
    );
    if (activated._tag === "Failure" || Option.isNone(activated.value)) {
      yield* teardown(plugin.id, activation);
      return yield* setRecord(plugin.id, {
        status: "failed",
        failure: {
          stage: "activate",
          message:
            activated._tag === "Failure"
              ? errorText(Cause.squash(activated.cause))
              : `activate did not finish within ${Duration.toSeconds(ACTIVATE_DEADLINE)} seconds.`,
        },
      });
    }
    yield* setRecord(plugin.id, { status: "active", activation });
    yield* Effect.logInfo("plugin activated", { pluginId: plugin.id });
  });

  /**
   * Interrupts a pending activation, then tears down a finished one. The record stops routing
   * calls before cleanups run; the caller sets the plugin's next status.
   */
  const stopPlugin = Effect.fnUntraced(function* (pluginId: PluginId) {
    yield* FiberMap.remove(activations, pluginId);
    // Web-only plugins have no activation but still serve their bundle.
    yield* services.httpRoutes.unregisterPlugin(pluginId);
    const record = yield* findRecord(pluginId);
    if (record?.activation === undefined) return;
    yield* setRecord(pluginId, { status: "disabled" });
    yield* teardown(pluginId, record.activation);
  });

  const startPlugin = (plugin: DiscoveredPlugin) =>
    FiberMap.run(activations, plugin.id, activatePlugin(plugin));

  const initialRecord = (plugin: DiscoveredPlugin, enabled: boolean): PluginRecord =>
    "failure" in plugin
      ? { plugin, status: "failed", failure: plugin.failure }
      : { plugin, status: enabled ? "loading" : "disabled" };

  // Startup tolerates an unreadable plugins.json; an explicit reload reports it instead.
  const discover = Effect.fnUntraced(function* (lenient: boolean) {
    const emptyConfig: PluginsConfigFile = {};
    const current = lenient
      ? yield* readConfig.pipe(
          Effect.catchTags({
            PluginConfigError: (error) =>
              Effect.logWarning("ignoring unreadable plugins.json", { path: error.path }).pipe(
                Effect.as(emptyConfig),
              ),
          }),
        )
      : yield* readConfig;
    yield* Ref.set(pluginsConfig, current);
    const plugins = yield* discoverPlugins({ pluginsDir, devPaths: current.devPaths ?? [] }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    return { plugins, enabled: current.enabled ?? {} };
  });

  const startup = lifecycle.withPermits(1)(
    Effect.gen(function* () {
      const { plugins, enabled } = yield* discover(true);
      yield* Ref.set(
        records,
        plugins.map((plugin) => initialRecord(plugin, enabled[plugin.id] === true)),
      );
      yield* publishStates;
      // Each plugin activates in its own fiber, so a slow one delays nobody else.
      for (const plugin of plugins) {
        if (enabled[plugin.id] === true && "manifest" in plugin) yield* startPlugin(plugin);
      }
    }),
  );

  // Lifecycle changes run in the host's scope, so a caller that disconnects only stops waiting
  // and never leaves a plugin half torn down.
  const runLifecycle = <A, E>(body: Effect.Effect<A, E>) =>
    lifecycle.withPermits(1)(body).pipe(Effect.forkIn(hostScope), Effect.flatMap(Fiber.join));

  const awaitActivation = (pluginId: PluginId) =>
    FiberMap.get(activations, pluginId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (fiber) => Effect.asVoid(Fiber.await(fiber)),
        }),
      ),
    );

  const setEnabled: PluginHost["Service"]["setEnabled"] = Effect.fn("PluginHost.setEnabled")(
    function* (pluginId, enabled) {
      yield* runLifecycle(
        Effect.gen(function* () {
          const record = yield* findRecord(pluginId);
          if (record === undefined) return yield* new PluginNotFoundError({ pluginId });
          yield* writeEnabled(pluginId, enabled);
          if ("failure" in record.plugin) return yield* publishStates;
          // Enabling a plugin that is running or starting keeps it; a failed one is retried.
          if (enabled && (record.status === "active" || record.status === "loading")) {
            return yield* publishStates;
          }
          yield* stopPlugin(pluginId);
          if (enabled) {
            yield* startPlugin(record.plugin);
          } else {
            yield* setRecord(pluginId, { status: "disabled" });
          }
        }),
      );
      yield* awaitActivation(pluginId);
      return yield* stateOf(pluginId);
    },
  );

  const reload: PluginHost["Service"]["reload"] = Effect.fn("PluginHost.reload")(
    function* (pluginId) {
      yield* runLifecycle(
        Effect.gen(function* () {
          const { plugins, enabled } = yield* discover(false);
          const fresh = plugins.find((plugin) => plugin.id === pluginId);
          yield* stopPlugin(pluginId);
          // Plugins whose folders are gone are stopped too, or they would keep running unlisted.
          const vanished = (yield* Ref.get(records)).filter(
            (record) => !plugins.some((plugin) => plugin.id === record.plugin.id),
          );
          for (const record of vanished) yield* stopPlugin(record.plugin.id);
          const known = yield* Ref.get(records);
          const kept = known.filter(
            (record) =>
              record.plugin.id !== pluginId && plugins.some((p) => p.id === record.plugin.id),
          );
          const added = plugins.filter(
            (plugin) =>
              plugin.id === pluginId || !known.some((record) => record.plugin.id === plugin.id),
          );
          yield* Ref.set(records, [
            ...kept,
            ...added.map((plugin) => initialRecord(plugin, enabled[plugin.id] === true)),
          ]);
          yield* publishStates;
          if (fresh === undefined) return yield* new PluginNotFoundError({ pluginId });
          for (const plugin of added) {
            if (enabled[plugin.id] === true && "manifest" in plugin) yield* startPlugin(plugin);
          }
        }),
      );
      yield* awaitActivation(pluginId);
      return yield* stateOf(pluginId);
    },
  );

  const manifestFor = Effect.fnUntraced(function* (pluginId: PluginId) {
    const record = yield* findRecord(pluginId);
    if (record === undefined) return yield* new PluginNotFoundError({ pluginId });
    const manifest = manifestOf(record.plugin);
    if (manifest === undefined) {
      return yield* new PluginNotActiveError({ pluginId, status: record.status });
    }
    return manifest;
  });

  const activeRecord = Effect.fnUntraced(function* (pluginId: PluginId) {
    const record = yield* findRecord(pluginId);
    if (record === undefined) return yield* new PluginNotFoundError({ pluginId });
    if (record.status !== "active" || record.activation === undefined) {
      return yield* new PluginNotActiveError({ pluginId, status: record.status });
    }
    return record.activation;
  });

  yield* forkParked(startup);
  yield* Effect.addFinalizer(() =>
    Ref.get(records).pipe(
      Effect.flatMap((all) =>
        Effect.forEach(all, (record) =>
          record.activation === undefined
            ? Effect.void
            : teardown(record.plugin.id, record.activation),
        ),
      ),
    ),
  );

  return PluginHost.of({
    list: currentStates,
    streamStates: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const snapshot = yield* currentStates;
        return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription));
      }),
    ),
    setEnabled,
    reload,
    getSettings: Effect.fn("PluginHost.getSettings")(function* (pluginId) {
      const manifest = yield* manifestFor(pluginId);
      return yield* settingsStore.getForClient(pluginId, manifest.settingsSchema);
    }),
    updateSettings: Effect.fn("PluginHost.updateSettings")(function* (pluginId, patch) {
      const manifest = yield* manifestFor(pluginId);
      return yield* settingsStore.update(pluginId, manifest.settingsSchema, patch);
    }),
    invoke: Effect.fn("PluginHost.invoke")(function* (request) {
      yield* Effect.annotateCurrentSpan({
        "plugin.id": request.pluginId,
        "plugin.method": request.method,
      });
      const activation = yield* activeRecord(request.pluginId);
      const registered = activation.methods.get(request.method);
      if (registered === undefined) {
        return yield* new PluginMethodNotFoundError({
          pluginId: request.pluginId,
          method: request.method,
        });
      }
      if (
        registered.access === "write" &&
        !request.scopes.includes(AuthOrchestrationOperateScope)
      ) {
        return yield* new PluginAccessDeniedError({
          pluginId: request.pluginId,
          method: request.method,
          requiredScope: AuthOrchestrationOperateScope,
        });
      }
      const handlerError = (cause: unknown) =>
        new PluginHandlerError({
          pluginId: request.pluginId,
          method: request.method,
          reason: errorText(cause),
          cause,
        });
      const deactivated = activation.controller.signal;
      const output = yield* Effect.raceFirst(
        Effect.tryPromise({
          try: (signal) =>
            Promise.resolve().then(() =>
              registered.handler(request.input, {
                signal: AbortSignal.any([signal, deactivated]),
              }),
            ),
          catch: handlerError,
        }),
        // A handler that ignores its abort signal must not hold the call open after disable.
        Effect.callback<never, PluginNotActiveError>((resume) => {
          const onAbort = () =>
            resume(
              Effect.fail(
                new PluginNotActiveError({ pluginId: request.pluginId, status: "disabled" }),
              ),
            );
          if (deactivated.aborted) return onAbort();
          deactivated.addEventListener("abort", onAbort, { once: true });
          return Effect.sync(() => deactivated.removeEventListener("abort", onAbort));
        }),
      );
      if (output === undefined) return null;
      if (!isJson(output)) {
        return yield* handlerError(new TypeError("The method returned a value that is not JSON."));
      }
      return output;
    }),
    subscribe: (request) =>
      Stream.unwrap(
        activeRecord(request.pluginId).pipe(
          Effect.map((activation) =>
            Stream.fromPubSub(activation.publications).pipe(
              Stream.filter((publication) => publication.channel === request.channel),
              Stream.map((publication) => publication.value),
            ),
          ),
        ),
      ),
  });
});

export const layer = Layer.effect(PluginHost, make);
