// @effect-diagnostics nodeBuiltinImport:off - stylesheet revisions are sha256 digests.
import * as NodeCrypto from "node:crypto";

import {
  type AuthEnvironmentScope,
  AuthSettingsWriteScope,
  type PluginFailure,
  PluginId,
  type PluginManifest,
  type PluginListResult,
  type PluginState,
  type PluginStatesEvent,
  type PluginStatus,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Context from "effect/Context";
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
import * as EnvironmentTheme from "../environmentTheme.ts";
import { forkParked } from "../serverActivation.ts";
import { discoverPlugins, type DiscoveredPlugin } from "./pluginDiscovery.ts";
import * as PluginHttpRoutes from "./PluginHttpRoutes.ts";
import * as PluginInstaller from "./PluginInstaller.ts";

const WEB_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
};

export class PluginNotFoundError extends Schema.TaggedError<PluginNotFoundError>()(
  "PluginNotFoundError",
  { pluginId: PluginId },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} is not installed.`;
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
    /** Rescans the plugin folders and restarts this plugin with fresh files. */
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
  }
>()("t3/plugins/PluginHost") {}

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

interface PluginRecord {
  readonly plugin: DiscoveredPlugin;
  readonly status: PluginStatus;
  readonly failure?: PluginFailure;
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

const toState = (record: PluginRecord, config: PluginsConfigFile): PluginState => {
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
        }),
    permissions: manifest?.permissions ?? [],
    source: record.plugin.source,
    ...(record.plugin.source === "dev" ? { linkedFolder: record.plugin.folder } : {}),
    enabled: config.enabled?.[id] === true,
    status: record.status,
    ...(record.failure === undefined ? {} : { failure: record.failure }),
    ...(record.styles === undefined || record.styles.length === 0 ? {} : { styles: record.styles }),
  };
};

const contentRevision = (contents: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(contents).digest("hex").slice(0, 16);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<never>();
  const httpRoutes = yield* PluginHttpRoutes.PluginHttpRoutes;
  const environmentThemes = yield* EnvironmentTheme.EnvironmentThemeService;

  const pluginsDir = path.join(config.stateDir, "plugins");
  const configPath = path.join(config.stateDir, "plugins.json");

  const records = yield* Ref.make<ReadonlyArray<PluginRecord>>([]);
  const pluginsConfig = yield* Ref.make<PluginsConfigFile>({});
  const changes = yield* PubSub.sliding<ReadonlyArray<PluginState>>(1);
  const lifecycle = yield* Semaphore.make(1);
  const publishLock = yield* Semaphore.make(1);
  const activations = yield* FiberMap.make<PluginId>();
  const hostScope = yield* Effect.scope;

  const statesOf = Effect.fn("PluginHost.statesOf")(function* (all: ReadonlyArray<PluginRecord>) {
    const config = yield* Ref.get(pluginsConfig);
    return all.map((record) => toState(record, config));
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

  // Files are served from the plugin's real folder; a path or symlink out of `within` is refused.
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
    httpRoutes.register({
      pluginId: plugin.id,
      path: routePath,
      handler: (request) =>
        Effect.runPromiseWith(context)(
          readWebFile(within, read(request.path), revisioned ? request.query.v : undefined),
        ),
    });

  // Serves the plugin's `name` folder below `/<name>/` and resolves with its real path, if it has
  // one. A symlinked folder outside the plugin would serve whatever it points at.
  const serveFolder = Effect.fn("PluginHost.serveFolder")(function* (
    plugin: DiscoveredPlugin,
    name: "styles",
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
    yield* setRecord(plugin.id, { status: "active", styles: yield* serveStyles(plugin) });
  });

  /** Interrupts a pending activation and stops serving its files. The caller sets what comes next. */
  const stopPlugin = Effect.fn("PluginHost.stop")(function* (pluginId: PluginId) {
    yield* FiberMap.remove(activations, pluginId);
    yield* httpRoutes.unregisterPlugin(pluginId);
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
  // and never leaves a plugin half stopped.
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

  /** Rescans the plugin folders and lists what appeared; `restart` also restarts with new files. */
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
    // Copies that are gone or changed stop, or they would keep serving files unlisted.
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
  });
  return Context.make(PluginHost, service).pipe(
    Context.add(PluginInstaller.PluginInstaller, installer),
  );
});

/** Provides the host and the installer it builds. */
export const layer = Layer.effectContext(make);
