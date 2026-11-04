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
  type PluginUploadFile,
  type PluginStatus,
  type ThreadId,
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
import * as HostProcess from "@t3tools/shared/HostProcess";
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
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { parseSkillFrontmatter } from "../provider/Drivers/ClaudeSkills.ts";
import * as ProviderDriverRegistration from "../provider/ProviderDriverRegistration.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlDrivers from "../sourceControl/builtInDrivers.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { STATUS_UPSTREAM_REFRESH_ENV } from "../vcs/GitVcsDriverCore.ts";
import * as ProcessRunner from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";
import {
  makePluginActivation,
  makePluginApi,
  type PluginActivation,
  type PluginApiServices,
  type PluginPublication,
} from "./PluginApi.ts";
import { errorText, PluginCodeError, pluginCodeScope } from "./api/facade.ts";
import { makeRuntimeRequestHooks } from "./api/runtimeRequests.ts";
import { makePluginFailureGuard } from "./pluginFailureGuard.ts";
import { discoverPlugins, type DiscoveredPlugin } from "./pluginDiscovery.ts";
import {
  checkPluginFolder,
  type PluginCheckFinding,
  type PluginCheckReport,
} from "./pluginCheck.ts";
import { fetchNpmPackage, resolveNpmVersion } from "./pluginNpm.ts";
import { commitFromLsRemote, lsRemotePatterns } from "./pluginUpdates.ts";
import * as PluginHooks from "./PluginHooks.ts";
import * as PluginHttpRoutes from "./PluginHttpRoutes.ts";
import * as PluginMcpTools from "./PluginMcpTools.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";

// Clients send web failures and agents read them, so they are bounded like plugin errors.
const MAX_WEB_FAILURE_CHARS = 1_000;
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
const UPDATE_CHECK_INTERVAL = Duration.hours(24);
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
    /**
     * Copies or clones a plugin into the plugins folder, enables it and starts it. It is staged
     * first and swapped in with a rename, so a failed install leaves the previous version. A
     * `link` folder is added to `devPaths` instead, so its edits apply on reload.
     */
    readonly install: (
      source: PluginInstallSource,
    ) => Effect.Effect<PluginState, PluginInstallError | PluginNotFoundError | PluginConfigError>;
    /**
     * Installs a plugin folder a client sent as files, like `install`. It records no source, so
     * the same folder sent again replaces it, but it cannot replace one installed from a source.
     */
    readonly installFiles: (
      files: ReadonlyArray<PluginUploadFile>,
    ) => Effect.Effect<PluginState, PluginInstallError | PluginNotFoundError | PluginConfigError>;
    /** Installs a plugin again from the source it was installed from. */
    readonly update: (
      pluginId: PluginId,
    ) => Effect.Effect<PluginState, PluginInstallError | PluginNotFoundError | PluginConfigError>;
    /**
     * Asks the git or npm source of each plugin installed from one for a newer version, records
     * what it finds and returns the list. The host also checks once a day.
     */
    readonly checkUpdates: Effect.Effect<ReadonlyArray<PluginState>, PluginConfigError>;
    /**
     * Lists what would stop a plugin loading or break it when T3 updates, from its folder on
     * disk; an installed plugin's last failure comes first. Runs none of its code.
     */
    readonly check: (
      target: { readonly pluginId: PluginId } | { readonly path: string },
    ) => Effect.Effect<PluginCheckReport, PluginNotFoundError>;
    /**
     * Keeps the latest web failure a client reported for the plugin's current start, in memory.
     * A report about an earlier start is ignored.
     */
    readonly reportWebFailure: (input: {
      readonly pluginId: PluginId;
      readonly revision: number;
      readonly message: string;
    }) => Effect.Effect<void, PluginNotFoundError>;
    /**
     * Stops a plugin and deletes its folder, or for a linked folder only forgets it;
     * `removeData` also deletes its settings. `linkedFolder` names one linked copy, which is only
     * forgotten when another copy with its id is in use; that copy keeps the data, so
     * `removeData` is refused for it.
     */
    readonly uninstall: (
      pluginId: PluginId,
      removeData: boolean,
      linkedFolder?: string,
    ) => Effect.Effect<void, PluginInstallError | PluginNotFoundError | PluginConfigError>;
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
    /** Where each plugin installed through `install` came from, so `update` can fetch it again. */
    sources: Schema.optionalKey(Schema.Record(Schema.String, PluginInstallSource)),
    /** The npm version or git commit each install fetched, which update checks compare against. */
    installed: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    /** The last update check and the newer versions it found, by plugin id. */
    updates: Schema.optionalKey(
      Schema.Struct({
        checkedAt: Schema.Number,
        available: Schema.Record(Schema.String, Schema.String),
      }),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
type PluginsConfigFile = typeof PluginsConfigFile.Type;
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginsConfigFile));
const encodeClaudePluginManifest = Schema.encodeEffect(
  fromJsonStringPretty(Schema.Struct({ name: Schema.String, description: Schema.String })),
);
const encodeConfig = Schema.encodeEffect(fromJsonStringPretty(PluginsConfigFile));
const isJson = Schema.is(Schema.Json);

interface PluginRecord {
  readonly plugin: DiscoveredPlugin;
  readonly status: PluginStatus;
  readonly failure?: PluginFailure;
  readonly activation?: PluginActivation;
  readonly revision?: number;
}

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

// Git output can carry the URL's credentials too, with or without its scheme
// (`unable to look up user:token@host`).
const withoutCredentials = (text: string, source: PluginInstallSource) => {
  if (source.type !== "git") return text;
  const userinfo = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)@/i.exec(source.url)?.[1];
  return userinfo === undefined ? text : text.replaceAll(`${userinfo}@`, "***@");
};

/** What an install takes a plugin from: a source it records, or files a client sent. */
type InstallOrigin =
  | { readonly source: PluginInstallSource }
  | { readonly files: ReadonlyArray<PluginUploadFile> };

const toState = (
  record: PluginRecord,
  enabled: boolean,
  installSource: PluginInstallSource | undefined,
  availableUpdate: string | undefined,
  webFailure: string | undefined,
  serverFailure: string | undefined,
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
    ...(record.plugin.source === "dev" ? { linkedFolder: record.plugin.folder } : {}),
    enabled,
    status: record.status,
    ...(record.failure === undefined ? {} : { failure: record.failure }),
    ...(record.revision === undefined ? {} : { revision: record.revision }),
    ...(installSource === undefined || record.plugin.source !== "installed"
      ? {}
      : {
          installSource: shownSource(installSource),
          ...(availableUpdate === undefined
            ? {}
            : { availableUpdate: { version: availableUpdate } }),
        }),
    hasServer: manifest?.server !== undefined,
    hasWeb: manifest?.web !== undefined,
    ...("hasSkills" in record.plugin ? { hasSkills: record.plugin.hasSkills } : {}),
    ...(webFailure === undefined ? {} : { webFailure }),
    ...(serverFailure === undefined ? {} : { serverFailure }),
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
  const platform = yield* HostProcess.Platform;
  const context = yield* Effect.context<never>();
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventStore = yield* OrchestrationEventStore.OrchestrationEventStore;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const services: PluginApiServices = {
    version: packageJson.version,
    settings: yield* PluginSettingsStore.PluginSettingsStore,
    storage: yield* PluginStorage.PluginStorage,
    orchestrator,
    eventStore,
    threads,
    projects: yield* ProjectStore.ProjectStoreV2,
    launches: yield* ThreadLaunchService.ThreadLaunchService,
    projectService: yield* ProjectService.ProjectService,
    git: yield* GitVcsDriver.GitVcsDriver,
    secretRequests: yield* SecretRequests.SecretRequests,
    textGeneration: yield* TextGeneration.TextGeneration,
    providers: yield* ProviderRegistry.ProviderRegistry,
    providerDrivers: yield* ProviderDriverRegistration.ProviderDriverRegistration,
    sourceControlDrivers: yield* SourceControlDrivers.SourceControlPluginDrivers,
    hooks: yield* PluginHooks.PluginHooks,
    runtimeRequests: makeRuntimeRequestHooks({ context, orchestrator, threads, crypto }),
    mcpTools: yield* PluginMcpTools.PluginMcpTools,
    httpRoutes: yield* PluginHttpRoutes.PluginHttpRoutes,
    environment: yield* ServerEnvironment.ServerEnvironment,
    serverSettings: yield* ServerSettings.ServerSettingsService,
    crypto,
  };
  const settingsStore = services.settings;
  const environmentThemes = yield* EnvironmentTheme.EnvironmentThemeService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const http = yield* HttpClient.HttpClient;

  const pluginsDir = path.join(config.stateDir, "plugins");
  // Claude loads a plugin folder whole, with its commands, agents, hooks and MCP servers, so
  // agents get a generated folder holding only the plugin's skills. Copied, not linked: linking
  // a folder needs extra rights on Windows.
  const agentFoldersRoot = path.join(config.stateDir, "plugin-agents");
  const agentFolderOf = (pluginId: PluginId) => path.join(agentFoldersRoot, pluginId);
  const configPath = path.join(config.stateDir, "plugins.json");

  const records = yield* Ref.make<ReadonlyArray<PluginRecord>>([]);
  // Changes on every start, so a client can tell a restarted plugin from one that kept running.
  // Seeded with the clock so a restarted server never repeats a revision a client already saw.
  let revision = yield* Clock.currentTimeMillis;
  const nextRevision = () => ++revision;
  const pluginsConfig = yield* Ref.make<PluginsConfigFile>({});
  // By plugin id, for the start it was reported for: a new start's revision hides the old one.
  const webFailures = yield* Ref.make<
    ReadonlyMap<PluginId, { readonly revision: number; readonly message: string }>
  >(new Map());
  // Like web failures. A stopped plugin's leftover timers fail with no revision.
  const serverFailures = yield* Ref.make<
    ReadonlyMap<PluginId, { readonly revision: number | undefined; readonly message: string }>
  >(new Map());
  const changes = yield* PubSub.sliding<ReadonlyArray<PluginState>>(1);
  const lifecycle = yield* Semaphore.make(1);
  const publishLock = yield* Semaphore.make(1);
  // Update checks write plugins.json outside the lifecycle lock, so every read that is written
  // back, or kept as the current config, holds this one.
  const configLock = yield* Semaphore.make(1);
  const activations = yield* FiberMap.make<PluginId>();
  const hostScope = yield* Effect.scope;

  const statesOf = Effect.fn("PluginHost.statesOf")(function* (all: ReadonlyArray<PluginRecord>) {
    const config = yield* Ref.get(pluginsConfig);
    const enabled = config.enabled ?? {};
    const failures = yield* Ref.get(webFailures);
    const serverFailed = yield* Ref.get(serverFailures);
    return all.map((record) => {
      const webFailure = failures.get(record.plugin.id);
      const serverFailure = serverFailed.get(record.plugin.id);
      return toState(
        record,
        enabled[record.plugin.id] === true,
        config.sources?.[record.plugin.id],
        config.updates?.available[record.plugin.id],
        webFailure !== undefined && webFailure.revision === record.revision
          ? webFailure.message
          : undefined,
        serverFailure !== undefined && serverFailure.revision === record.revision
          ? serverFailure.message
          : undefined,
      );
    });
  });
  const currentStates = Ref.get(records).pipe(Effect.flatMap(statesOf));
  // What the last publish sent, starting from the empty list clients get before any. Settings
  // rescans on every visit, and a list sent again would make every client and provider stream
  // rebuild what it already shows.
  let published: ReadonlyArray<PluginState> = [];
  // Reading and publishing under one lock, so a slower fiber cannot publish an older list last.
  const publishUnderLock = publishLock.withPermits(1)(
    Effect.gen(function* () {
      const all = yield* Ref.get(records);
      const states = yield* statesOf(all);
      if (Equal.equals(states, published)) return;
      yield* services.mcpTools.setInstalledPlugins(states);
      const active = all.flatMap((record, index) =>
        states[index]?.status === "active" ? [record.plugin] : [],
      );
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
      const withSkills = yield* Effect.filter(
        active.map((plugin) => {
          const folder = agentFolderOf(plugin.id);
          return { plugin, folder: { plugin: folder, skills: path.join(folder, "skills") } };
        }),
        ({ folder }) => fs.exists(folder.skills).pipe(Effect.orElseSucceed(() => false)),
      );
      yield* services.hooks.setSkillFolders(
        withSkills.map(({ folder }) => folder),
        (yield* Effect.forEach(withSkills, ({ plugin, folder }) =>
          skillsIn(plugin, folder.skills),
        )).flat(),
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
  // A timer that fails every second with the same text logs and publishes once.
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
  }, configLock.withPermits(1));

  const writeEnabled = (pluginId: PluginId, enabled: boolean) =>
    writeConfig((current) => ({
      ...current,
      enabled: { ...current.enabled, [pluginId]: enabled },
    }));

  const withoutAvailableUpdate = (current: PluginsConfigFile, pluginId: PluginId) => {
    if (current.updates === undefined) return current;
    const { [pluginId]: _found, ...available } = current.updates.available;
    return { ...current, updates: { ...current.updates, available } };
  };
  const removeFromConfig = (pluginId: PluginId) =>
    writeConfig((current) => {
      const { [pluginId]: _removed, ...enabled } = current.enabled ?? {};
      const { [pluginId]: _source, ...sources } = current.sources ?? {};
      const { [pluginId]: _installed, ...installed } = current.installed ?? {};
      return { ...withoutAvailableUpdate(current, pluginId), enabled, sources, installed };
    });

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
  const readWebFile = Effect.fnUntraced(function* (within: string, file: string | undefined) {
    const notFound = { status: 404, body: "Not found." };
    if (file === undefined) return notFound;
    const resolved = yield* fs.realPath(file).pipe(Effect.option);
    if (Option.isNone(resolved)) return notFound;
    const real = resolved.value;
    if (real !== within && !real.startsWith(`${within}${path.sep}`)) return notFound;
    const info = yield* fs.stat(real).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return notFound;
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
    const register = (
      routePath: string,
      read: (requestPath: string) => string | undefined,
      within: string,
    ) =>
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
    // A symlinked `assets` folder outside the plugin would serve whatever it points at.
    if (Option.isSome(assetsDir) && assetsDir.value.startsWith(`${plugin.rootDir}${path.sep}`)) {
      yield* register(
        "/assets/*",
        (requestPath) => {
          try {
            return path.join(
              assetsDir.value,
              decodeURIComponent(requestPath.slice("/assets/".length)),
            );
          } catch {
            // A malformed escape names no file.
            return undefined;
          }
        },
        assetsDir.value,
      );
    }
  });

  // Read when plugins change, so provider lists name each skill without reading files.
  const skillsIn = (plugin: DiscoveredPlugin, skillsDir: string) =>
    fs.readDirectory(skillsDir).pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
      Effect.flatMap((folders) =>
        Effect.forEach(folders.toSorted(), (folder) => {
          const skillPath = path.join(skillsDir, folder, "SKILL.md");
          return fs.readFileString(skillPath).pipe(
            Effect.map((contents): ReadonlyArray<PluginHooks.PluginSkill> => {
              const frontmatter = parseSkillFrontmatter(contents);
              // Agents cannot load a skill they cannot parse, and agent-only skills stay unlisted.
              if (
                frontmatter.kind === "malformed" ||
                (frontmatter.kind === "parsed" && frontmatter.userInvocable === false)
              ) {
                return [];
              }
              return [
                {
                  pluginId: plugin.id,
                  pluginName: manifestOf(plugin)?.name ?? plugin.id,
                  folder,
                  path: skillPath,
                  ...(frontmatter.kind === "parsed" && frontmatter.name !== undefined
                    ? { name: frontmatter.name }
                    : {}),
                  ...(frontmatter.kind === "parsed" && frontmatter.description !== undefined
                    ? { description: frontmatter.description }
                    : {}),
                },
              ];
            }),
            Effect.orElseSucceed((): ReadonlyArray<PluginHooks.PluginSkill> => []),
          );
        }),
      ),
      Effect.map((lists) => lists.flat()),
    );
  const removeAgentFolder = (pluginId: PluginId) =>
    fs.remove(agentFolderOf(pluginId), { recursive: true, force: true }).pipe(Effect.ignore);
  const prepareAgentFolder = Effect.fn("PluginHost.prepareAgentFolder")(
    function* (plugin: DiscoveredPlugin, name: string) {
      yield* removeAgentFolder(plugin.id);
      const skills = path.join(plugin.rootDir, "skills");
      if (!(yield* fs.exists(skills))) return;
      const target = agentFolderOf(plugin.id);
      yield* fs.makeDirectory(path.join(target, ".claude-plugin"), { recursive: true });
      const manifest = yield* encodeClaudePluginManifest({
        name: plugin.id,
        description: `Skills from the T3 Code plugin ${name}.`,
      });
      yield* fs.writeFileString(
        path.join(target, ".claude-plugin", "plugin.json"),
        `${manifest}\n`,
      );
      yield* fs.copy(skills, path.join(target, "skills"));
    },
    (effect, plugin) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("could not prepare a plugin's skills for agents", {
            pluginId: plugin.id,
            cause: Cause.pretty(cause).slice(0, 500),
          }).pipe(Effect.andThen(removeAgentFolder(plugin.id))),
        ),
      ),
  );

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
      yield* prepareAgentFolder(plugin, manifest.name);
      return yield* setRecord(plugin.id, { status: "active", revision: nextRevision() });
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
          yield* prepareAgentFolder(plugin, manifest.name);
          yield* setRecord(plugin.id, { status: "active", activation, revision: nextRevision() });
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
  const stopPlugin = Effect.fnUntraced(function* (pluginId: PluginId) {
    yield* FiberMap.remove(activations, pluginId);
    // A failure from before the stop, even one while loading, which has no revision, belongs to
    // that start; failures of code left running after it are recorded again.
    yield* Ref.update(serverFailures, (all) => {
      const next = new Map(all);
      next.delete(pluginId);
      return next;
    });
    yield* removeAgentFolder(pluginId);
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
  // A shadowed copy keeps its manifest for its row, but started it would take over the record
  // of the copy in use, which shares its id.
  const startsAtDiscovery = (
    plugin: DiscoveredPlugin,
    enabled: Readonly<Record<string, boolean>>,
  ) => enabled[plugin.id] === true && !("failure" in plugin);

  // Startup tolerates an unreadable plugins.json; an explicit reload reports it instead.
  const discover = Effect.fnUntraced(function* (lenient: boolean) {
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
    ).pipe(
      Effect.tap((config) => Ref.set(pluginsConfig, config)),
      configLock.withPermits(1),
    );
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
      // Folders of plugins the last run left active; activation writes them again.
      yield* fs.remove(agentFoldersRoot, { recursive: true, force: true }).pipe(Effect.ignore);
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

  /** Rescans the plugin folders and lists what appeared; `restart` also restarts with new code. */
  const rediscover = Effect.fnUntraced(function* (restart: PluginId | undefined) {
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

  const installFailed = (reason: string) => (cause: unknown) =>
    new PluginInstallError({ reason, cause });

  const readSourceManifest = (folder: string) =>
    fs.readFileString(path.join(folder, "t3-plugin.json")).pipe(
      Effect.mapError(installFailed("The source has no t3-plugin.json.")),
      Effect.flatMap((raw) =>
        decodeManifestJson(raw).pipe(
          Effect.mapError(installFailed("The source's t3-plugin.json is not a valid manifest.")),
        ),
      ),
    );

  // Prompts off, and only transports that cannot run commands (no `ext::`).
  const runGit = (args: ReadonlyArray<string>) =>
    processRunner.run({
      command: "git",
      args: [...args],
      timeout: "2 minutes",
      env: {
        ...process.env,
        ...STATUS_UPSTREAM_REFRESH_ENV,
        GIT_ALLOW_PROTOCOL: "https:http:ssh:git:file",
      },
    });

  // Callers check that every path stays inside `into`: the tarball reader and the upload schema.
  const writeFiles = Effect.fnUntraced(function* (
    files: ReadonlyArray<{ readonly path: string; readonly contents: Uint8Array }>,
    into: string,
  ) {
    for (const file of files) {
      const target = path.join(into, ...file.path.split("/"));
      yield* fs
        .makeDirectory(path.dirname(target), { recursive: true })
        .pipe(
          Effect.andThen(fs.writeFile(target, file.contents)),
          Effect.mapError(installFailed(`Could not write ${file.path}.`)),
        );
    }
  });

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
      // Before copying, so a folder that is not a plugin (a home folder) is never copied.
      yield* readSourceManifest(from);
      // Copied rather than linked: the installed plugin never changes when the source does.
      yield* fs
        .copy(from, into)
        .pipe(Effect.mapError(installFailed(`Could not copy ${source.path}.`)));
      return undefined;
    }
    if (source.type === "npm") {
      const { version, files } = yield* fetchNpmPackage(source.name, source.version).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.mapError((error) => new PluginInstallError({ reason: error.reason, cause: error })),
      );
      yield* writeFiles(files, into);
      return version;
    }
    const result = yield* runGit([
      "clone",
      "--depth",
      "1",
      ...(source.ref === undefined ? [] : ["--branch", source.ref]),
      "--",
      source.url,
      into,
    ]).pipe(Effect.mapError(installFailed("Could not run git.")));
    if (result.code !== 0) {
      return yield* new PluginInstallError({
        reason: `git clone failed: ${withoutCredentials(result.stderr.trim(), source).slice(-300) || `exit ${result.code}`}`,
      });
    }
    const head = yield* runGit(["-C", into, "rev-parse", "HEAD"]).pipe(Effect.option);
    yield* fs.remove(path.join(into, ".git"), { recursive: true, force: true }).pipe(Effect.ignore);
    return Option.isSome(head) && head.value.code === 0 ? head.value.stdout.trim() : undefined;
  });

  /**
   * Whether `next` installs from where `recorded` did: the same folder however it is written, the
   * same repository or the same package, whatever ref or version each names.
   */
  // Windows and macOS volumes ignore case in paths by default.
  const folderKey = (folder: string) =>
    platform === "win32" || platform === "darwin"
      ? path.resolve(folder).toLowerCase()
      : path.resolve(folder);
  const sameSource = (
    recorded: PluginInstallSource | undefined,
    next: PluginInstallSource | undefined,
  ) => {
    if (recorded === undefined || next === undefined) return recorded === next;
    switch (next.type) {
      case "path":
        return recorded.type === "path" && folderKey(recorded.path) === folderKey(next.path);
      case "git":
        return recorded.type === "git" && recorded.url === next.url;
      case "npm":
        return recorded.type === "npm" && recorded.name === next.name;
    }
  };

  /** The npm version or git commit installing `source` would fetch now; nothing for a folder. */
  const remoteVersion = Effect.fnUntraced(function* (source: PluginInstallSource) {
    if (source.type === "path") return undefined;
    if (source.type === "npm") {
      return yield* resolveNpmVersion(source.name, source.version).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
    }
    const result = yield* runGit(["ls-remote", "--", source.url, ...lsRemotePatterns(source.ref)]);
    return result.code === 0 ? commitFromLsRemote(result.stdout, source.ref) : undefined;
  });

  const installInHost = Effect.fnUntraced(function* (
    origin: InstallOrigin,
    /** Set by `update`: the id the source must still provide, checked before anything moves. */
    expectedId: PluginId | undefined,
  ) {
    const source = "source" in origin ? origin.source : undefined;
    const id = yield* services.crypto.randomUUIDv4().pipe(Effect.orDie);
    const stagingDir = path.join(stagingRoot, id);
    const staged = path.join(stagingDir, "plugin");
    yield* fs
      .makeDirectory(stagingDir, { recursive: true })
      .pipe(Effect.mapError(installFailed("Could not create the staging folder.")));
    const { manifest, fetched } = yield* Effect.gen(function* () {
      const fetched =
        "source" in origin
          ? yield* fetchSource(origin.source, staged)
          : yield* writeFiles(origin.files, staged).pipe(Effect.as(undefined));
      return { manifest: yield* readSourceManifest(staged), fetched };
    }).pipe(
      Effect.tapError(() =>
        fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    const previous = path.join(stagingDir, "previous");
    let stopped = false;
    yield* runLifecycle(
      // Read under the lock, so another install or a removal cannot change them before the swap.
      Effect.gen(function* () {
        const existing = yield* findRecord(manifest.id);
        const pluginsFile = yield* Ref.get(pluginsConfig);
        const recorded = pluginsFile.sources?.[manifest.id];
        // A source may only replace the plugin it installed: another package claiming an
        // installed id would take over that plugin's folder, settings, secrets and storage. Sent
        // files have no source, so they replace only plugins sent or put in the plugins folder.
        const refusal =
          existing?.plugin.source === "dev"
            ? `${manifest.id} is linked from ${existing.plugin.folder}. Unlink it first.`
            : expectedId !== undefined && manifest.id !== expectedId
              ? `The source now provides ${manifest.id}, not ${expectedId}.`
              : existing !== undefined && !sameSource(recorded, source)
                ? `${manifest.id} is already installed from somewhere else. Remove it first to replace it.`
                : undefined;
        if (refusal !== undefined) return yield* new PluginInstallError({ reason: refusal });
        const target =
          existing === undefined ? path.join(pluginsDir, manifest.id) : existing.plugin.folder;
        // A folder put there by hand holds another plugin, or none, which the swap would delete.
        if (
          existing === undefined &&
          (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true)))
        ) {
          const owner = (yield* Ref.get(records)).find((record) => record.plugin.folder === target);
          return yield* new PluginInstallError({
            reason: `The plugins folder already has a ${manifest.id} folder${owner === undefined ? "" : ` holding ${owner.plugin.id}`}. Move it, then install again.`,
          });
        }
        // An update keeps a disabled plugin disabled; a new install is enabled.
        const enabled = existing === undefined ? true : pluginsFile.enabled?.[manifest.id] === true;
        stopped = true;
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
        yield* writeConfig((current) => {
          const { [manifest.id]: _previous, ...installed } = current.installed ?? {};
          const { [manifest.id]: _source, ...sources } = current.sources ?? {};
          return {
            ...withoutAvailableUpdate(current, manifest.id),
            enabled: { ...current.enabled, [manifest.id]: enabled },
            sources: source === undefined ? sources : { ...sources, [manifest.id]: source },
            installed: fetched === undefined ? installed : { ...installed, [manifest.id]: fetched },
          };
        });
      }),
    ).pipe(
      Effect.ensuring(fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore)),
      // Whatever happened after the stop, the plugin folder holds one version; start it again.
      Effect.ensuring(
        Effect.suspend(() => (stopped ? reload(manifest.id).pipe(Effect.ignore) : Effect.void)),
      ),
    );
    return yield* stateOf(manifest.id);
  });

  // A folder loaded where it is, so an author's edits plus a reload are the whole loop.
  const linkFolder = Effect.fnUntraced(function* (folder: string) {
    const from = path.resolve(folder);
    const info = yield* fs
      .stat(from)
      .pipe(Effect.mapError(installFailed(`${folder} does not exist on the server.`)));
    if (info.type !== "Directory") {
      return yield* new PluginInstallError({ reason: `${folder} is not a folder.` });
    }
    const manifest = yield* readSourceManifest(from);
    const existing = yield* findRecord(manifest.id);
    // Linking an installed plugin's own folder would list it twice, and the copy that loses
    // shares its id, so removing that copy would delete the installed one.
    if (existing !== undefined && existing.plugin.source !== "dev") {
      return yield* new PluginInstallError({
        reason: `${manifest.id} is already installed. Remove it first.`,
      });
    }
    if (existing !== undefined && existing.plugin.folder !== from) {
      return yield* new PluginInstallError({
        reason: `${manifest.id} is already linked from ${existing.plugin.folder}. Unlink it first.`,
      });
    }
    // Discovery lists what is in the plugins folder as installed, and that copy wins, so removing
    // the plugin would delete the folder instead of unlinking it.
    const realPath = (target: string) =>
      fs.realPath(target).pipe(Effect.orElseSucceed(() => target));
    const fromPlugins = path.relative(yield* realPath(pluginsDir), yield* realPath(from));
    const outside =
      fromPlugins === ".." ||
      fromPlugins.startsWith(`..${path.sep}`) ||
      path.isAbsolute(fromPlugins);
    if (!outside) {
      return yield* new PluginInstallError({
        reason: `${folder} is already in the plugins folder, so T3 finds it there without a link, and removing it deletes it. To keep the folder when removing the plugin, link one outside ${pluginsDir}.`,
      });
    }
    yield* writeConfig((current) => ({
      ...current,
      devPaths: [...(current.devPaths ?? []).filter((entry) => path.resolve(entry) !== from), from],
      enabled: { ...current.enabled, [manifest.id]: true },
    }));
    return yield* reload(manifest.id);
  });

  // Like lifecycle changes, an install runs in the host's scope: a caller that disconnects stops
  // waiting but cannot interrupt the swap or the staging cleanup.
  const install: PluginHost["Service"]["install"] = Effect.fn("PluginHost.install")((source) =>
    (source.type === "path" && source.link === true
      ? linkFolder(source.path)
      : installInHost({ source }, undefined)
    ).pipe(Effect.forkIn(hostScope), Effect.flatMap(Fiber.join)),
  );

  // `PluginInstallFilesInput` bounds the folder's size before it gets here.
  const installFiles: PluginHost["Service"]["installFiles"] = Effect.fn("PluginHost.installFiles")(
    (files) =>
      installInHost({ files }, undefined).pipe(
        Effect.forkIn(hostScope),
        Effect.flatMap(Fiber.join),
      ),
  );

  const update: PluginHost["Service"]["update"] = Effect.fn("PluginHost.update")(
    function* (pluginId) {
      const source = (yield* Ref.get(pluginsConfig)).sources?.[pluginId];
      if (source === undefined) {
        return yield* new PluginInstallError({
          reason: `${pluginId} has no source to update from. Add the folder of its new version to replace it.`,
        });
      }
      return yield* installInHost({ source }, pluginId).pipe(
        Effect.forkIn(hostScope),
        Effect.flatMap(Fiber.join),
      );
    },
  );

  const checkUpdates = Effect.fn("PluginHost.checkUpdates")(function* () {
    const config = yield* Ref.get(pluginsConfig);
    const found: Record<string, string> = {};
    yield* Effect.forEach(
      Object.entries(config.sources ?? {}),
      ([pluginId, source]) =>
        remoteVersion(source).pipe(
          Effect.map((latest) => {
            if (latest !== undefined) found[pluginId] = latest;
          }),
          // A source that cannot be reached keeps what the last check found.
          Effect.catchCause((cause) => {
            const previous = config.updates?.available[pluginId];
            if (previous !== undefined) found[pluginId] = previous;
            return Effect.logWarning("plugin update check failed", {
              pluginId,
              cause: withoutCredentials(Cause.pretty(cause), source).slice(0, 500),
            });
          }),
        ),
      { concurrency: 4, discard: true },
    );
    const checkedAt = yield* Clock.currentTimeMillis;
    // Compared with what is installed when writing, so an update that finished meanwhile counts.
    yield* writeConfig((current) => ({
      ...current,
      updates: {
        checkedAt,
        available: Object.fromEntries(
          Object.entries(found).filter(([pluginId, latest]) => {
            const installed = current.installed?.[pluginId];
            return installed !== undefined && installed !== latest;
          }),
        ),
      },
    }));
    yield* publishStates;
    return yield* currentStates;
  });

  // Sleeps until the next check is due, so a start between checks reaches no network. A server
  // with no plugin installed from git or npm never checks.
  const scheduleUpdateChecks = Effect.gen(function* () {
    const checkedAt = (yield* Ref.get(pluginsConfig)).updates?.checkedAt ?? 0;
    const dueIn =
      checkedAt + Duration.toMillis(UPDATE_CHECK_INTERVAL) - (yield* Clock.currentTimeMillis);
    if (dueIn > 0) yield* Effect.sleep(Duration.millis(dueIn));
    const checkIfInstalled = Ref.get(pluginsConfig).pipe(
      Effect.flatMap((config) =>
        Object.values(config.sources ?? {}).some((source) => source.type !== "path")
          ? checkUpdates()
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("plugin update check failed", {
          cause: Cause.pretty(cause).slice(0, 500),
        }),
      ),
    );
    return yield* checkIfInstalled.pipe(
      Effect.andThen(Effect.sleep(UPDATE_CHECK_INTERVAL)),
      Effect.forever,
    );
  });

  // Forgets a linked copy that another copy with its id shadows; the copy in use keeps running.
  const unlinkShadowed = (pluginId: PluginId, folder: string) =>
    runLifecycle(
      Effect.gen(function* () {
        yield* writeConfig((current) => ({
          ...current,
          devPaths: (current.devPaths ?? []).filter((entry) => path.resolve(entry) !== folder),
        }));
        yield* Ref.update(records, (all) =>
          all.filter(
            ({ plugin }) =>
              plugin.id !== pluginId || plugin.source !== "dev" || plugin.folder !== folder,
          ),
        );
        yield* publishStates;
      }),
    );

  const uninstall: PluginHost["Service"]["uninstall"] = Effect.fn("PluginHost.uninstall")(
    function* (pluginId, removeData, linkedFolder) {
      const record = yield* findRecord(pluginId);
      if (record === undefined) return yield* new PluginNotFoundError({ pluginId });
      if (linkedFolder !== undefined) {
        const folder = path.resolve(linkedFolder);
        const copies = (yield* Ref.get(records)).filter(({ plugin }) => plugin.id === pluginId);
        const link = copies.findIndex(
          ({ plugin }) => plugin.source === "dev" && plugin.folder === folder,
        );
        if (link === -1) {
          return yield* new PluginInstallError({
            reason: `No copy of ${pluginId} is linked from ${linkedFolder}.`,
          });
        }
        // The first copy is the one in use, and the others share its settings and storage.
        if (link > 0 && removeData) {
          return yield* new PluginInstallError({
            reason: `${linkedFolder} is not the copy of ${pluginId} in use, and the copy in use keeps the data. Unlink it without removing data.`,
          });
        }
        if (link > 0) return yield* unlinkShadowed(pluginId, folder);
      }
      const { folder, source } = record.plugin;
      const settingsSchema = manifestOf(record.plugin)?.settingsSchema;
      yield* runLifecycle(
        Effect.gen(function* () {
          yield* stopPlugin(pluginId);
          if (source === "dev") {
            // A linked folder is the author's own; only plugins.json forgets it.
            yield* writeConfig((current) => ({
              ...current,
              devPaths: (current.devPaths ?? []).filter((entry) => path.resolve(entry) !== folder),
            }));
          } else {
            // The folder as listed, not `rootDir`: that is the real path, so a symlinked plugin
            // would delete the user's own folder behind the link.
            yield* fs
              .remove(folder, { recursive: true, force: true })
              .pipe(Effect.mapError(installFailed(`Could not delete ${folder}.`)));
          }
          yield* removeFromConfig(pluginId);
          // Stopping replaces the record, so match it by folder rather than identity: a copy it
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
      );
      if (removeData) {
        yield* settingsStore
          .clear(pluginId, settingsSchema)
          .pipe(Effect.mapError(installFailed("The plugin is removed, but its settings are not.")));
        yield* services.storage
          .clear(pluginId)
          .pipe(Effect.mapError(installFailed("The plugin is removed, but its storage is not.")));
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
    const manifest = manifestOf(record.plugin);
    if (manifest !== undefined && manifest.server === undefined) {
      return yield* new PluginNoServerError({ pluginId });
    }
    if (record.status !== "active" || record.activation === undefined) {
      return yield* new PluginNotActiveError({ pluginId, status: record.status });
    }
    return record.activation;
  });

  yield* forkParked(startup.pipe(Effect.andThen(scheduleUpdateChecks)));
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
    rescan: rescan(),
    install,
    installFiles,
    update,
    checkUpdates: checkUpdates(),
    uninstall,
    check: Effect.fn("PluginHost.check")(function* (target) {
      const { folder, state } =
        "path" in target
          ? { folder: path.resolve(target.path), state: undefined }
          : yield* findRecord(target.pluginId).pipe(
              Effect.flatMap((record) =>
                record === undefined
                  ? Effect.fail(new PluginNotFoundError({ pluginId: target.pluginId }))
                  : stateOf(target.pluginId).pipe(
                      Effect.map((state) => ({ folder: record.plugin.rootDir, state })),
                    ),
              ),
            );
      const report = yield* checkPluginFolder(folder, packageJson.version).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const failures: ReadonlyArray<PluginCheckFinding> = [
        ...(state?.failure === undefined
          ? []
          : [
              {
                code: "last-start-failed",
                severity: "error" as const,
                file: null,
                problem: `Its last start failed at ${state.failure.stage}: ${state.failure.message}`,
                fix: "Fix it, then reload the plugin.",
              },
            ]),
        ...(state?.webFailure === undefined
          ? []
          : [
              {
                code: "web-failed",
                severity: "error" as const,
                file: null,
                problem: `Its web half failed in the browser: ${state.webFailure}`,
                fix: "Fix it, rebuild the web bundle, then reload the plugin.",
              },
            ]),
        ...(state?.serverFailure === undefined
          ? []
          : [
              {
                code: "server-failed",
                severity: "error" as const,
                file: null,
                problem: `Its server code failed outside a call, such as in a timer or a hook: ${state.serverFailure}`,
                fix: "Catch errors in its timers and callbacks, and stop its timers in onDeactivate, then reload the plugin.",
              },
            ]),
      ];
      return { ...report, findings: [...failures, ...report.findings] };
    }),
    reportWebFailure: Effect.fn("PluginHost.reportWebFailure")(function* (report) {
      const record = yield* findRecord(report.pluginId);
      if (record === undefined) {
        return yield* new PluginNotFoundError({ pluginId: report.pluginId });
      }
      if (record.revision !== report.revision) return;
      yield* Ref.update(webFailures, (all) =>
        new Map(all).set(report.pluginId, {
          revision: report.revision,
          message: report.message.slice(0, MAX_WEB_FAILURE_CHARS),
        }),
      );
      yield* publishStates;
    }),
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
  // The composer lists the commands of the thread's folder, where a repository adds its own.
  const workspaceOf = Effect.fnUntraced(function* (threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId);
    if (shell === null) return undefined;
    if (shell.worktreePath !== null) return shell.worktreePath;
    const project = yield* services.projectService.getById(shell.projectId);
    return Option.isSome(project) ? project.value.workspaceRoot : undefined;
  });
  yield* services.hooks.setProviderSlashCommands((instanceId, threadId) =>
    Effect.gen(function* () {
      const provider = (yield* services.providers.getProviders).find(
        (candidate) => candidate.instanceId === instanceId,
      );
      if (provider === undefined) return [];
      const cwd = yield* workspaceOf(threadId).pipe(Effect.orElseSucceed(() => undefined));
      const workspace = provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
      return [...provider.slashCommands, ...(workspace?.slashCommands ?? [])].map(
        (command) => command.name,
      );
    }),
  );
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
    reload: service.reload,
    install: service.install,
    uninstall: service.uninstall,
    check: service.check,
    getSettings: Effect.fn("PluginHost.getSettingsForAgent")(function* (pluginId) {
      const { settingsSchema } = yield* manifestFor(pluginId);
      const settings = yield* settingsStore.getForClient(pluginId, settingsSchema);
      return settingsSchema === undefined ? { settings } : { settings, settingsSchema };
    }),
    updateSettings: service.updateSettings,
    slashCommands: services.hooks.currentSlashCommands,
  });
  return service;
});

export const layer = Layer.effect(PluginHost, make);
