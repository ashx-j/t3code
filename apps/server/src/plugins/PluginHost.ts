// @effect-diagnostics nodeBuiltinImport:off - plugins load through Node's CommonJS loader, which
// the FileSystem service does not wrap.
import * as NodeModule from "node:module";

import {
  AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type PluginFailure,
  PluginId,
  PluginManifest,
  PluginInstallSource,
  type PluginState,
  type PluginStatus,
} from "@t3tools/contracts";
import type { PluginDefinition } from "@t3tools/plugin-sdk/server";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
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
import { HttpClient } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProcessRunner from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";
import {
  makePluginActivation,
  makePluginApi,
  type PluginActivation,
  type PluginApiServices,
  type PluginPublication,
} from "./PluginApi.ts";
import { discoverPlugins, type DiscoveredPlugin } from "./pluginDiscovery.ts";
import { fetchNpmPackage } from "./pluginNpm.ts";
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

// `reason` is shown to the user as is, so it says what to fix.
export class PluginInstallError extends Schema.TaggedError<PluginInstallError>()(
  "PluginInstallError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
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
    /**
     * Copies or clones a plugin into the plugins folder, enables it and starts it. It is staged
     * first and swapped in with a rename, so a failed install leaves the previous version.
     */
    readonly install: (
      source: PluginInstallSource,
    ) => Effect.Effect<PluginState, PluginInstallError | PluginNotFoundError | PluginConfigError>;
    /** Installs a plugin again from the source it was installed from. */
    readonly update: (
      pluginId: PluginId,
    ) => Effect.Effect<PluginState, PluginInstallError | PluginNotFoundError | PluginConfigError>;
    /** Stops an installed plugin and deletes its folder; `removeData` also deletes its settings. */
    readonly uninstall: (
      pluginId: PluginId,
      removeData: boolean,
    ) => Effect.Effect<void, PluginInstallError | PluginNotFoundError | PluginConfigError>;
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
    /** Where each plugin installed through `install` came from, so `update` can fetch it again. */
    sources: Schema.optionalKey(Schema.Record(Schema.String, PluginInstallSource)),
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
  readonly revision?: number;
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

// Git URLs can carry credentials, and plugin state reaches read-only clients and agents.
const shownSource = (source: PluginInstallSource): PluginInstallSource => {
  if (source.type !== "git" || !URL.canParse(source.url)) return source;
  const url = new URL(source.url);
  if (url.username === "" && url.password === "") return source;
  url.username = "***";
  url.password = "";
  return { ...source, url: url.toString() };
};

const toState = (
  record: PluginRecord,
  enabled: boolean,
  installSource: PluginInstallSource | undefined,
): PluginState => {
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
    ...(record.revision === undefined ? {} : { revision: record.revision }),
    ...(installSource === undefined || record.plugin.source !== "installed"
      ? {}
      : { installSource: shownSource(installSource) }),
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
  const environmentThemes = yield* EnvironmentTheme.EnvironmentThemeService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const http = yield* HttpClient.HttpClient;

  const pluginsDir = path.join(config.stateDir, "plugins");
  const configPath = path.join(config.stateDir, "plugins.json");

  const records = yield* Ref.make<ReadonlyArray<PluginRecord>>([]);
  // Changes on every start, so a client can tell a restarted plugin from one that kept running.
  // Seeded with the clock so a restarted server never repeats a revision a client already saw.
  let revision = yield* Clock.currentTimeMillis;
  const nextRevision = () => ++revision;
  const pluginsConfig = yield* Ref.make<PluginsConfigFile>({});
  const changes = yield* PubSub.sliding<ReadonlyArray<PluginState>>(1);
  const lifecycle = yield* Semaphore.make(1);
  const publishLock = yield* Semaphore.make(1);
  const activations = yield* FiberMap.make<PluginId>();
  const hostScope = yield* Effect.scope;

  const currentStates = Effect.gen(function* () {
    const config = yield* Ref.get(pluginsConfig);
    const enabled = config.enabled ?? {};
    return (yield* Ref.get(records)).map((record) =>
      toState(record, enabled[record.plugin.id] === true, config.sources?.[record.plugin.id]),
    );
  });
  // Reading and publishing under one lock, so a slower fiber cannot publish an older list last.
  const publishStates = publishLock.withPermits(1)(
    Effect.gen(function* () {
      const all = yield* Ref.get(records);
      const states = yield* currentStates;
      yield* services.mcpTools.setInstalledPlugins(states);
      yield* environmentThemes.setPluginThemeDirectories(
        all.flatMap((record, index) =>
          states[index]?.status === "active" ? [path.join(record.plugin.rootDir, "themes")] : [],
        ),
      );
      yield* PubSub.publish(changes, states);
    }),
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

  const writeConfig = Effect.fnUntraced(function* (
    update: (current: PluginsConfigFile) => PluginsConfigFile,
  ) {
    const next = update(yield* readConfig);
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

  const writeEnabled = (pluginId: PluginId, enabled: boolean) =>
    writeConfig((current) => ({
      ...current,
      enabled: { ...current.enabled, [pluginId]: enabled },
    }));

  const removeFromConfig = (pluginId: PluginId) =>
    writeConfig((current) => {
      const { [pluginId]: _removed, ...enabled } = current.enabled ?? {};
      const { [pluginId]: _source, ...sources } = current.sources ?? {};
      return { ...current, enabled, sources };
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
      return yield* setRecord(plugin.id, { status: "active", revision: nextRevision() });
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
    yield* setRecord(plugin.id, { status: "active", activation, revision: nextRevision() });
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

  const stagingRoot = path.join(config.stateDir, "plugin-staging");
  const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));

  // An install interrupted mid-swap (a crash) can leave the old version only in staging. Put it
  // back if nothing replaced it, then drop every leftover staging folder.
  // Listed while the layer builds, before the server serves requests, so recovery never touches
  // the staging folder of an install that starts after that.
  const leftoverStaging = yield* fs
    .readDirectory(stagingRoot)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const recoverStaging = Effect.gen(function* () {
    const entries = leftoverStaging;
    for (const entry of entries) {
      const previous = path.join(stagingRoot, entry, "previous");
      const manifest = yield* fs
        .readFileString(path.join(previous, "t3-plugin.json"))
        .pipe(Effect.flatMap(decodeManifestJson), Effect.option);
      if (Option.isSome(manifest)) {
        const target = path.join(pluginsDir, manifest.value.id);
        const replaced = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true));
        if (!replaced) {
          yield* fs.makeDirectory(pluginsDir, { recursive: true }).pipe(Effect.ignore);
          yield* fs.rename(previous, target).pipe(Effect.ignore);
        }
      }
      yield* fs
        .remove(path.join(stagingRoot, entry), { recursive: true, force: true })
        .pipe(Effect.ignore);
    }
  });

  const startup = lifecycle.withPermits(1)(
    Effect.gen(function* () {
      yield* recoverStaging;
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

  const installFailed = (reason: string) => (cause: unknown) =>
    new PluginInstallError({ reason, cause });

  // Plugins run with T3's own access, so install takes code only from the sources the user named.
  const fetchSource = Effect.fnUntraced(function* (source: PluginInstallSource, into: string) {
    if (source.type === "path") {
      const from = path.resolve(source.path);
      const info = yield* fs
        .stat(from)
        .pipe(Effect.mapError(installFailed(`${source.path} does not exist on the server.`)));
      if (info.type !== "Directory") {
        return yield* new PluginInstallError({ reason: `${source.path} is not a folder.` });
      }
      // Copied rather than linked: the installed plugin never changes when the source does.
      return yield* fs
        .copy(from, into)
        .pipe(Effect.mapError(installFailed(`Could not copy ${source.path}.`)));
    }
    if (source.type === "npm") {
      const files = yield* fetchNpmPackage(source.name, source.version).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.mapError((error) => new PluginInstallError({ reason: error.reason, cause: error })),
      );
      for (const file of files) {
        const target = path.join(into, ...file.path.split("/"));
        yield* fs
          .makeDirectory(path.dirname(target), { recursive: true })
          .pipe(
            Effect.andThen(fs.writeFile(target, file.contents)),
            Effect.mapError(installFailed(`Could not write ${file.path}.`)),
          );
      }
      return;
    }
    const result = yield* processRunner
      .run({
        command: "git",
        args: [
          "clone",
          "--depth",
          "1",
          ...(source.ref === undefined ? [] : ["--branch", source.ref]),
          "--",
          source.url,
          into,
        ],
        timeout: "2 minutes",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ALLOW_PROTOCOL: "https:http:ssh:git:file",
        },
      })
      .pipe(Effect.mapError(installFailed("Could not run git.")));
    if (result.code !== 0) {
      return yield* new PluginInstallError({
        reason: `git clone failed: ${result.stderr.trim().slice(-300) || `exit ${result.code}`}`,
      });
    }
    yield* fs.remove(path.join(into, ".git"), { recursive: true, force: true }).pipe(Effect.ignore);
  });

  const installInHost = Effect.fnUntraced(function* (
    source: PluginInstallSource,
    /** Set by `update`: the id the source must still provide, checked before anything moves. */
    expectedId: PluginId | undefined,
  ) {
    const id = yield* services.crypto.randomUUIDv4().pipe(Effect.orDie);
    const stagingDir = path.join(stagingRoot, id);
    const staged = path.join(stagingDir, "plugin");
    yield* fs
      .makeDirectory(stagingDir, { recursive: true })
      .pipe(Effect.mapError(installFailed("Could not create the staging folder.")));
    const manifest = yield* Effect.gen(function* () {
      yield* fetchSource(source, staged);
      const raw = yield* fs
        .readFileString(path.join(staged, "t3-plugin.json"))
        .pipe(Effect.mapError(installFailed("The source has no t3-plugin.json.")));
      return yield* decodeManifestJson(raw).pipe(
        Effect.mapError(installFailed("The source's t3-plugin.json is not a valid manifest.")),
      );
    }).pipe(
      Effect.tapError(() =>
        fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    const existing = yield* findRecord(manifest.id);
    const pluginsFile = yield* Ref.get(pluginsConfig);
    const recorded = pluginsFile.sources?.[manifest.id];
    // A source may only replace the plugin it installed: another package claiming an installed
    // id would take over that plugin's folder, settings, secrets and storage.
    const refusal =
      existing?.plugin.source === "dev"
        ? `A dev folder already provides ${manifest.id}. Remove it from plugins.json first.`
        : expectedId !== undefined && manifest.id !== expectedId
          ? `The source now provides ${manifest.id}, not ${expectedId}.`
          : existing !== undefined && (recorded === undefined || !Equal.equals(recorded, source))
            ? `${manifest.id} is already installed from somewhere else. Remove it first to replace it.`
            : undefined;
    if (refusal !== undefined) {
      yield* fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore);
      return yield* new PluginInstallError({ reason: refusal });
    }
    // An update keeps a disabled plugin disabled; a new install is enabled.
    const enabled = existing === undefined ? true : pluginsFile.enabled?.[manifest.id] === true;
    const target = path.join(pluginsDir, manifest.id);
    const previous = path.join(stagingDir, "previous");
    yield* runLifecycle(
      Effect.gen(function* () {
        yield* stopPlugin(manifest.id);
        yield* fs
          .makeDirectory(pluginsDir, { recursive: true })
          .pipe(Effect.mapError(installFailed("Could not create the plugins folder.")));
        const hadPrevious = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false));
        if (hadPrevious) {
          yield* fs
            .rename(target, previous)
            .pipe(Effect.mapError(installFailed("Could not move the installed version aside.")));
        }
        yield* fs.rename(staged, target).pipe(
          Effect.mapError(installFailed("Could not move the new version into place.")),
          Effect.tapError(() =>
            hadPrevious ? fs.rename(previous, target).pipe(Effect.ignore) : Effect.void,
          ),
        );
        yield* writeConfig((current) => ({
          ...current,
          enabled: { ...current.enabled, [manifest.id]: enabled },
          sources: { ...current.sources, [manifest.id]: source },
        }));
      }),
    ).pipe(
      Effect.ensuring(fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore)),
      // Whatever happened, the plugin folder now holds one version; start it again.
      Effect.ensuring(reload(manifest.id).pipe(Effect.ignore)),
    );
    return yield* stateOf(manifest.id);
  });

  // Like lifecycle changes, an install runs in the host's scope: a caller that disconnects stops
  // waiting but cannot interrupt the swap or the staging cleanup.
  const install: PluginHost["Service"]["install"] = Effect.fn("PluginHost.install")((source) =>
    installInHost(source, undefined).pipe(Effect.forkIn(hostScope), Effect.flatMap(Fiber.join)),
  );

  const update: PluginHost["Service"]["update"] = Effect.fn("PluginHost.update")(
    function* (pluginId) {
      const source = (yield* Ref.get(pluginsConfig)).sources?.[pluginId];
      if (source === undefined) {
        return yield* new PluginInstallError({
          reason: `${pluginId} was not installed from Settings, so it has no source to update from.`,
        });
      }
      return yield* installInHost(source, pluginId).pipe(
        Effect.forkIn(hostScope),
        Effect.flatMap(Fiber.join),
      );
    },
  );

  const uninstall: PluginHost["Service"]["uninstall"] = Effect.fn("PluginHost.uninstall")(
    function* (pluginId, removeData) {
      const record = yield* findRecord(pluginId);
      if (record === undefined) return yield* new PluginNotFoundError({ pluginId });
      if (record.plugin.source === "dev") {
        return yield* new PluginInstallError({
          reason: `${pluginId} is loaded from a dev folder. Remove it from plugins.json instead.`,
        });
      }
      const settingsSchema = manifestOf(record.plugin)?.settingsSchema;
      yield* runLifecycle(
        Effect.gen(function* () {
          yield* stopPlugin(pluginId);
          // The entry in the plugins folder, not `rootDir`: that is the real path, so a symlinked
          // plugin would delete the user's own folder behind the link.
          const entry = path.join(pluginsDir, pluginId);
          yield* fs
            .remove(entry, { recursive: true, force: true })
            .pipe(Effect.mapError(installFailed(`Could not delete ${entry}.`)));
          yield* removeFromConfig(pluginId);
          // Stopping replaces the record, so match it by id and source rather than identity.
          yield* Ref.update(records, (all) =>
            all.filter(
              (entry) => entry.plugin.id !== pluginId || entry.plugin.source !== "installed",
            ),
          );
          yield* publishStates;
        }),
      );
      if (removeData) {
        yield* settingsStore
          .clear(pluginId, settingsSchema)
          .pipe(Effect.mapError(installFailed("The plugin is removed, but its settings are not.")));
        const keys = yield* services.storage
          .list(pluginId)
          .pipe(Effect.mapError(installFailed("The plugin is removed, but its storage is not.")));
        for (const key of keys) {
          yield* services.storage
            .remove(pluginId, key)
            .pipe(Effect.mapError(installFailed("The plugin is removed, but its storage is not.")));
        }
      }
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

  const service = PluginHost.of({
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
    install,
    update,
    uninstall,
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
  // Agents reach these through the `t3_plugins_*` tools, which MCP already gates as writes, so
  // the call carries operate access.
  yield* services.mcpTools.setHostActions({
    invoke: (pluginId, method, input) =>
      service.invoke({
        pluginId,
        method,
        input,
        scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      }),
    setEnabled: service.setEnabled,
    install: service.install,
    uninstall: service.uninstall,
  });
  return service;
});

export const layer = Layer.effect(PluginHost, make);
