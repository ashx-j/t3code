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
import { forkParked } from "../serverActivation.ts";
import {
  makePluginActivation,
  makePluginApi,
  type PluginActivation,
  type PluginPublication,
} from "./PluginApi.ts";
import { discoverPlugins, type DiscoveredPlugin } from "./pluginDiscovery.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";

const MAX_FAILURE_MESSAGE_CHARS = 500;
// A plugin's cleanup is its own code; a hung one must not keep Disable or Reload waiting forever.
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
    readonly reload: (pluginId: PluginId) => Effect.Effect<PluginState, PluginNotFoundError>;
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

const PluginsConfigFile = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
  devPaths: Schema.optionalKey(Schema.Array(Schema.String)),
});
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

const errorText = (cause: unknown) =>
  (cause instanceof Error ? cause.message : String(cause)).slice(0, MAX_FAILURE_MESSAGE_CHARS);

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
  const settingsStore = yield* PluginSettingsStore.PluginSettingsStore;
  const storage = yield* PluginStorage.PluginStorage;
  const context = yield* Effect.context<never>();

  const pluginsDir = path.join(config.stateDir, "plugins");
  const configPath = path.join(config.stateDir, "plugins.json");

  const records = yield* Ref.make<ReadonlyArray<PluginRecord>>([]);
  const pluginsConfig = yield* Ref.make<PluginsConfigFile>({});
  const changes = yield* PubSub.sliding<ReadonlyArray<PluginState>>(1);
  const lifecycle = yield* Semaphore.make(1);
  const activations = yield* FiberMap.make<PluginId>();

  const currentStates = Effect.gen(function* () {
    const enabled = (yield* Ref.get(pluginsConfig)).enabled ?? {};
    return (yield* Ref.get(records)).map((record) =>
      toState(record, enabled[record.plugin.id] === true),
    );
  });
  const publishStates = currentStates.pipe(
    Effect.flatMap((states) => PubSub.publish(changes, states)),
    Effect.asVoid,
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
      Effect.timeoutOption(CLEANUP_DEADLINE),
      Effect.catchTags({
        PluginCodeError: (error) =>
          Effect.logWarning("plugin cleanup failed", { pluginId, reason: error.message }),
      }),
    );

  const teardown = Effect.fnUntraced(function* (pluginId: PluginId, activation: PluginActivation) {
    for (const cleanup of activation.cleanups.toReversed()) {
      yield* runCleanup(pluginId, cleanup);
    }
    activation.controller.abort();
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
      settings: settingsStore,
      storage,
    });
    const activated = yield* Effect.tryPromise({
      try: () => Promise.resolve().then(() => definition.value.activate(api)),
      catch: (cause) => new PluginCodeError({ cause }),
    }).pipe(
      Effect.onInterrupt(() => teardown(plugin.id, activation)),
      Effect.exit,
    );
    if (activated._tag === "Failure") {
      yield* teardown(plugin.id, activation);
      return yield* setRecord(plugin.id, {
        status: "failed",
        failure: { stage: "activate", message: errorText(Cause.squash(activated.cause)) },
      });
    }
    yield* setRecord(plugin.id, { status: "active", activation });
    yield* Effect.logInfo("plugin activated", { pluginId: plugin.id });
  });

  /** Interrupts a pending activation, then tears down a finished one. */
  const stopPlugin = Effect.fnUntraced(function* (pluginId: PluginId) {
    yield* FiberMap.remove(activations, pluginId);
    const record = yield* findRecord(pluginId);
    if (record?.activation !== undefined) yield* teardown(pluginId, record.activation);
  });

  const startPlugin = (plugin: DiscoveredPlugin) =>
    FiberMap.run(activations, plugin.id, activatePlugin(plugin));

  const initialRecord = (plugin: DiscoveredPlugin, enabled: boolean): PluginRecord =>
    "failure" in plugin
      ? { plugin, status: "failed", failure: plugin.failure }
      : { plugin, status: enabled ? "loading" : "disabled" };

  const discover = Effect.gen(function* () {
    const emptyConfig: PluginsConfigFile = {};
    const current = yield* readConfig.pipe(
      Effect.catchTags({
        PluginConfigError: (error) =>
          Effect.logWarning("ignoring unreadable plugins.json", { path: error.path }).pipe(
            Effect.as(emptyConfig),
          ),
      }),
    );
    yield* Ref.set(pluginsConfig, current);
    const plugins = yield* discoverPlugins({ pluginsDir, devPaths: current.devPaths ?? [] }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    return { plugins, enabled: current.enabled ?? {} };
  });

  const startup = lifecycle.withPermits(1)(
    Effect.gen(function* () {
      const { plugins, enabled } = yield* discover;
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
      yield* lifecycle.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* findRecord(pluginId);
          if (record === undefined) return yield* new PluginNotFoundError({ pluginId });
          yield* writeEnabled(pluginId, enabled);
          if ("failure" in record.plugin) return yield* publishStates;
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
      yield* lifecycle.withPermits(1)(
        Effect.gen(function* () {
          const { plugins, enabled } = yield* discover;
          const fresh = plugins.find((plugin) => plugin.id === pluginId);
          yield* stopPlugin(pluginId);
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
      const output = yield* Effect.tryPromise({
        try: (signal) =>
          Promise.resolve().then(() =>
            registered.handler(request.input, {
              signal: AbortSignal.any([signal, activation.controller.signal]),
            }),
          ),
        catch: handlerError,
      });
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
