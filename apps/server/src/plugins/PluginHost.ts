import {
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  PluginId,
  type PluginListResult,
  type PluginState,
  type PluginStatesEvent,
} from "@t3tools/contracts";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { authenticateRawRouteWithScope } from "../http.ts";
import { forkParked } from "../serverActivation.ts";
import { discoverPlugins, type DiscoveredPlugin } from "./pluginDiscovery.ts";
import { makePluginsConfig, type PluginConfigError } from "./pluginsConfig.ts";
import { makePluginStates, manifestOf, type PluginRecord } from "./pluginStates.ts";
import { makePluginWebFiles, type PluginWebFile } from "./pluginWebFiles.ts";

export class PluginNotFoundError extends Schema.TaggedError<PluginNotFoundError>()(
  "PluginNotFoundError",
  { pluginId: PluginId },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} is not installed.`;
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
    /** Rescans the plugin folders and restarts this plugin from its files. */
    readonly reload: (
      pluginId: PluginId,
    ) => Effect.Effect<PluginState, PluginNotFoundError | PluginConfigError>;
    /**
     * Rescans the plugin folders without restarting anything. Plugins whose folders appeared are
     * listed, turned off unless plugins.json turns them on; ones whose folders are gone stop, and
     * plugins.json forgets them.
     */
    readonly rescan: Effect.Effect<
      { readonly plugins: ReadonlyArray<PluginState> },
      PluginConfigError
    >;
    /**
     * What an active plugin serves at `/api/plugins/<pluginId><path>`: a file in its `styles/`. A
     * `revision` that names the file's contents lets it be cached.
     */
    readonly readWebFile: (input: {
      readonly pluginId: string;
      readonly path: string;
      readonly revision: string | undefined;
    }) => Effect.Effect<Option.Option<PluginWebFile>>;
  }
>()("t3/plugins/PluginHost") {}

/** What plugins.json says about the plugins a discovery found. */
interface Found {
  readonly enabled: Readonly<Record<string, boolean>>;
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const pluginsDir = path.join(config.stateDir, "plugins");
  const pluginsConfig = yield* makePluginsConfig;
  const webFiles = yield* makePluginWebFiles;

  const records = yield* Ref.make<ReadonlyArray<PluginRecord>>([]);
  const lifecycle = yield* Semaphore.make(1);
  const activations = yield* FiberMap.make<PluginId>();
  const hostScope = yield* Effect.scope;

  const pluginStates = yield* makePluginStates({ records, config: pluginsConfig.current });
  const currentStates = pluginStates.current;
  const publishStates = pluginStates.publish;
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
  // By id, which finds the copy in use: discovery lists it before any duplicate.
  const setRecord = (pluginId: PluginId, update: Omit<PluginRecord, "plugin">) =>
    Ref.update(records, (all) => {
      const index = all.findIndex((record) => record.plugin.id === pluginId);
      if (index === -1) return all;
      const next = [...all];
      next[index] = { plugin: all[index]!.plugin, ...update };
      return next;
    }).pipe(Effect.andThen(publishStates));

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
    const web = yield* webFiles.find(plugin);
    return yield* setRecord(plugin.id, {
      status: "active",
      webFiles: web.folders,
      styles: web.styles,
    });
  });

  /**
   * An active plugin's record stops serving files. The caller sets the plugin's next status.
   */
  const stopPlugin = Effect.fn("PluginHost.stop")(function* (pluginId: PluginId) {
    yield* FiberMap.remove(activations, pluginId);
    const record = yield* findRecord(pluginId);
    if (record?.status !== "active") return;
    yield* setRecord(pluginId, { status: "disabled" });
  });

  const startPlugin = (plugin: DiscoveredPlugin) =>
    FiberMap.run(activations, plugin.id, activatePlugin(plugin));

  const initialRecord = (plugin: DiscoveredPlugin, found: Found): PluginRecord => {
    if ("failure" in plugin) return { plugin, status: "failed", failure: plugin.failure };
    return found.enabled[plugin.id] === true
      ? { plugin, status: "loading" }
      : { plugin, status: "disabled" };
  };
  const startsAtDiscovery = (plugin: DiscoveredPlugin, found: Found) =>
    initialRecord(plugin, found).status === "loading";

  // Startup tolerates an unreadable plugins.json; an explicit reload reports it instead.
  const discover = Effect.fn("PluginHost.discover")(function* (lenient: boolean) {
    const current = yield* pluginsConfig.reread(lenient);
    const plugins = yield* discoverPlugins({ pluginsDir, devPaths: current.devPaths ?? [] }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    yield* pluginsConfig.forgetMissing(new Set(plugins.map((plugin) => plugin.id))).pipe(
      Effect.catchTags({
        PluginConfigError: (error) =>
          lenient
            ? Effect.logWarning("could not update plugins.json", { path: error.path })
            : Effect.fail(error),
      }),
    );
    const found: Found = { enabled: current.enabled ?? {} };
    return { plugins, found };
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
          yield* pluginsConfig.writeEnabled(pluginId, enabled);
          if ("failure" in record.plugin) return yield* publishStates;
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

  /** Rescans the plugin folders and lists what appeared; `restart` also restarts from new files. */
  const rediscover = Effect.fn("PluginHost.rediscover")(function* (restart: PluginId | undefined) {
    const { plugins, found } = yield* discover(false);
    if (restart !== undefined) yield* stopPlugin(restart);
    const known = yield* Ref.get(records);
    const next = plugins.map((plugin) => ({
      plugin,
      kept:
        plugin.id === restart || "failure" in plugin
          ? undefined
          : known.find(
              (record) =>
                record.plugin.id === plugin.id &&
                record.plugin.folder === plugin.folder &&
                !("failure" in record.plugin),
            ),
    }));
    // Copies that are gone or moved stop.
    for (const record of known) {
      if (
        record.plugin.id !== restart &&
        !("failure" in record.plugin) &&
        !next.some(({ kept }) => kept === record)
      ) {
        yield* stopPlugin(record.plugin.id);
      }
    }
    // Kept records are read again here: one still starting may have finished while others stopped.
    yield* Ref.update(records, (current) =>
      next.map(({ plugin, kept }) => {
        if (kept === undefined) return initialRecord(plugin, found);
        const latest = current.find((record) => record.plugin === kept.plugin) ?? kept;
        // One that runs nothing takes the files found now, so starting it loads their manifest.
        return latest.status === "active" || latest.status === "loading"
          ? latest
          : { ...latest, plugin };
      }),
    );
    yield* publishStates;
    for (const { plugin, kept } of next) {
      if (kept === undefined && startsAtDiscovery(plugin, found)) yield* startPlugin(plugin);
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

  const startup = lifecycle
    .withPermits(1)(
      Effect.gen(function* () {
        const { plugins, found } = yield* discover(true);
        yield* Ref.set(
          records,
          plugins.map((plugin) => initialRecord(plugin, found)),
        );
        yield* publishStates;
        // Each plugin activates in its own fiber, so a slow one delays nobody else.
        for (const plugin of plugins) {
          if (startsAtDiscovery(plugin, found)) yield* startPlugin(plugin);
        }
      }),
    )
    .pipe(Effect.withSpan("PluginHost.startup"));

  yield* forkParked(startup);

  const service = PluginHost.of({
    list: currentStates,
    streamStates: pluginStates.stream,
    listForClient: pluginStates.listForClient,
    streamForClient: pluginStates.streamForClient,
    setEnabled,
    reload,
    rescan: rescan(),
    readWebFile: Effect.fn("PluginHost.readWebFile")(function* (request) {
      const record = yield* findRecord(request.pluginId);
      if (record?.status !== "active" || record.webFiles === undefined) return Option.none();
      return yield* webFiles.read(record.webFiles, request.path, request.revision);
    }),
  });
  return Context.make(PluginHost, service);
});

export const layer = Layer.effectContext(make);

const WEB_FILES_ROUTE_PREFIX = "/api/plugins";

/** `GET /api/plugins/<pluginId>/<path>`, answered with what the active plugin serves there. */
export const layerWebFilesRoute = HttpRouter.add(
  "GET",
  `${WEB_FILES_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    // Same sign-in as reads on the rest of `/api`.
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const url = HttpServerRequest.toURL(yield* HttpServerRequest.HttpServerRequest);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const rest = url.value.pathname.slice(`${WEB_FILES_ROUTE_PREFIX}/`.length);
    const slash = rest.indexOf("/");
    const host = yield* PluginHost;
    const file = yield* host.readWebFile({
      pluginId: slash === -1 ? rest : rest.slice(0, slash),
      path: slash === -1 ? "/" : rest.slice(slash),
      revision: url.value.searchParams.get("v") ?? undefined,
    });
    return Option.match(file, {
      onNone: () => HttpServerResponse.text("Not Found", { status: 404 }),
      onSome: ({ headers, body }) => HttpServerResponse.uint8Array(body, { headers }),
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);
