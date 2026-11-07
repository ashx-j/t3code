// @effect-diagnostics nodeBuiltinImport:off - plugins load through Node's CommonJS loader, which
// the FileSystem service does not wrap, and bundle revisions are sha256 digests.
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";

import {
  AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type PluginFailure,
  PluginId,
  type PluginManifest,
  type PluginListResult,
  type PluginState,
  type PluginStatesEvent,
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

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { forkParked } from "../serverActivation.ts";
import {
  makePluginActivation,
  makePluginApi,
  type PluginActivation,
  type PluginApiServices,
  type PluginPublication,
} from "./PluginApi.ts";
import { errorText, PluginCodeError, pluginCodeScope } from "./api/facade.ts";
import { makePluginFailureGuard } from "./pluginFailureGuard.ts";
import { discoverPlugins, type DiscoveredPlugin } from "./pluginDiscovery.ts";
import * as PluginHttpRoutes from "./PluginHttpRoutes.ts";
import * as PluginInstaller from "./PluginInstaller.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";

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
// A plugin's failures outside a call reach clients at most this often, the latest one last, so a
// timer failing every few milliseconds with new text does not resend the list each time.
const FAILURE_PUBLISH_INTERVAL = Duration.seconds(5);
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

export class PluginNoServerError extends Schema.TaggedError<PluginNoServerError>()(
  "PluginNoServerError",
  { pluginId: PluginId },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} has no server half, so it has no methods or channels.`;
  }
}

export class PluginMethodNotFoundError extends Schema.TaggedError<PluginMethodNotFoundError>()(
  "PluginMethodNotFoundError",
  { pluginId: PluginId, method: Schema.String, methods: Schema.Array(Schema.String) },
) {
  // The methods it has, since nothing else lists them.
  override get message(): string {
    return `Plugin ${this.pluginId} has no method ${this.method}. Its methods: ${this.methods.join(", ") || "none"}.`;
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
    /** `list` as a client with `scopes` sees it: server folder paths only if it manages plugins. */
    readonly listForClient: (
      scopes: ReadonlyArray<AuthEnvironmentScope>,
    ) => Effect.Effect<PluginListResult>;
    /** `listForClient` now, then the rows that differ after every change. */
    readonly streamForClient: (
      scopes: ReadonlyArray<AuthEnvironmentScope>,
    ) => Stream.Stream<PluginStatesEvent>;
    /** Persists the flag, then waits for activation or deactivation to finish. */
    readonly setEnabled: (
      pluginId: PluginId,
      enabled: boolean,
    ) => Effect.Effect<PluginState, PluginNotFoundError | PluginConfigError>;
    /** Rescans the plugin folders and restarts this plugin with fresh code. */
    readonly reload: (
      pluginId: PluginId,
    ) => Effect.Effect<PluginState, PluginNotFoundError | PluginConfigError>;
    /**
     * Rescans the plugin folders without restarting anything. Plugins whose folders appeared are
     * listed, turned off unless plugins.json turns them on; ones whose folders are gone stop.
     */
    readonly rescan: Effect.Effect<
      { readonly plugins: ReadonlyArray<PluginState> },
      PluginConfigError
    >;
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
      | PluginNoServerError
      | PluginMethodNotFoundError
      | PluginAccessDeniedError
      | PluginHandlerError
    >;
    /** Values the plugin publishes on `channel` until it deactivates. */
    readonly subscribe: (input: {
      readonly pluginId: PluginId;
      readonly channel: string;
    }) => Stream.Stream<
      Schema.Json,
      PluginNotFoundError | PluginNotActiveError | PluginNoServerError
    >;
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
export type PluginsConfigFile = typeof PluginsConfigFile.Type;
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginsConfigFile));
const encodeConfig = Schema.encodeEffect(fromJsonStringPretty(PluginsConfigFile));
const isJson = Schema.is(Schema.Json);

interface PluginRecord {
  readonly plugin: DiscoveredPlugin;
  readonly status: PluginStatus;
  readonly failure?: PluginFailure;
  readonly activation?: PluginActivation;
  readonly revision?: number;
  readonly webRevision?: string;
  readonly styles?: PluginState["styles"];
}

const manifestOf = (plugin: DiscoveredPlugin): PluginManifest | undefined =>
  "manifest" in plugin ? plugin.manifest : undefined;

// Folders on the server are for clients that manage plugins; read access can be a guest's.
const withoutServerPaths = (state: PluginState): PluginState => {
  const { linkedFolder: _folder, ...shown } = state;
  return shown;
};
const managesPlugins = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  scopes.includes(AuthSettingsWriteScope);

interface ClientList {
  readonly plugins: ReadonlyArray<PluginState>;
}

// Compared per subscriber, since each one sees its own view of the list.
const statesEvent = (
  previous: ClientList | undefined,
  next: ClientList,
): PluginStatesEvent | undefined => {
  if (previous === undefined) return { _tag: "snapshot", ...next };
  const rows = next.plugins.flatMap((plugin, index) =>
    Equal.equals(plugin, previous.plugins[index]) ? [] : [{ index, plugin }],
  );
  return rows.length === 0 && next.plugins.length === previous.plugins.length
    ? undefined
    : { _tag: "changed", length: next.plugins.length, rows };
};

const toState = (
  record: PluginRecord,
  config: PluginsConfigFile,
  serverFailure: string | undefined,
): PluginState => {
  const manifest = manifestOf(record.plugin);
  const { id } = record.plugin;
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
        }),
    permissions: manifest?.permissions ?? [],
    source: record.plugin.source,
    ...(record.plugin.source === "dev" ? { linkedFolder: record.plugin.folder } : {}),
    enabled: config.enabled?.[id] === true,
    status: record.status,
    ...(record.failure === undefined ? {} : { failure: record.failure }),
    ...(record.revision === undefined ? {} : { revision: record.revision }),
    ...(record.webRevision === undefined ? {} : { webRevision: record.webRevision }),
    ...(record.styles === undefined || record.styles.length === 0 ? {} : { styles: record.styles }),
    hasServer: manifest?.server !== undefined,
    hasWeb: manifest?.web !== undefined,
    ...(serverFailure === undefined ? {} : { serverFailure }),
  };
};

// One loader for the packaged single executable and plain Node: a require created from an
// absolute path loads files from disk in both, and plugin code resolves its own imports.
const requireFromDisk = NodeModule.createRequire(process.execPath);

const contentRevision = (contents: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(contents).digest("hex").slice(0, 16);

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
    launches: yield* ThreadLaunchService.ThreadLaunchService,
    projectService: yield* ProjectService.ProjectService,
    git: yield* GitVcsDriver.GitVcsDriver,
    secretRequests: yield* SecretRequests.SecretRequests,
    providers: yield* ProviderRegistry.ProviderRegistry,
    httpRoutes: yield* PluginHttpRoutes.PluginHttpRoutes,
    environment: yield* ServerEnvironment.ServerEnvironment,
    serverSettings: yield* ServerSettings.ServerSettingsService,
    crypto: yield* Crypto.Crypto,
  };
  const settingsStore = services.settings;
  const environmentThemes = yield* EnvironmentTheme.EnvironmentThemeService;

  const pluginsDir = path.join(config.stateDir, "plugins");
  const configPath = path.join(config.stateDir, "plugins.json");

  const records = yield* Ref.make<ReadonlyArray<PluginRecord>>([]);
  // Changes on every start, so a client can tell a restarted plugin from one that kept running.
  // Seeded with the clock so a restarted server never repeats a revision a client already saw.
  let revision = yield* Clock.currentTimeMillis;
  const nextRevision = () => ++revision;
  const pluginsConfig = yield* Ref.make<PluginsConfigFile>({});
  // By plugin id, for the start it was reported for: a new start's revision hides the old one. A
  // stopped plugin's leftover timers fail with no revision.
  const serverFailures = yield* Ref.make<
    ReadonlyMap<PluginId, { readonly revision: number | undefined; readonly message: string }>
  >(new Map());
  const changes = yield* PubSub.sliding<ReadonlyArray<PluginState>>(1);
  const lifecycle = yield* Semaphore.make(1);
  const publishLock = yield* Semaphore.make(1);
  const activations = yield* FiberMap.make<PluginId>();
  const hostScope = yield* Effect.scope;

  const statesOf = Effect.fn("PluginHost.statesOf")(function* (all: ReadonlyArray<PluginRecord>) {
    const config = yield* Ref.get(pluginsConfig);
    const serverFailed = yield* Ref.get(serverFailures);
    return all.map((record) => {
      const serverFailure = serverFailed.get(record.plugin.id);
      return toState(
        record,
        config,
        serverFailure !== undefined && serverFailure.revision === record.revision
          ? serverFailure.message
          : undefined,
      );
    });
  });
  const currentStates = Ref.get(records).pipe(Effect.flatMap(statesOf));
  // What the last publish sent, starting from the empty list clients get before any. Settings
  // rescans on every visit, and a list sent again would make every client stream rebuild what it
  // already shows.
  let published: ReadonlyArray<PluginState> = [];
  // Reading and publishing under one lock, so a slower fiber cannot publish an older list last.
  const publishUnderLock = publishLock.withPermits(1)(
    Effect.gen(function* () {
      const all = yield* Ref.get(records);
      const states = yield* statesOf(all);
      if (Equal.equals(states, published)) return;
      // Every enabled plugin that has not failed, so a starting or restarting one keeps its themes:
      // windows would otherwise paint T3's colors, forget the saved theme, then switch back.
      yield* environmentThemes.setPluginThemeDirectories(
        all.flatMap((record, index) => {
          const state = states[index];
          return state?.enabled === true && state.status !== "failed"
            ? [path.join(record.plugin.rootDir, "themes")]
            : [];
        }),
      );
      yield* PubSub.publish(changes, states);
      published = states;
    }),
  );
  // A caller that disconnects mid-publish must not leave a change it made unsent.
  const publishStates = Effect.uninterruptible(publishUnderLock);
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

  // When each plugin's failure was last published, and the plugins whose next one is waiting.
  const failurePublishedAt = new Map<PluginId, number>();
  const failurePublishWaiting = new Set<PluginId>();
  // A timer that fails every second with the same text logs and publishes once. Untraced: a
  // plugin's timer can fail every few milliseconds.
  const recordServerFailure = Effect.fnUntraced(function* (pluginId: PluginId, error: unknown) {
    const record = yield* findRecord(pluginId);
    const message = errorText(error);
    const known = (yield* Ref.get(serverFailures)).get(pluginId);
    if (known?.revision === record?.revision && known?.message === message) return;
    yield* Ref.update(serverFailures, (all) =>
      new Map(all).set(pluginId, { revision: record?.revision, message }),
    );
    if (failurePublishWaiting.has(pluginId)) return;
    const publishedAt = failurePublishedAt.get(pluginId);
    const wait =
      publishedAt === undefined
        ? 0
        : publishedAt +
          Duration.toMillis(FAILURE_PUBLISH_INTERVAL) -
          (yield* Clock.currentTimeMillis);
    if (wait > 0) {
      failurePublishWaiting.add(pluginId);
      yield* Effect.sleep(Duration.millis(wait)).pipe(
        Effect.ensuring(Effect.sync(() => failurePublishWaiting.delete(pluginId))),
      );
    }
    failurePublishedAt.set(pluginId, yield* Clock.currentTimeMillis);
    yield* Effect.logWarning("plugin code failed outside a call", {
      pluginId,
      reason: (yield* Ref.get(serverFailures)).get(pluginId)?.message ?? message,
    });
    yield* publishStates;
  });
  // Recorded at once and outside the plugin's scope, where the guard hears of it, and in the
  // host's scope, so a publish still waiting ends with the host.
  const reportServerFailure = (pluginId: PluginId, error: unknown) =>
    pluginCodeScope.exit(() => {
      Effect.runForkWith(context)(
        Effect.forkIn(recordServerFailure(pluginId, error), hostScope, { startImmediately: true }),
      );
    });
  const failureGuard = makePluginFailureGuard(reportServerFailure);
  // Added before the teardown finalizer, so it runs after plugin cleanups.
  yield* Effect.addFinalizer(() => Effect.sync(failureGuard.uninstall));

  const readConfig = Effect.gen(function* () {
    const exists = yield* fs.exists(configPath);
    if (!exists) {
      const emptyConfig: PluginsConfigFile = {};
      return emptyConfig;
    }
    const raw = yield* fs.readFileString(configPath);
    return yield* decodeConfig(raw);
  }).pipe(Effect.mapError((cause) => new PluginConfigError({ path: configPath, cause })));

  const writeConfig = Effect.fn("PluginHost.writeConfig")(function* (
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

  const runCleanup = (pluginId: PluginId, cleanup: () => void | Promise<void>) =>
    Effect.tryPromise({
      try: () => pluginCodeScope.run(pluginId, () => Promise.resolve().then(cleanup)),
      catch: (cause) => new PluginCodeError({ cause }),
    }).pipe(
      Effect.catchTags({
        PluginCodeError: (error) =>
          Effect.logWarning("plugin cleanup failed", { pluginId, reason: error.message }),
      }),
    );

  // Aborts first so handlers and iterators stop, then runs cleanups newest first. Teardown also
  // runs where interruption is off, so the deadline gets an interruptible region to cut.
  const teardown = Effect.fn("PluginHost.teardown")(function* (
    pluginId: PluginId,
    activation: PluginActivation,
  ) {
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
        const exported: unknown = pluginCodeScope.run(plugin.id, () => requireFromDisk(entryPath));
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
  // A request whose `revision` names the file's contents may be cached for good.
  const readWebFile = Effect.fn("PluginHost.readWebFile")(function* (
    within: string,
    file: string | undefined,
    revision?: string,
  ) {
    const notFound = { status: 404, body: "Not found." };
    if (file === undefined) return notFound;
    const resolved = yield* fs.realPath(file).pipe(Effect.option);
    if (Option.isNone(resolved)) return notFound;
    const real = resolved.value;
    if (real !== within && !real.startsWith(`${within}${path.sep}`)) return notFound;
    const info = yield* fs.stat(real).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return notFound;
    const body = yield* fs.readFile(real);
    return {
      status: 200,
      headers: {
        "content-type":
          WEB_CONTENT_TYPES[path.extname(real).toLowerCase()] ?? "application/octet-stream",
        "cache-control":
          revision !== undefined && revision === contentRevision(body)
            ? "private, max-age=31536000, immutable"
            : "no-store",
      },
      body,
    };
  });

  const registerFileRoute = (
    plugin: DiscoveredPlugin,
    routePath: string,
    read: (requestPath: string) => string | undefined,
    within: string,
    revisioned = false,
  ) =>
    services.httpRoutes
      .register({
        pluginId: plugin.id,
        method: "GET",
        path: routePath,
        handler: (request) =>
          Effect.runPromiseWith(context)(
            readWebFile(within, read(request.path), revisioned ? request.query.v : undefined),
          ),
      })
      .pipe(Effect.orDie);

  // Serves the plugin's `name` folder below `/<name>/` and resolves with its real path, if it has
  // one. A symlinked folder outside the plugin would serve whatever it points at.
  const serveFolder = Effect.fn("PluginHost.serveFolder")(function* (
    plugin: DiscoveredPlugin,
    name: "assets" | "styles",
    revisioned: boolean,
  ) {
    const dir = yield* fs.realPath(path.join(plugin.rootDir, name)).pipe(Effect.option);
    if (Option.isNone(dir) || !dir.value.startsWith(`${plugin.rootDir}${path.sep}`)) return;
    yield* registerFileRoute(
      plugin,
      `/${name}/*`,
      (requestPath) => {
        try {
          return path.join(dir.value, decodeURIComponent(requestPath.slice(`/${name}/`.length)));
        } catch {
          // A malformed escape names no file.
          return undefined;
        }
      },
      dir.value,
      revisioned,
    );
    return dir.value;
  });

  const serveWebFiles = Effect.fn("PluginHost.serveWebFiles")(function* (
    plugin: DiscoveredPlugin,
    entry: string,
  ) {
    const bundle = path.join(plugin.rootDir, entry);
    yield* registerFileRoute(plugin, "/web.js", () => bundle, plugin.rootDir, true);
    yield* serveFolder(plugin, "assets", false);
    // The bundle's contents now, for its URL; one that cannot be read gets no revision.
    return yield* fs
      .readFile(bundle)
      .pipe(Effect.map(contentRevision), Effect.option, Effect.map(Option.getOrUndefined));
  });

  // The `.css` files directly in `styles/`, in name order, each with the revision for its URL.
  const serveStyles = Effect.fn("PluginHost.serveStyles")(function* (plugin: DiscoveredPlugin) {
    const dir = yield* serveFolder(plugin, "styles", true);
    if (dir === undefined) return [];
    const names = yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const styles = yield* Effect.forEach(
      names.filter((name) => name.endsWith(".css")).toSorted(),
      (file) =>
        fs.readFile(path.join(dir, file)).pipe(
          Effect.map((contents) => [{ file, revision: contentRevision(contents) }]),
          // Such as a folder named like a stylesheet.
          Effect.orElseSucceed(() => []),
        ),
    );
    return styles.flat();
  });

  const activatePlugin = Effect.fn("PluginHost.activate")(function* (plugin: DiscoveredPlugin) {
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
    const webRevision =
      manifest.web === undefined ? undefined : yield* serveWebFiles(plugin, manifest.web);
    const started = {
      status: "active" as const,
      ...(webRevision === undefined ? {} : { webRevision }),
      styles: yield* serveStyles(plugin),
    };
    if (manifest.server === undefined) {
      return yield* setRecord(plugin.id, { ...started, revision: nextRevision() });
    }
    yield* setRecord(plugin.id, { status: "loading" });
    // Before loading, since a module can start timers as it loads.
    failureGuard.watch(`${plugin.rootDir}${path.sep}`, plugin.id);
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
      name: manifest.name,
      rootDir: plugin.rootDir,
      settingsSchema: manifest.settingsSchema,
      activation,
      context,
      services,
      onFailure: (error) => reportServerFailure(plugin.id, error),
    });
    // Only `activate` can be interrupted. A stop that lands after it waits until the record holds
    // the activation, so `stopPlugin` always finds what to tear down.
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const activated = yield* restore(
          Effect.tryPromise({
            try: () =>
              pluginCodeScope.run(plugin.id, () =>
                Promise.resolve().then(() => definition.value.activate(api)),
              ),
            catch: (cause) => new PluginCodeError({ cause }),
          }).pipe(Effect.timeoutOption(ACTIVATE_DEADLINE)),
        ).pipe(Effect.exit);
        if (activated._tag === "Success" && Option.isSome(activated.value)) {
          yield* setRecord(plugin.id, { ...started, activation, revision: nextRevision() });
          return yield* Effect.logInfo("plugin activated", { pluginId: plugin.id });
        }
        yield* teardown(plugin.id, activation);
        // Whatever stopped the activation sets the plugin's next status.
        if (activated._tag === "Failure" && Cause.hasInterruptsOnly(activated.cause)) return;
        yield* setRecord(plugin.id, {
          status: "failed",
          failure: {
            stage: "activate",
            message:
              activated._tag === "Failure"
                ? errorText(Cause.squash(activated.cause))
                : `activate did not finish within ${Duration.toSeconds(ACTIVATE_DEADLINE)} seconds.`,
          },
        });
      }),
    );
  });

  /**
   * Interrupts a pending activation, then tears down a finished one. The record stops routing
   * calls before cleanups run; the caller sets the plugin's next status.
   */
  const stopPlugin = Effect.fn("PluginHost.stop")(function* (pluginId: PluginId) {
    yield* FiberMap.remove(activations, pluginId);
    // A failure from before the stop, even one while loading, which has no revision, belongs to
    // that start; failures of code left running after it are recorded again.
    yield* Ref.update(serverFailures, (all) => {
      const next = new Map(all);
      next.delete(pluginId);
      return next;
    });
    // Plugins without server code have no activation but may still serve files.
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
  // A shadowed copy keeps its manifest for its row, but started it would take over the record
  // of the copy in use, which shares its id.
  const startsAtDiscovery = (
    plugin: DiscoveredPlugin,
    enabled: Readonly<Record<string, boolean>>,
  ) => enabled[plugin.id] === true && !("failure" in plugin);

  // Startup tolerates an unreadable plugins.json; an explicit reload reports it instead.
  const discover = Effect.fn("PluginHost.discover")(function* (lenient: boolean) {
    const emptyConfig: PluginsConfigFile = {};
    const current = yield* (
      lenient
        ? readConfig.pipe(
            Effect.catchTags({
              PluginConfigError: (error) =>
                Effect.logWarning("ignoring unreadable plugins.json", { path: error.path }).pipe(
                  Effect.as(emptyConfig),
                ),
            }),
          )
        : readConfig
    ).pipe(Effect.tap((config) => Ref.set(pluginsConfig, config)));
    const plugins = yield* discoverPlugins({ pluginsDir, devPaths: current.devPaths ?? [] }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    return { plugins, enabled: current.enabled ?? {} };
  });

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

  /** Rescans the plugin folders and lists what appeared; `restart` also restarts with new code. */
  const rediscover = Effect.fn("PluginHost.rediscover")(function* (restart: PluginId | undefined) {
    const { plugins, enabled } = yield* discover(false);
    if (restart !== undefined) yield* stopPlugin(restart);
    const known = yield* Ref.get(records);
    // A record survives only while discovery still finds the same copy the same way. One whose copy
    // changed, such as a link that was shadowed until the installed copy went, starts over.
    const sameCopy = (record: (typeof known)[number], plugin: (typeof plugins)[number]) =>
      record.plugin.id === plugin.id &&
      record.plugin.folder === plugin.folder &&
      "failure" in record.plugin === "failure" in plugin;
    const next = plugins.map((plugin) => {
      const kept =
        plugin.id === restart ? undefined : known.find((record) => sameCopy(record, plugin));
      return { plugin, kept };
    });
    // Copies that are gone or changed stop, or they would keep running unlisted.
    for (const record of known) {
      if (
        record.plugin.id !== restart &&
        !next.some(({ kept }) => kept === record) &&
        !("failure" in record.plugin)
      ) {
        yield* stopPlugin(record.plugin.id);
      }
    }
    // In discovery's order, which puts the copy in use before the copies it shadows. A kept copy
    // that runs nothing takes discovery's reason, which names the copy now in use. Kept records
    // are read again here: one still starting may have finished while the others stopped.
    yield* Ref.update(records, (current) =>
      next.map(({ plugin, kept }) => {
        if (kept === undefined) return initialRecord(plugin, enabled[plugin.id] === true);
        const latest = current.find((record) => record.plugin === kept.plugin) ?? kept;
        if ("failure" in plugin) return { ...latest, plugin, failure: plugin.failure };
        // One that runs nothing takes the files found now, so starting it loads their manifest.
        return latest.status === "active" || latest.status === "loading"
          ? latest
          : { ...latest, plugin };
      }),
    );
    yield* publishStates;
    for (const { plugin, kept } of next) {
      if (kept === undefined && startsAtDiscovery(plugin, enabled)) yield* startPlugin(plugin);
    }
    return plugins;
  });

  const reload: PluginHost["Service"]["reload"] = Effect.fn("PluginHost.reload")(
    function* (pluginId) {
      yield* runLifecycle(
        rediscover(pluginId).pipe(
          Effect.flatMap((plugins) =>
            plugins.some((plugin) => plugin.id === pluginId)
              ? Effect.void
              : Effect.fail(new PluginNotFoundError({ pluginId })),
          ),
        ),
      );
      yield* awaitActivation(pluginId);
      return yield* stateOf(pluginId);
    },
  );

  const rescan = Effect.fn("PluginHost.rescan")(function* () {
    // The docs tell people to copy plugin folders here, so it has to exist.
    yield* fs.makeDirectory(pluginsDir, { recursive: true }).pipe(Effect.ignore);
    yield* runLifecycle(rediscover(undefined));
    return { plugins: yield* currentStates };
  });

  // Lookups inside an operation that already has its span.
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
    const manifest = manifestOf(record.plugin);
    if (manifest !== undefined && manifest.server === undefined) {
      return yield* new PluginNoServerError({ pluginId });
    }
    if (record.status !== "active" || record.activation === undefined) {
      return yield* new PluginNotActiveError({ pluginId, status: record.status });
    }
    return record.activation;
  });

  const { installer, recoverStaging } = yield* PluginInstaller.make({
    lifecycle: runLifecycle,
    copies: Ref.get(records).pipe(Effect.map((all) => all.map((record) => record.plugin))),
    copyOf: (pluginId) =>
      findRecord(pluginId).pipe(
        Effect.flatMap((record) =>
          record === undefined
            ? Effect.fail(new PluginNotFoundError({ pluginId }))
            : Effect.succeed(record.plugin),
        ),
      ),
    stop: stopPlugin,
    forget: Effect.fn("PluginHost.forget")(function* (pluginId, folder) {
      // Matched by folder rather than identity: stopping replaces the record, and a copy it
      // shadowed may share its source.
      yield* Ref.update(records, (all) =>
        all.filter((entry) => entry.plugin.id !== pluginId || entry.plugin.folder !== folder),
      );
      // A copy it shadowed takes its place, found afresh rather than left as the shadow.
      if ((yield* Ref.get(records)).some((entry) => entry.plugin.id === pluginId)) {
        yield* rediscover(undefined);
      } else {
        yield* publishStates;
      }
    }),
    reload,
    config: Ref.get(pluginsConfig),
    writeConfig,
  });

  const startup = lifecycle
    .withPermits(1)(
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
          if (startsAtDiscovery(plugin, enabled)) yield* startPlugin(plugin);
        }
      }),
    )
    .pipe(Effect.withSpan("PluginHost.startup"));

  yield* forkParked(startup);
  yield* Effect.addFinalizer(() =>
    Ref.get(records).pipe(
      Effect.flatMap((all) =>
        Effect.forEach(
          all,
          (record) =>
            record.activation === undefined
              ? Effect.void
              : teardown(record.plugin.id, record.activation),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    ),
  );

  const streamStates = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      const snapshot = yield* currentStates;
      return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription));
    }),
  );
  const forClient =
    (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
    (plugins: ReadonlyArray<PluginState>): ClientList => ({
      plugins: managesPlugins(scopes) ? plugins : plugins.map(withoutServerPaths),
    });

  const service = PluginHost.of({
    list: currentStates,
    streamStates,
    listForClient: Effect.fn("PluginHost.listForClient")(function* (scopes) {
      return forClient(scopes)(yield* currentStates);
    }),
    streamForClient: (scopes) =>
      streamStates.pipe(
        Stream.map(forClient(scopes)),
        Stream.mapAccum(
          (): ClientList | undefined => undefined,
          (previous, next) => {
            const event = statesEvent(previous, next);
            return [next, event === undefined ? [] : [event]];
          },
        ),
      ),
    setEnabled,
    reload,
    rescan: rescan(),
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
          methods: [...activation.methods.keys()],
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
            pluginCodeScope.run(request.pluginId, () =>
              Promise.resolve().then(() =>
                registered.handler(request.input, {
                  signal: AbortSignal.any([signal, deactivated]),
                }),
              ),
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
  return Context.make(PluginHost, service).pipe(
    Context.add(PluginInstaller.PluginInstaller, installer),
  );
});

/** Provides the host and the installer it builds. */
export const layer = Layer.effectContext(make);
