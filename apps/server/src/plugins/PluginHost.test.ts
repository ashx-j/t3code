// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  applyPluginStatesEvent,
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentId,
  PluginId,
  ProjectId,
  ThreadId,
  type TurnItemId,
  type PluginState,
  type PluginStatesEvent,
  type Project,
  ProviderInstanceId,
  type ServerProvider,
  WS_METHODS,
} from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import packageJson from "../../package.json" with { type: "json" };
import { gzipTarball, tarEntry } from "./testTarball.ts";
import * as PluginHooks from "./PluginHooks.ts";
import * as PluginHost from "./PluginHost.ts";
import * as PluginHttpRoutes from "./PluginHttpRoutes.ts";
import * as PluginInstaller from "./PluginInstaller.ts";
import { makePluginRpcHandlers } from "./pluginRpcHandlers.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";
import { withPluginTextGeneration } from "./pluginTextGeneration.ts";

// None of these messages replays an accepted command.
const notAccepted = Effect.succeed(false);
const fixturesDir = new URL("../../../../packages/plugin-sdk/fixtures/", import.meta.url).pathname;
const hello = PluginId.make("hello-plugin");
const broken = PluginId.make("broken-plugin");
const operate = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] as const;

const layerConfig = () =>
  Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-plugin-host-test-" }));

// Services the plugins in these tests never reach.
const layerUnusedLaunchServices = Layer.mergeAll(
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(TextGeneration.TextGeneration)({}),
);

// Orchestration services the lifecycle tests never reach.
const layerUnusedServices = Layer.mergeAll(
  layerUnusedLaunchServices,
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ServerEnvironment.ServerEnvironment)({}),
  Layer.mock(ServerSettings.ServerSettingsService)({}),
);

// Every list of theme folders the host published, for the web files case.
const publishedThemeDirectories: Array<ReadonlyArray<string>> = [];
const layerThemes = Layer.mock(EnvironmentTheme.EnvironmentThemeService)({
  setPluginThemeDirectories: (directories) =>
    Effect.sync(() => {
      publishedThemeDirectories.push(directories);
    }),
});

// A registry with one good package and one whose integrity hash does not match its tarball.
const npmTarball = gzipTarball(
  tarEntry(
    "package/t3-plugin.json",
    JSON.stringify({
      id: "npm-hello",
      name: "npm hello",
      version: "1.0.0",
      engines: { t3: ">=0.1.0" },
      server: "./server.cjs",
    }),
  ),
  tarEntry("package/server.cjs", "module.exports = { activate() {} };"),
);
const npmIntegrity = `sha512-${NodeCrypto.createHash("sha512").update(npmTarball).digest("base64")}`;
// A package whose releases all need a T3 Code that does not exist yet.
const npmFutureTarball = gzipTarball(
  tarEntry(
    "package/t3-plugin.json",
    JSON.stringify({
      id: "npm-future",
      name: "npm future",
      version: "1.1.0",
      engines: { t3: ">=999.0.0" },
    }),
  ),
);
const npmFutureIntegrity = `sha512-${NodeCrypto.createHash("sha512").update(npmFutureTarball).digest("base64")}`;
// The registry's `latest` tag, which update checks compare with what was installed.
let npmLatest = "1.0.0";
let npmMetadataRequests = 0;
const npmDocument = (name: string, integrity: string) => {
  const release = { dist: { tarball: `https://registry.test/${name}.tgz`, integrity } };
  return {
    "dist-tags": { latest: npmLatest },
    versions: { "1.0.0": release, "1.1.0": release },
  };
};
const layerNpmRegistry = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    const url = request.url;
    if (!url.endsWith(".tgz")) npmMetadataRequests += 1;
    const body = url.endsWith("/npm-future.tgz")
      ? new Response(npmFutureTarball)
      : url.endsWith(".tgz")
        ? new Response(npmTarball)
        : url.endsWith("/npm-hello")
          ? Response.json(npmDocument("npm-hello", npmIntegrity))
          : url.endsWith("/npm-tampered")
            ? Response.json(npmDocument("npm-tampered", "sha512-AAAA"))
            : url.endsWith("/npm-future")
              ? Response.json(npmDocument("npm-future", npmFutureIntegrity))
              : new Response("not found", { status: 404 });
    return Effect.succeed(HttpClientResponse.fromWeb(request, body));
  }),
);

const layerHost = (services: typeof layerUnusedServices = layerUnusedServices) =>
  Layer.fresh(
    PluginHost.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(PluginSettingsStore.layer, PluginStorage.layer)),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(services),
      Layer.provide(layerThemes),
      Layer.provide(ProcessRunner.layer),
      Layer.provide(layerNpmRegistry),
      Layer.provideMerge(Layer.mergeAll(PluginHooks.layer, PluginHttpRoutes.layer)),
    ),
  );

/** The real file system with some of its methods replaced, for the host's layer. */
const layerFileSystemWith = (
  replace: (fs: FileSystem.FileSystem) => Partial<FileSystem.FileSystem>,
) =>
  Layer.effect(
    FileSystem.FileSystem,
    FileSystem.FileSystem.use((fs) => Effect.succeed({ ...fs, ...replace(fs) })),
  );

const writeFile = Effect.fn(function* (filePath: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, contents);
});

const writePluginsConfig = Effect.fn(function* (config: {
  readonly enabled?: Record<string, boolean>;
  readonly devPaths?: ReadonlyArray<string>;
}) {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  yield* writeFile(`${stateDir}/plugins.json`, JSON.stringify(config));
});

/** A plugin written for one test, under `<stateDir>/plugins/<id>`. */
const writeInstalledPlugin = Effect.fn(function* (id: string, serverSource: string) {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const rootDir = `${stateDir}/plugins/${id}`;
  yield* writeFile(
    `${rootDir}/t3-plugin.json`,
    JSON.stringify({
      id,
      name: id,
      version: "0.1.0",
      engines: { t3: ">=0.1.0" },
      server: "./server.cjs",
    }),
  );
  yield* writeFile(`${rootDir}/server.cjs`, serverSource);
  return rootDir;
});

const manifestJson = (id: string) =>
  JSON.stringify({ id, name: id, version: "0.1.0", engines: { t3: ">=0.1.0" } });

const upgrade = PluginId.make("upgrade");
/** Version `version` of the `upgrade` plugin in `folder`, whose `activate` runs `activate`. */
const writeUpgradeVersion = Effect.fn(function* (
  folder: string,
  version: string,
  options: {
    readonly activate?: string;
    readonly engines?: string;
    readonly settingsSchema?: Schema.JsonObject;
  } = {},
) {
  yield* writeFile(
    `${folder}/t3-plugin.json`,
    JSON.stringify({
      id: upgrade,
      name: "Upgrade",
      version,
      engines: { t3: options.engines ?? ">=0.1.0" },
      server: "./server.cjs",
      ...(options.settingsSchema === undefined ? {} : { settingsSchema: options.settingsSchema }),
    }),
  );
  yield* writeFile(
    `${folder}/server.cjs`,
    `module.exports = { activate() { ${options.activate ?? ""} } };`,
  );
});

const stateOf = (states: ReadonlyArray<PluginState>, id: string) =>
  states.find((state) => state.id === id);

/** Resolves with the first list where every listed plugin has its expected status. */
const waitForStatuses = (
  host: PluginHost.PluginHost["Service"],
  expected: Readonly<Record<string, PluginState["status"]>>,
) =>
  host.streamStates.pipe(
    Stream.filter((states) =>
      Object.entries(expected).every(([id, status]) => stateOf(states, id)?.status === status),
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const workbench = PluginId.make("workbench-plugin");
const workbenchThread = ThreadId.make("thread:plugin-workbench");
const workbenchProject = ProjectId.make("project:plugin-workbench");
const workbenchModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };
const workbenchTextModel = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "haiku",
};

interface Workbench {
  readonly host: PluginHost.PluginHost["Service"];
  readonly hooks: PluginHooks.PluginHooksRegistry;
  readonly call: (
    method: string,
    input?: Schema.Json,
  ) => ReturnType<PluginHost.PluginHost["Service"]["invoke"]>;
  /** Sends `text` to the workbench thread, through its provider `instanceId` when given. */
  readonly send: (
    text: string,
    instanceId?: string,
  ) => Effect.Effect<string, PluginHooks.PluginMessageBlockedError>;
  /** What the providers list, empty unless a test sets them. */
  readonly setProviders: (providers: ReadonlyArray<ServerProvider>) => void;
  readonly prompted: ReadonlyArray<TextGeneration.TextGenerationInput>;
}

/**
 * Runs `body` with the workbench fixture plugin active, over a project, a thread and a text
 * generation model, and services that record what the plugin asks of them.
 */
const withWorkbench = Effect.fn(function* <A, E>(
  body: (workbench: Workbench) => Effect.Effect<A, E>,
) {
  const prompted: Array<TextGeneration.TextGenerationInput> = [];
  let providers: ReadonlyArray<ServerProvider> = [];
  const project: Project = {
    id: workbenchProject,
    title: "Workbench project",
    workspaceRoot: "/repo",
    defaultModelSelection: workbenchModel,
    scripts: [],
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
    deletedAt: null,
  };
  const services = Layer.mergeAll(
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.sync(() => providers),
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(TextGeneration.TextGeneration)({
      generateText: (input) =>
        Effect.sync(() => {
          prompted.push(input);
          return { text: "Two commits since the last deploy." };
        }),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamStoredEventsFrom: () => Stream.never,
      streamDomainEvents: Stream.never,
      listActiveShellIndex: () => Effect.succeed([]),
    }),
    Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
      latestAgentSequence: () => Effect.succeed(0),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      listProjectThreads: () => Effect.succeed([]),
      getThreadShell: () =>
        Effect.succeed({
          id: workbenchThread,
          projectId: workbenchProject,
          worktreePath: null,
          deletedAt: null,
        } as never),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed({
        environmentId: EnvironmentId.make("environment:plugin-workbench"),
        label: "Workbench host",
        platform: { os: "linux", arch: "x64" },
        serverVersion: packageJson.version,
        capabilities: { repositoryIdentity: false, plugins: true },
      }),
    }),
    ServerSettings.layerTest({ textGenerationModelSelection: workbenchTextModel }).pipe(
      Layer.orDie,
    ),
  );
  yield* writePluginsConfig({
    enabled: { [workbench]: true },
    devPaths: [`${fixturesDir}workbench-plugin`],
  });
  return yield* Effect.gen(function* () {
    const host = yield* PluginHost.PluginHost;
    const hooks = yield* PluginHooks.PluginHooks;
    yield* waitForStatuses(host, { [workbench]: "active" });
    return yield* body({
      host,
      hooks,
      call: (method, input) => host.invoke({ pluginId: workbench, method, input, scopes: operate }),
      send: (text, instanceId) =>
        hooks.beforeDispatch(
          {
            threadId: workbenchThread,
            messageId: "message:workbench",
            text,
            createdBy: "user",
            creationSource: "web",
            attachments: [],
          },
          notAccepted,
          ...(instanceId === undefined ? [] : [Effect.succeed(instanceId)]),
        ),
      setProviders: (next) => {
        providers = next;
      },
      prompted,
    });
  }).pipe(Effect.provide(layerHost(services)));
}, Effect.provide(layerConfig()));

it.layer(NodeServices.layer)("PluginHost", (it) => {
  it.effect("activates an enabled plugin and serves its methods, settings and storage", () =>
    Effect.gen(function* () {
      yield* writePluginsConfig({
        enabled: { [hello]: true },
        devPaths: [`${fixturesDir}hello-plugin`],
      });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const states = yield* waitForStatuses(host, { [hello]: "active" });
        assert.include(stateOf(states, hello), { source: "dev", hasServer: true, enabled: true });

        const ping = (input: string) =>
          host.invoke({ pluginId: hello, method: "ping", input, scopes: operate });
        assert.deepStrictEqual(yield* ping("a"), { pong: "a", greeting: "hello" });
        const changed = yield* host
          .subscribe({ pluginId: hello, channel: "settings" })
          .pipe(Stream.runHead, Effect.forkChild({ startImmediately: true }));
        yield* host.updateSettings(hello, { greeting: "hey" });
        assert.deepStrictEqual(yield* Fiber.join(changed), Option.some({ greeting: "hey" }));
        assert.deepStrictEqual(yield* ping("b"), { pong: "b", greeting: "hey" });

        const counted = yield* host
          .subscribe({ pluginId: hello, channel: "counted" })
          .pipe(Stream.runHead, Effect.forkChild({ startImmediately: true }));
        assert.strictEqual(
          yield* host.invoke({
            pluginId: hello,
            method: "count",
            input: undefined,
            scopes: operate,
          }),
          1,
        );
        assert.deepStrictEqual(yield* Fiber.join(counted), Option.some(1));

        const denied = yield* host
          .invoke({
            pluginId: hello,
            method: "count",
            input: undefined,
            scopes: [AuthOrchestrationReadScope],
          })
          .pipe(Effect.flip);
        assert.strictEqual(denied._tag, "PluginAccessDeniedError");
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("marks a plugin that throws in activate as failed and keeps the others running", () =>
    Effect.gen(function* () {
      yield* writePluginsConfig({
        enabled: { [hello]: true, [broken]: true },
        devPaths: [`${fixturesDir}broken-plugin`, `${fixturesDir}hello-plugin`],
      });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const states = yield* waitForStatuses(host, { [broken]: "failed", [hello]: "active" });
        assert.deepStrictEqual(stateOf(states, broken)?.failure, {
          stage: "activate",
          message: "broken-plugin refuses to start",
        });
        const missing = yield* host
          .invoke({ pluginId: broken, method: "ping", input: undefined, scopes: operate })
          .pipe(Effect.flip);
        assert.strictEqual(missing._tag, "PluginNotActiveError");
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("runs cleanup on disable and stops serving the plugin", () =>
    Effect.gen(function* () {
      yield* writePluginsConfig({
        enabled: { [hello]: true },
        devPaths: [`${fixturesDir}hello-plugin`],
      });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const storage = yield* PluginStorage.PluginStorage;
        yield* waitForStatuses(host, { [hello]: "active" });

        const disabled = yield* host.setEnabled(hello, false);
        assert.include(disabled, { status: "disabled", enabled: false });
        assert.deepStrictEqual(yield* storage.get(hello, "deactivated"), Option.some(true));
        const error = yield* host
          .invoke({ pluginId: hello, method: "ping", input: undefined, scopes: operate })
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "PluginNotActiveError");

        const { stateDir } = yield* ServerConfig.ServerConfig;
        const saved = yield* FileSystem.FileSystem.use((fs) =>
          fs.readFileString(`${stateDir}/plugins.json`),
        );
        assert.deepStrictEqual(JSON.parse(saved).enabled, { [hello]: false });
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("keeps the keys T3 saves in a plugin's storage out of the plugin's reach", () =>
    Effect.gen(function* () {
      const id = PluginId.make("keeper");
      const cursorKey = "t3.turns.afterRunCompleted.1";
      yield* writeInstalledPlugin(
        id,
        `module.exports = { activate(api) {
  api.rpc.register("keys", async () => { await api.storage.set("mine", 1); return api.storage.list(); }, { access: "write" });
  api.rpc.register("overwrite", () => api.storage.set("${cursorKey}", 0), { access: "write" });
} };`,
      );
      yield* writePluginsConfig({ enabled: { [id]: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const storage = yield* PluginStorage.PluginStorage;
        yield* waitForStatuses(host, { [id]: "active" });
        yield* storage.set(id, cursorKey, { sequence: 3, runIds: [] });
        const call = (method: string) =>
          host.invoke({ pluginId: id, method, input: undefined, scopes: operate });

        assert.deepStrictEqual(yield* call("keys"), ["mine"]);
        const refused = yield* call("overwrite").pipe(Effect.flip);
        assert.include(refused.message, 'Storage keys starting with "t3." belong to T3.');
        assert.deepStrictEqual(
          yield* storage.get(id, cursorKey),
          Option.some({ sequence: 3, runIds: [] }),
        );
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("reload picks up a changed manifest and changed code", () =>
    Effect.gen(function* () {
      const rootDir = yield* writeInstalledPlugin(
        "reloading",
        `module.exports = { activate(api) { api.rpc.register("which", () => "v1", { access: "read" }); } };`,
      );
      yield* writePluginsConfig({ enabled: { reloading: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const id = PluginId.make("reloading");
        yield* waitForStatuses(host, { reloading: "active" });
        const which = host.invoke({
          pluginId: id,
          method: "which",
          input: undefined,
          scopes: operate,
        });
        assert.strictEqual(yield* which, "v1");

        yield* writeFile(
          `${rootDir}/t3-plugin.json`,
          JSON.stringify({
            id: "reloading",
            name: "Reloaded",
            version: "0.2.0",
            engines: { t3: ">=0.1.0" },
            server: "./server.cjs",
          }),
        );
        yield* writeFile(
          `${rootDir}/server.cjs`,
          `module.exports = { activate(api) { api.rpc.register("which", () => "v2", { access: "read" }); } };`,
        );
        const reloaded = yield* host.reload(id);
        assert.include(reloaded, { status: "active", version: "0.2.0", name: "Reloaded" });
        assert.strictEqual(yield* which, "v2");
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("fails a plugin that registers a method with an unknown access level", () =>
    Effect.gen(function* () {
      yield* writeInstalledPlugin(
        "typo",
        `module.exports = { activate(api) { api.rpc.register("go", () => 1, { access: "Write" }); } };`,
      );
      yield* writePluginsConfig({ enabled: { typo: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const states = yield* waitForStatuses(host, { typo: "failed" });
        assert.deepStrictEqual(stateOf(states, "typo")?.failure, {
          stage: "activate",
          message: 'Method "go" needs access "read" or "write".',
        });
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("reload stops a plugin whose folder was removed", () =>
    Effect.gen(function* () {
      const stays = yield* writeInstalledPlugin("stays", `module.exports = { activate() {} };`);
      const goes = yield* writeInstalledPlugin(
        "goes",
        `const marker = require("node:path").join(__dirname, "..", "..", "goes-cleaned");
module.exports = { activate(api) { api.onDeactivate(() => require("node:fs").writeFileSync(marker, "")); } };`,
      );
      yield* writePluginsConfig({ enabled: { stays: true, goes: true, arrives: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const fs = yield* FileSystem.FileSystem;
        yield* waitForStatuses(host, { stays: "active", goes: "active" });
        yield* fs.remove(goes, { recursive: true });

        yield* host.reload(PluginId.make("stays"));

        assert.isTrue(yield* fs.exists(`${stays}/../../goes-cleaned`));
        assert.isUndefined(stateOf(yield* host.list, "goes"));

        // Reloading a plugin that is gone still starts the plugins the rescan found.
        yield* writeInstalledPlugin("arrives", `module.exports = { activate() {} };`);
        const missing = yield* host.reload(PluginId.make("goes")).pipe(Effect.flip);
        assert.strictEqual(missing._tag, "PluginNotFoundError");
        assert.include(yield* host.setEnabled(PluginId.make("arrives"), true), {
          status: "active",
        });
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("reload runs new code from a symlinked plugin folder", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const realDir = `${stateDir}/checkout/linked`;
      const plugin = (version: string) =>
        `module.exports = { activate(api) { api.rpc.register("which", () => "${version}", { access: "read" }); } };`;
      yield* writeFile(
        `${realDir}/t3-plugin.json`,
        JSON.stringify({
          id: "linked",
          name: "Linked",
          version: "0.1.0",
          engines: { t3: ">=0.1.0" },
          server: "./server.cjs",
        }),
      );
      yield* writeFile(`${realDir}/server.cjs`, plugin("v1"));
      yield* fs.makeDirectory(`${stateDir}/plugins`, { recursive: true });
      yield* fs.symlink(realDir, `${stateDir}/plugins/linked`);
      yield* writePluginsConfig({ enabled: { linked: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const id = PluginId.make("linked");
        const which = host.invoke({
          pluginId: id,
          method: "which",
          input: undefined,
          scopes: operate,
        });
        yield* waitForStatuses(host, { linked: "active" });
        assert.strictEqual(yield* which, "v1");

        yield* writeFile(`${realDir}/server.cjs`, plugin("v2"));
        yield* host.reload(id);
        assert.strictEqual(yield* which, "v2");

        // An `assets` folder linked out of the plugin is not served.
        yield* writeFile(`${stateDir}/checkout/outside/secret.txt`, "Not the plugin's.");
        yield* fs.symlink(`${stateDir}/checkout/outside`, `${realDir}/assets`);
        yield* writeFile(`${realDir}/web.js`, "export default {};");
        yield* writeFile(
          `${realDir}/t3-plugin.json`,
          JSON.stringify({
            id: "linked",
            name: "Linked",
            version: "0.1.0",
            engines: { t3: ">=0.1.0" },
            server: "./server.cjs",
            web: "./web.js",
          }),
        );
        yield* host.reload(id);
        const routes = yield* PluginHttpRoutes.PluginHttpRoutes;
        const request = { method: "GET", path: "/web.js", query: {}, headers: {}, body: "" };
        assert.strictEqual((yield* routes.handle({ pluginId: id, request })).status, 200);
        const outside = yield* routes
          .handle({ pluginId: id, request: { ...request, path: "/assets/secret.txt" } })
          .pipe(Effect.flip);
        assert.strictEqual(outside._tag, "PluginHttpRouteNotFoundError");
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("links a folder in place, reloads its edits and keeps the folder when removed", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const folder = `${stateDir}/checkout/in-place`;
      const plugin = (version: string) =>
        `module.exports = { activate(api) { api.rpc.register("which", () => "${version}", { access: "read" }); } };`;
      yield* writeFile(
        `${folder}/t3-plugin.json`,
        JSON.stringify({
          id: "in-place",
          name: "In place",
          version: "0.1.0",
          engines: { t3: ">=0.1.0" },
          server: "./server.cjs",
        }),
      );
      yield* writeFile(`${folder}/server.cjs`, plugin("v1"));
      const installedDir = yield* writeInstalledPlugin("installed-one", plugin("v1"));
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        const id = PluginId.make("in-place");
        const which = host.invoke({
          pluginId: id,
          method: "which",
          input: undefined,
          scopes: operate,
        });
        assert.include(yield* installer.install({ type: "path", path: folder, link: true }), {
          status: "active",
          enabled: true,
          source: "dev",
          linkedFolder: folder,
        });
        assert.isFalse(yield* fs.exists(`${stateDir}/plugins/in-place`));
        assert.strictEqual(yield* which, "v1");

        yield* writeFile(`${folder}/server.cjs`, plugin("v2"));
        yield* host.reload(id);
        assert.strictEqual(yield* which, "v2");
        const copy = yield* installer.install({ type: "path", path: folder }).pipe(Effect.flip);
        assert.match(copy.message, /is linked from .+\. Unlink it first\./);
        // A second copy of an installed plugin would share its id, so removing that copy would
        // delete the installed one.
        yield* waitForStatuses(host, { "installed-one": "disabled" });
        const twice = yield* installer
          .install({ type: "path", path: installedDir, link: true })
          .pipe(Effect.flip);
        assert.strictEqual(twice.message, "installed-one is already installed. Remove it first.");
        // Discovery would list it as installed too, so removing it would delete it.
        const unlisted = yield* writeInstalledPlugin("unlisted", plugin("v1"));
        const inside = yield* installer
          .install({ type: "path", path: unlisted, link: true })
          .pipe(Effect.flip);
        assert.include(inside.message, "is already in the plugins folder");
        yield* fs.remove(unlisted, { recursive: true });

        yield* installer.uninstall(id, false);
        assert.isTrue(yield* fs.exists(`${folder}/server.cjs`));
        // Forgotten, not only stopped: a rescan does not find it again.
        assert.isUndefined(stateOf((yield* host.rescan).plugins, "in-place"));

        // A copy put in the plugins folder by hand shadows the link. Unlinking leaves that copy
        // running with its data, which shares the id.
        const storage = yield* PluginStorage.PluginStorage;
        yield* installer.install({ type: "path", path: folder, link: true });
        yield* writeInstalledPlugin("in-place", plugin("installed"));
        yield* host.reload(id);
        yield* storage.set(id, "kept", true);
        const keepsData = yield* installer.uninstall(id, true, folder).pipe(Effect.flip);
        assert.include(keepsData.message, "Unlink it without removing data.");
        yield* installer.uninstall(id, false, folder);
        const copies = (yield* host.rescan).plugins.filter((state) => state.id === "in-place");
        assert.deepStrictEqual(
          copies.map((state) => state.source),
          ["installed"],
        );
        assert.strictEqual(yield* which, "installed");
        assert.deepStrictEqual(yield* storage.get(id, "kept"), Option.some(true));
        assert.isTrue(yield* fs.exists(`${folder}/server.cjs`));

        // The other way round: removing the installed copy lists the link afresh, turned off like
        // any newly found copy, not stuck as the shadowed copy it was.
        yield* installer.uninstall(id, false);
        yield* installer.install({ type: "path", path: folder, link: true });
        yield* writeInstalledPlugin("in-place", plugin("installed"));
        yield* host.reload(id);
        yield* installer.uninstall(id, false);
        const left = (yield* host.list).filter((state) => state.id === "in-place");
        assert.deepStrictEqual(
          left.map((state) => [state.source, state.status, state.failure]),
          [["dev", "disabled", undefined]],
        );
        yield* host.setEnabled(id, true);
        assert.strictEqual(yield* which, "v2");

        const notLinked = yield* installer
          .uninstall(id, false, `${stateDir}/elsewhere`)
          .pipe(Effect.flip);
        assert.strictEqual(
          notLinked.message,
          `No copy of in-place is linked from ${stateDir}/elsewhere.`,
        );

        // Three copies in the plugins folder, which share a source: removing the one in use lists
        // the next afresh, and the last one names that copy as the one used instead.
        const threeCopies = PluginId.make("three-copies");
        for (const name of ["three-copies", "three-copies-a", "three-copies-b"]) {
          yield* writeFile(
            `${stateDir}/plugins/${name}/t3-plugin.json`,
            JSON.stringify({ id: threeCopies, name, version: "0.1.0", engines: { t3: ">=0.1.0" } }),
          );
        }
        yield* host.rescan;
        yield* installer.uninstall(threeCopies, false);
        assert.deepStrictEqual(
          (yield* host.list)
            .filter((state) => state.id === threeCopies)
            .map((state) => [state.name, state.status, state.failure?.message]),
          [
            ["three-copies-a", "disabled", undefined],
            [
              "three-copies-b",
              "failed",
              'Another copy of this plugin, in the "three-copies-a" folder, is used instead.',
            ],
          ],
        );
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("lists plugin code that fails outside a call instead of stopping the server", () =>
    Effect.gen(function* () {
      yield* writeInstalledPlugin(
        "leaky",
        `let titles = 0;
module.exports = { activate(api) {
  api.rpc.register("throwLater", () => { setTimeout(() => { throw new Error("thrown in a timer"); }, 0); }, { access: "read" });
  api.rpc.register("awaitLater", () => { setTimeout(async () => { await api.threads.read("thread:gone"); }, 0); }, { access: "read" });
  api.rpc.register("spawnMissing", () => { require("node:child_process").spawn("t3-plugin-test-missing-command"); }, { access: "read" });
  api.textGeneration.register("threadTitle", () => { titles += 1; throw new Error("no title " + titles); });
} };`,
      );
      // A timer it sets while starting fails, then it fails to start.
      yield* writeInstalledPlugin(
        "leaky-start",
        `module.exports = { activate() {
  setTimeout(() => { throw new Error("thrown while starting"); }, 0);
  return new Promise((_, reject) => setTimeout(() => reject(new Error("activate failed")), 0));
} };`,
      );
      yield* writePluginsConfig({ enabled: { leaky: true, "leaky-start": true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const hooks = yield* PluginHooks.PluginHooks;
        const id = PluginId.make("leaky");
        yield* waitForStatuses(host, { leaky: "active", "leaky-start": "failed" });
        const nextFailure = (previous: string | undefined) =>
          host.streamStates.pipe(
            Stream.map((states) => stateOf(states, id)?.serverFailure),
            Stream.filter((failure) => failure !== undefined && failure !== previous),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );
        const failureAfter = (method: string, previous: string | undefined) =>
          host
            .invoke({ pluginId: id, method, input: undefined, scopes: operate })
            .pipe(Effect.andThen(nextFailure(previous)));

        const thrown = yield* failureAfter("throwLater", undefined);
        assert.strictEqual(thrown, "thrown in a timer");
        // A plugin's failures reach clients at once, then at most every 5 seconds.
        yield* TestClock.adjust("5 seconds");
        // An awaited API call fails away from the plugin's own frames, so its error names it.
        const awaited = yield* failureAfter("awaitLater", thrown);
        yield* TestClock.adjust("5 seconds");
        // So does a child process with no error listener, whose stack is all Node's.
        const spawned = yield* failureAfter("spawnMissing", awaited);
        assert.include(spawned, "ENOENT");
        assert.include(stateOf(yield* host.list, id), { status: "active" });

        // A callback only T3 waits on fails onto the row too. Of failures closer together than
        // 5 seconds, clients get the first at once and the latest when the 5 seconds are up.
        yield* TestClock.adjust("5 seconds");
        const [generateTitle] = yield* hooks.textGenerators("threadTitle");
        assert.isDefined(generateTitle);
        const failures = yield* host.streamStates.pipe(
          Stream.map((states) => stateOf(states, id)?.serverFailure),
          Stream.changes,
          Stream.takeUntil((failure) => failure === "no title 3"),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* generateTitle({ message: "Fix it" });
        yield* nextFailure(spawned);
        yield* generateTitle({ message: "Fix it" });
        yield* generateTitle({ message: "Fix it" });
        yield* TestClock.adjust("5 seconds");
        assert.deepStrictEqual(yield* Fiber.join(failures), [spawned, "no title 1", "no title 3"]);

        // A failure while starting belongs to that start, so Disable clears it.
        const starting = PluginId.make("leaky-start");
        assert.include(stateOf(yield* host.list, starting), {
          serverFailure: "thrown while starting",
        });
        assert.isUndefined((yield* host.setEnabled(starting, false)).serverFailure);
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("finishes disabling a plugin when the caller gives up during its cleanup", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      Reflect.set(globalThis, "__t3PluginHostCleanupStarted", started.resolve);
      Reflect.set(globalThis, "__t3PluginHostCleanupGate", gate.promise);
      yield* writeInstalledPlugin(
        "stubborn",
        `module.exports = { activate(api) {
  api.rpc.register("ping", () => "pong", { access: "read" });
  api.onDeactivate(() => { globalThis.__t3PluginHostCleanupStarted(); return globalThis.__t3PluginHostCleanupGate; });
} };`,
      );
      yield* writePluginsConfig({ enabled: { stubborn: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const id = PluginId.make("stubborn");
        yield* waitForStatuses(host, { stubborn: "active" });

        const disabling = yield* host
          .setEnabled(id, false)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => started.promise);
        yield* Fiber.interrupt(disabling);
        gate.resolve();

        yield* waitForStatuses(host, { stubborn: "disabled" });
        const error = yield* host
          .invoke({ pluginId: id, method: "ping", input: undefined, scopes: operate })
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "PluginNotActiveError");
      }).pipe(Effect.provide(layerHost()));
      Reflect.deleteProperty(globalThis, "__t3PluginHostCleanupStarted");
      Reflect.deleteProperty(globalThis, "__t3PluginHostCleanupGate");
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("gives a plugin the server's version and environment, its threads and projects", () =>
    withWorkbench(({ call }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* call("overview"), {
          version: packageJson.version,
          environment: "Workbench host",
          threads: 0,
          projects: 0,
          firstThreadId: null,
        });
      }),
    ),
  );

  it.effect("runs a plugin's send hooks on the messages users send", () =>
    withWorkbench(({ send }) =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* send("Ship it #context"),
          "Ship it #context\n\nContext from workbench-plugin.",
        );
        assert.strictEqual(yield* send("#shout ship it"), "SHIP IT");
        assert.strictEqual(
          (yield* Effect.flip(send("Deploy with #secret"))).message,
          "Workbench: Remove the secret first.",
        );
      }),
    ),
  );

  it.effect("runs a plugin's slash command instead of the send hooks, and lists it", () =>
    withWorkbench(({ hooks, send }) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* send("/deploy staging"), "Deploy to staging and report back.");
        assert.strictEqual(
          (yield* Effect.flip(send("/deploy"))).message,
          "Workbench: Name an environment, for example /deploy staging.",
        );
        const [provider] = PluginHooks.withPluginSlashCommands(
          [
            {
              slashCommands: [
                { name: "deploy", description: "Provider deploy" },
                { name: "review" },
              ],
              workspaceSnapshots: [{ cwd: "/repo", slashCommands: [] }],
            } as unknown as ServerProvider,
          ],
          yield* hooks.currentSlashCommands,
        );
        const status = { name: "status", description: "Show the deploy status" };
        // A provider's own command of the same name stays in its list.
        assert.deepStrictEqual(provider?.slashCommands, [
          { name: "deploy", description: "Provider deploy" },
          { name: "review" },
          status,
        ]);
        assert.deepStrictEqual(provider?.workspaceSnapshots?.[0]?.slashCommands, [
          {
            name: "deploy",
            description: "Deploy to an environment",
            input: { hint: "environment" },
          },
          status,
        ]);
      }),
    ),
  );

  it.effect("lets a provider's own command of the same name win when a message goes to it", () =>
    withWorkbench(({ send, setProviders }) =>
      Effect.gen(function* () {
        // Whether every folder has it or the repository of the thread's project adds it.
        setProviders([
          { instanceId: "claudeAgent", slashCommands: [{ name: "deploy" }] },
          {
            instanceId: "cursor",
            slashCommands: [],
            workspaceSnapshots: [{ cwd: "/repo", slashCommands: [{ name: "deploy" }] }],
          },
          {
            instanceId: "codex",
            slashCommands: [],
            workspaceSnapshots: [{ cwd: "/elsewhere", slashCommands: [{ name: "deploy" }] }],
          },
        ] as unknown as ReadonlyArray<ServerProvider>);
        assert.strictEqual(yield* send("/deploy staging", "claudeAgent"), "/deploy staging");
        assert.strictEqual(yield* send("/deploy staging", "cursor"), "/deploy staging");
        assert.strictEqual(
          yield* send("/deploy staging", "codex"),
          "Deploy to staging and report back.",
        );
      }),
    ),
  );

  it.effect("gives a shared slash command name to the plugin whose id sorts first", () =>
    withWorkbench(({ hooks, send }) =>
      Effect.gen(function* () {
        // Whichever started first, and the other plugin keeps the rest of its commands.
        const removeEarlier = yield* hooks.addSlashCommand(
          { pluginId: "aaa-plugin", pluginName: "Earlier", name: "deploy" },
          () => Effect.succeed({ text: "Deployed by the earlier plugin." }),
        );
        const removeLater = yield* hooks.addSlashCommand(
          { pluginId: "zzz-plugin", pluginName: "Later", name: "status" },
          () => Effect.succeed({ text: "Status from the later plugin." }),
        );
        assert.strictEqual(yield* send("/deploy staging"), "Deployed by the earlier plugin.");
        assert.strictEqual(yield* send("/status"), "Report the deploy status.");
        assert.deepStrictEqual(
          (yield* hooks.currentSlashCommands).map(
            (command) => `${command.pluginId}/${command.name}`,
          ),
          ["workbench-plugin/status", "aaa-plugin/deploy"],
        );
        yield* removeEarlier;
        yield* removeLater;
        assert.strictEqual(yield* send("/deploy staging"), "Deploy to staging and report back.");
      }),
    ),
  );

  it.effect("titles the threads a plugin recognises and leaves the rest to T3", () =>
    withWorkbench(({ hooks }) =>
      Effect.gen(function* () {
        const titles = withPluginTextGeneration(hooks, {
          generateThreadTitle: () => Effect.succeed({ title: "T3 title" }),
        } as unknown as ProviderTextGeneration);
        const title = (message: string) =>
          titles.generateThreadTitle({ cwd: "/repo", message, modelSelection: workbenchModel });
        assert.deepStrictEqual(yield* title("#titled Release prep"), {
          title: "Workbench: Release prep",
        });
        assert.deepStrictEqual(yield* title("Release prep"), { title: "T3 title" });
      }),
    ),
  );

  it.effect("runs a plugin's own prompt on the text generation model from the settings", () =>
    withWorkbench(({ call, prompted }) =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* call("summarize", { log: "abc123 fix\ndef456 feat" }),
          "Two commits since the last deploy.",
        );
        assert.deepInclude(prompted[0], {
          cwd: `${fixturesDir}workbench-plugin`,
          prompt: "Summarize these commits in one sentence:\nabc123 fix\ndef456 feat",
        });
        assert.deepInclude(prompted[0]?.modelSelection, workbenchTextModel);
      }),
    ),
  );

  it.effect("runs a plugin's work on an interval", () =>
    withWorkbench(({ host }) =>
      Effect.gen(function* () {
        const tick = yield* host
          .subscribe({ pluginId: workbench, channel: "ticks" })
          .pipe(Stream.runHead, Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("1 second");
        assert.deepStrictEqual(yield* Fiber.join(tick), Option.some(1));
      }),
    ),
  );

  it.effect("serves an active plugin's web files and themes, and stops when disabled", () =>
    Effect.gen(function* () {
      const helloWeb = PluginId.make("hello-web");
      yield* writePluginsConfig({
        enabled: { [helloWeb]: true },
        devPaths: [`${fixturesDir}hello-web`],
      });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const routes = yield* PluginHttpRoutes.PluginHttpRoutes;
        yield* waitForStatuses(host, { [helloWeb]: "active" });
        const request = { method: "GET", path: "/web.js", query: {}, headers: {}, body: "" };

        const response = yield* routes.handle({ pluginId: helloWeb, request });
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers["content-type"], "text/javascript; charset=utf-8");
        // The bundle's revision names its contents, so browsers keep that URL's copy for good.
        const webRevision = stateOf(yield* host.list, helloWeb)?.webRevision ?? "";
        assert.match(webRevision, /^[0-9a-f]{16}$/);
        const revised = yield* routes.handle({
          pluginId: helloWeb,
          request: { ...request, query: { v: webRevision } },
        });
        assert.strictEqual(
          revised.headers["cache-control"],
          "private, max-age=31536000, immutable",
        );
        assert.strictEqual(response.headers["cache-control"], "no-store");
        const themes = `${fixturesDir}hello-web/themes`;
        assert.deepStrictEqual(publishedThemeDirectories.at(-1), [themes]);
        // A reload publishes its folder again, so its files are read again, without dropping it
        // first: windows would flash T3's colors.
        publishedThemeDirectories.length = 0;
        yield* host.reload(helloWeb);
        assert.isNotEmpty(publishedThemeDirectories);
        assert.deepStrictEqual(
          publishedThemeDirectories.filter((directories) => !directories.includes(themes)),
          [],
        );
        const asset = yield* routes.handle({
          pluginId: helloWeb,
          request: { ...request, path: "/assets/hello.txt" },
        });
        assert.strictEqual(asset.headers["content-type"], "text/plain; charset=utf-8");
        // A path out of the assets folder names no asset; it is not the plugin's failure.
        for (const path of ["/assets/..%2Fserver.cjs", "/assets/%E0%A4%A", "/assets/"]) {
          const missing = yield* routes.handle({
            pluginId: helloWeb,
            request: { ...request, path },
          });
          assert.strictEqual(missing.status, 404);
        }

        yield* host.setEnabled(helloWeb, false);
        const missing = yield* routes.handle({ pluginId: helloWeb, request }).pipe(Effect.flip);
        assert.strictEqual(missing._tag, "PluginHttpRouteNotFoundError");
        assert.deepStrictEqual(publishedThemeDirectories.at(-1), []);
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("serves the stylesheets of a plugin with no code while it is active", () =>
    Effect.gen(function* () {
      const stylesPlugin = PluginId.make("styles-plugin");
      yield* writePluginsConfig({
        enabled: { [stylesPlugin]: true },
        devPaths: [`${fixturesDir}styles-plugin`],
      });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const routes = yield* PluginHttpRoutes.PluginHttpRoutes;
        yield* waitForStatuses(host, { [stylesPlugin]: "active" });
        // In name order, which is the order clients apply them in.
        const styles = stateOf(yield* host.list, stylesPlugin)?.styles ?? [];
        assert.deepStrictEqual(
          styles.map(({ file }) => file),
          ["base.css", "compact.css"],
        );
        const request = {
          method: "GET",
          path: "/styles/base.css",
          query: { v: styles[0]?.revision ?? "" },
          headers: {},
          body: "",
        };
        const response = yield* routes.handle({ pluginId: stylesPlugin, request });
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers["content-type"], "text/css; charset=utf-8");
        assert.strictEqual(
          response.headers["cache-control"],
          "private, max-age=31536000, immutable",
        );
        const outside = yield* routes.handle({
          pluginId: stylesPlugin,
          request: { ...request, path: "/styles/..%2Ft3-plugin.json" },
        });
        assert.strictEqual(outside.status, 404);

        yield* host.setEnabled(stylesPlugin, false);
        assert.isUndefined(stateOf(yield* host.list, stylesPlugin)?.styles);
        const gone = yield* routes.handle({ pluginId: stylesPlugin, request }).pipe(Effect.flip);
        assert.strictEqual(gone._tag, "PluginHttpRouteNotFoundError");
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect(
    "installs from a folder, keeps the old version when a reinstall fails, and uninstalls",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const broken = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugin-broken-" });
        yield* writeFile(`${broken}/t3-plugin.json`, JSON.stringify({ id: "hello-plugin" }));
        const notPlugin = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugin-none-" });
        yield* writeFile(`${notPlugin}/notes.txt`, "Not a plugin.");
        const copiedFrom: Array<string> = [];
        const layerCopies = layerFileSystemWith((real) => ({
          copy: (from, to, options) =>
            Effect.sync(() => copiedFrom.push(from)).pipe(
              Effect.andThen(real.copy(from, to, options)),
            ),
        }));
        yield* Effect.gen(function* () {
          const host = yield* PluginHost.PluginHost;
          const installer = yield* PluginInstaller.PluginInstaller;
          yield* waitForStatuses(host, {});

          // A folder that is not a plugin, such as a home folder, is refused before it is copied.
          const notInstalled = yield* installer
            .install({ type: "path", path: notPlugin })
            .pipe(Effect.flip);
          assert.strictEqual(notInstalled.message, "The source has no t3-plugin.json.");
          assert.notInclude(copiedFrom, notPlugin);

          const source = { type: "path" as const, path: `${fixturesDir}hello-plugin` };
          const installed = yield* installer.install(source);
          assert.deepStrictEqual(installed.installSource, source);
          const updated = yield* installer.update(hello);
          assert.include(updated, { status: "active" });
          assert.notStrictEqual(updated.revision, installed.revision);
          // The same folder written another way is the same source.
          assert.include(yield* installer.install({ ...source, path: `${source.path}/` }), {
            status: "active",
          });
          assert.include(installed, {
            id: hello,
            status: "active",
            enabled: true,
            source: "installed",
          });
          assert.isTrue(yield* fs.exists(`${stateDir}/plugins/hello-plugin/server.cjs`));

          const failed = yield* installer.install({ type: "path", path: broken }).pipe(Effect.flip);
          assert.strictEqual(failed._tag, "PluginInstallError");
          assert.include(stateOf(yield* host.list, hello), { status: "active" });
          assert.isTrue(yield* fs.exists(`${stateDir}/plugins/hello-plugin/server.cjs`));

          yield* installer.uninstall(hello, true);
          assert.isUndefined(stateOf(yield* host.list, hello));
          assert.isFalse(yield* fs.exists(`${stateDir}/plugins/hello-plugin`));

          // A plugin linked into the plugins folder: removing it removes the link, not its source.
          yield* fs.symlink(`${fixturesDir}hello-plugin`, `${stateDir}/plugins/hello-plugin`);
          yield* host.reload(hello).pipe(Effect.ignore);
          yield* installer.uninstall(hello, false);
          assert.isFalse(yield* fs.exists(`${stateDir}/plugins/hello-plugin`));
          assert.isTrue(yield* fs.exists(`${fixturesDir}hello-plugin/server.cjs`));

          // A plugin copied by hand into the folder an install would use is not replaced.
          yield* writeFile(
            `${stateDir}/plugins/hello-plugin/t3-plugin.json`,
            JSON.stringify({
              id: "hand-copied",
              name: "Hand copied",
              version: "0.1.0",
              engines: { t3: ">=0.1.0" },
            }),
          );
          yield* host.rescan;
          const occupied = yield* installer.install(source).pipe(Effect.flip);
          assert.strictEqual(
            occupied.message,
            "The plugins folder already has a hello-plugin folder holding hand-copied. Move it, then install again.",
          );
          assert.include(stateOf(yield* host.list, "hand-copied"), { status: "disabled" });
          yield* installer.uninstall(PluginId.make("hand-copied"), false);

          npmLatest = "1.0.0";
          const fromNpm = yield* installer.install({ type: "npm", name: "npm-hello" });
          assert.include(fromNpm, { id: PluginId.make("npm-hello"), status: "active" });
          assert.isUndefined(stateOf(yield* installer.checkUpdates, "npm-hello")?.availableUpdate);
          const ranged = yield* installer
            .install({ type: "npm", name: "npm-hello", version: "^1.0.0" })
            .pipe(Effect.flip);
          assert.match(ranged.message, /not an exact version\. Use one such as 1\.2\.3/);
          npmLatest = "1.1.0";
          assert.deepStrictEqual(
            stateOf(yield* installer.checkUpdates, "npm-hello")?.availableUpdate,
            {
              version: "1.1.0",
            },
          );
          // Another source claiming an installed id is refused before anything moves.
          const impostor = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugin-impostor-" });
          const impostorManifest = JSON.stringify({
            id: "npm-hello",
            name: "Impostor",
            version: "9.0.0",
            engines: { t3: ">=0.1.0" },
          });
          yield* writeFile(`${impostor}/t3-plugin.json`, impostorManifest);
          const takeover = yield* installer
            .install({ type: "path", path: impostor })
            .pipe(Effect.flip);
          assert.match(takeover.message, /already installed from somewhere else/);
          const dropped = yield* installer
            .installFiles([
              { path: "t3-plugin.json", contents: new TextEncoder().encode(impostorManifest) },
            ])
            .pipe(Effect.flip);
          assert.match(dropped.message, /already installed from somewhere else/);
          // Updating a disabled plugin keeps it disabled.
          yield* host.setEnabled(PluginId.make("npm-hello"), false);
          const npmUpdated = yield* installer.update(PluginId.make("npm-hello"));
          assert.include(npmUpdated, { enabled: false });
          assert.isUndefined(npmUpdated.availableUpdate);
          // So is the same package with a version pinned.
          const pinned = { type: "npm" as const, name: "npm-hello", version: "1.0.0" };
          assert.deepStrictEqual((yield* installer.install(pinned)).installSource, pinned);
          const tampered = yield* installer
            .install({ type: "npm", name: "npm-tampered" })
            .pipe(Effect.flip);
          assert.match(tampered.message, /integrity/);
          assert.deepStrictEqual((yield* fs.readDirectory(`${stateDir}/plugins`)).toSorted(), [
            "npm-hello",
          ]);
        }).pipe(Effect.provide(layerHost().pipe(Layer.provide(layerCopies))));
      }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("installs a dropped folder and lists folders put in the plugins folder, off", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const helloFiles = yield* Effect.forEach(["t3-plugin.json", "server.cjs"], (name) =>
        fs
          .readFile(`${fixturesDir}hello-plugin/${name}`)
          .pipe(Effect.map((contents) => ({ path: name, contents }))),
      );
      const notesManifest = (version: string) =>
        JSON.stringify({ id: "notes", name: "Notes", version, engines: { t3: ">=0.1.0" } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, {});
        // The docs point people at the plugins folder, so a rescan makes sure it exists.
        yield* host.rescan;
        assert.isTrue(yield* fs.exists(`${stateDir}/plugins`));

        const installed = yield* installer.installFiles(helloFiles);
        assert.include(installed, { id: hello, status: "active", enabled: true });
        assert.isUndefined(installed.installSource);
        // The same folder dropped again replaces it.
        const replaced = yield* installer.installFiles(helloFiles);
        assert.notStrictEqual(replaced.revision, installed.revision);

        // Copied in by hand under any name, a plugin is listed on the next rescan, turned off.
        yield* writeFile(`${stateDir}/plugins/My Notes/t3-plugin.json`, notesManifest("1.0.0"));
        const { plugins } = yield* host.rescan;
        assert.include(stateOf(plugins, "notes"), { status: "disabled", enabled: false });
        // A new version copied over one that is off is what Settings lists and what starts.
        yield* writeFile(`${stateDir}/plugins/My Notes/t3-plugin.json`, notesManifest("1.0.5"));
        assert.include(stateOf((yield* host.rescan).plugins, "notes"), { version: "1.0.5" });

        // A dropped folder replaces a plugin copied in by hand, in the folder it was copied to.
        yield* installer.installFiles([
          { path: "t3-plugin.json", contents: new TextEncoder().encode(notesManifest("1.1.0")) },
        ]);
        assert.include(stateOf(yield* host.list, "notes"), { version: "1.1.0", enabled: false });
        assert.deepStrictEqual((yield* fs.readDirectory(`${stateDir}/plugins`)).toSorted(), [
          "My Notes",
          "hello-plugin",
        ]);
        yield* installer.uninstall(PluginId.make("notes"), false);
        assert.isFalse(yield* fs.exists(`${stateDir}/plugins/My Notes`));
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("puts the working version back when its update fails to start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugin-upgrade-" });
      yield* writeUpgradeVersion(folder, "1.0.0");
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, {});
        yield* installer.install({ type: "path", path: folder });
        yield* writeUpgradeVersion(folder, "2.0.0", {
          activate: `throw new Error("2.0.0 refuses to start");`,
        });
        const failed = yield* installer.update(upgrade).pipe(Effect.flip);
        assert.strictEqual(
          failed.message,
          "Upgrade 2.0.0 failed to start, so 1.0.0 is back. It failed with: 2.0.0 refuses to start",
        );
        assert.include(stateOf(yield* host.list, upgrade), { version: "1.0.0", status: "active" });
        assert.notInclude(
          yield* fs.readFileString(`${stateDir}/plugins/upgrade/server.cjs`),
          "refuses to start",
        );
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("keeps the version an update replaced, so the user can roll back to it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugin-upgrade-" });
      const kept = `${stateDir}/plugin-rollback/upgrade`;
      yield* writeUpgradeVersion(folder, "1.0.0");
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, {});
        assert.isUndefined(
          (yield* installer.install({ type: "path", path: folder })).rollbackVersion,
        );
        yield* writeUpgradeVersion(folder, "2.0.0");
        assert.include(yield* installer.update(upgrade), {
          version: "2.0.0",
          rollbackVersion: "1.0.0",
        });

        const rolledBack = yield* installer.rollback(upgrade);
        assert.include(rolledBack, { version: "1.0.0", status: "active" });
        assert.isUndefined(rolledBack.rollbackVersion);
        assert.isFalse(yield* fs.exists(kept));
        const again = yield* installer.rollback(upgrade).pipe(Effect.flip);
        assert.strictEqual(again.message, "upgrade has no earlier version to roll back to.");

        // Removing the plugin removes the version it kept.
        yield* installer.update(upgrade);
        assert.isTrue(yield* fs.exists(kept));
        yield* installer.uninstall(upgrade, false);
        assert.isFalse(yield* fs.exists(kept));
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("keeps server folder paths from clients that cannot manage plugins", () =>
    Effect.gen(function* () {
      const linkedFolder = `${fixturesDir}broken-plugin`;
      yield* writePluginsConfig({ devPaths: [linkedFolder] });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, { [broken]: "disabled" });
        const source = { type: "path" as const, path: `${fixturesDir}hello-plugin` };
        yield* installer.install(source);
        const listed = (scopes: ReadonlyArray<AuthEnvironmentScope>) => {
          const handlers = makePluginRpcHandlers(host, installer, scopes);
          return Effect.all([
            handlers[WS_METHODS.pluginsList]({}),
            handlers[WS_METHODS.pluginsSubscribeStates]({}).pipe(
              Stream.runHead,
              Effect.map((first) =>
                applyPluginStatesEvent({ plugins: [] }, Option.getOrThrow(first)),
              ),
            ),
          ]).pipe(Effect.map((results) => results.flatMap((result) => result.plugins)));
        };

        for (const plugin of yield* listed([AuthOrchestrationReadScope])) {
          assert.notProperty(plugin, "linkedFolder");
          assert.notProperty(plugin, "installSource");
        }
        const managed = yield* listed([AuthOrchestrationReadScope, AuthSettingsWriteScope]);
        assert.include(stateOf(managed, broken), { linkedFolder });
        assert.deepStrictEqual(stateOf(managed, hello)?.installSource, source);
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("sends a client only the plugins that changed after the first list", () =>
    Effect.gen(function* () {
      yield* writePluginsConfig({
        enabled: { [hello]: true },
        devPaths: [`${fixturesDir}broken-plugin`, `${fixturesDir}hello-plugin`],
      });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { [hello]: "active", [broken]: "disabled" });
        const disabled = (event: PluginStatesEvent) =>
          event._tag === "changed" &&
          event.rows.some(({ plugin }) => plugin.id === hello && plugin.status === "disabled");
        const events = yield* host
          .streamForClient(operate)
          .pipe(
            Stream.takeUntil(disabled),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true }),
          );
        yield* host.setEnabled(hello, false);
        const [first, ...changes] = yield* Fiber.join(events);
        assert.strictEqual(first?._tag, "snapshot");
        for (const change of changes) {
          assert.deepStrictEqual(
            change._tag === "changed" ? change.rows.map(({ plugin }) => plugin.id) : [],
            [hello],
          );
        }
        const folded = [first!, ...changes].reduce(applyPluginStatesEvent, { plugins: [] });
        assert.deepStrictEqual(folded, yield* host.listForClient(operate));
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("lists and deletes the data of plugins removed without it", () =>
    Effect.gen(function* () {
      const host = yield* PluginHost.PluginHost;
      const installer = yield* PluginInstaller.PluginInstaller;
      const storage = yield* PluginStorage.PluginStorage;
      const settings = yield* PluginSettingsStore.PluginSettingsStore;
      yield* waitForStatuses(host, {});
      yield* installer.install({ type: "path", path: `${fixturesDir}hello-plugin` });
      yield* host.updateSettings(hello, { greeting: "hey" });
      yield* storage.set(hello, "visits", 2);
      assert.deepStrictEqual(yield* installer.leftoverData, []);
      const refused = yield* installer.deleteLeftoverData(hello).pipe(Effect.flip);
      assert.strictEqual(
        refused.message,
        "hello-plugin is installed. Remove it with its data to delete its data.",
      );

      yield* installer.uninstall(hello, false);
      assert.deepStrictEqual(yield* installer.leftoverData, [
        { pluginId: hello, settings: true, storageKeys: (yield* storage.list(hello)).length },
      ]);
      assert.deepStrictEqual(yield* installer.deleteLeftoverData(hello), []);
      assert.deepStrictEqual(yield* storage.list(hello), []);
      assert.deepStrictEqual(yield* settings.getForClient(hello, undefined), {});
    }).pipe(Effect.provide(layerHost().pipe(Layer.provide(layerConfig())))),
  );

  it.effect("deletes the secrets of settings fields a newer version no longer has", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugin-upgrade-" });
      const secret = { type: "string", format: "t3-secret" };
      const withToken = {
        type: "object",
        properties: { token: secret, key: secret },
      } satisfies Schema.JsonObject;
      yield* writeUpgradeVersion(folder, "1.0.0", { settingsSchema: withToken });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        const settings = yield* PluginSettingsStore.PluginSettingsStore;
        yield* waitForStatuses(host, {});
        yield* installer.install({ type: "path", path: folder });
        yield* host.updateSettings(upgrade, { token: "old-token", key: "kept-key" });
        yield* writeUpgradeVersion(folder, "2.0.0", {
          settingsSchema: { type: "object", properties: { key: secret } },
        });
        yield* installer.update(upgrade);
        // Read with the old schema, which still names both fields.
        assert.deepStrictEqual(yield* settings.get(upgrade, withToken), { key: "kept-key" });
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("refuses an update that needs a newer T3 Code before stopping the version in use", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugin-upgrade-" });
      yield* writeUpgradeVersion(folder, "1.0.0");
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, {});
        const installed = yield* installer.install({ type: "path", path: folder });
        yield* writeUpgradeVersion(folder, "2.0.0", { engines: ">=999.0.0" });
        const refused = yield* installer.update(upgrade).pipe(Effect.flip);
        assert.strictEqual(
          refused.message,
          `Upgrade 2.0.0 needs T3 Code >=999.0.0, and this server is ${packageJson.version}.`,
        );
        const kept = stateOf(yield* host.list, upgrade);
        assert.include(kept, { version: "1.0.0", status: "active" });
        // Never stopped: the same start keeps running.
        assert.strictEqual(kept?.revision, installed.revision);
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("does not offer an update that needs a newer T3 Code", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      yield* writeInstalledPlugin("npm-future", "module.exports = { activate() {} };");
      yield* writeFile(
        `${stateDir}/plugins.json`,
        JSON.stringify({
          sources: { "npm-future": { type: "npm", name: "npm-future" } },
          installed: { "npm-future": "1.0.0" },
        }),
      );
      npmLatest = "1.1.0";
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, { "npm-future": "disabled" });
        assert.isUndefined(stateOf(yield* installer.checkUpdates, "npm-future")?.availableUpdate);
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("checks installed plugins for updates once a day, not at startup", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      yield* writeInstalledPlugin("npm-hello", "module.exports = { activate() {} };");
      yield* writeFile(
        `${stateDir}/plugins.json`,
        JSON.stringify({
          enabled: { "npm-hello": true },
          sources: { "npm-hello": { type: "npm", name: "npm-hello" } },
          installed: { "npm-hello": "1.0.0" },
          updates: { checkedAt: 0, available: {} },
        }),
      );
      npmLatest = "1.1.0";
      npmMetadataRequests = 0;
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { "npm-hello": "active" });
        assert.strictEqual(npmMetadataRequests, 0);

        const found = yield* host.streamStates.pipe(
          Stream.filter((states) => stateOf(states, "npm-hello")?.availableUpdate !== undefined),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust("24 hours");
        assert.deepStrictEqual(
          stateOf(Option.getOrThrow(yield* Fiber.join(found)), "npm-hello")?.availableUpdate,
          { version: "1.1.0" },
        );
        // Once for the latest version, once more to download it and read its engines.
        assert.strictEqual(npmMetadataRequests, 2);
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("restores a version an interrupted install left in staging", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const previous = `${stateDir}/plugin-staging/crashed/previous`;
      yield* writeFile(
        `${previous}/t3-plugin.json`,
        JSON.stringify({
          id: "stranded",
          name: "Stranded",
          version: "0.1.0",
          engines: { t3: ">=0.1.0" },
        }),
      );
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { stranded: "disabled" });
        assert.isTrue(yield* fs.exists(`${stateDir}/plugins/stranded/t3-plugin.json`));
        assert.isFalse(yield* fs.exists(`${stateDir}/plugin-staging/crashed`));
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("runs a plugin's work at a time of day on its weekdays until it cancels", () =>
    Effect.gen(function* () {
      const reminders = PluginId.make("schedule-plugin");
      yield* writePluginsConfig({
        enabled: { [reminders]: true },
        devPaths: [`${fixturesDir}schedule-plugin`],
      });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { [reminders]: "active" });
        const call = (method: string, input?: Schema.Json) =>
          host.invoke({ pluginId: reminders, method, input, scopes: operate });
        assert.include(
          (yield* Effect.flip(call("remindAt", { time: "25:00" }))).message,
          "schedule.at needs a time such as 09:30",
        );

        // An hour from now in the server's time zone, on that day's weekday only.
        const due = DateTime.toParts(
          DateTime.add(yield* DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone), {
            hours: 1,
          }),
        );
        const pad = (value: number) => String(value).padStart(2, "0");
        yield* call("remindAt", {
          time: `${pad(due.hour)}:${pad(due.minute)}`,
          weekdays: [due.weekDay],
        });
        const published = yield* Queue.unbounded<Schema.Json>();
        yield* host.subscribe({ pluginId: reminders, channel: "reminders" }).pipe(
          Stream.runForEach((value) => Queue.offer(published, value)),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust("1 hour");
        assert.strictEqual(yield* Queue.take(published), 1);
        yield* TestClock.adjust("7 days");
        assert.strictEqual(yield* Queue.take(published), 2);

        assert.strictEqual(yield* call("stopReminders"), 2);
        yield* TestClock.adjust("7 days");
        assert.strictEqual(yield* call("stopReminders"), 2);
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("asks the user for a secret in a thread and hands the plugin the value once", () =>
    Effect.gen(function* () {
      const secrets = PluginId.make("secrets-plugin");
      const threadId = ThreadId.make("thread:plugin-secret");
      const projectId = ProjectId.make("project:plugin-secret");
      yield* writePluginsConfig({
        enabled: { [secrets]: true },
        devPaths: [`${fixturesDir}secrets-plugin`],
      });
      // The thread as orchestration would record it: one running turn and the card on it.
      let runStatus = "running";
      let card: { readonly id: TurnItemId; readonly secretStatus: string } | undefined;
      const asked = yield* Deferred.make<TurnItemId>();
      const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () =>
          Effect.sync(
            () =>
              ({
                thread: { projectId },
                runs: [
                  { id: "run:secret", ordinal: 1, status: runStatus, rootNodeId: "node:root" },
                ],
                turnItems:
                  card === undefined
                    ? []
                    : [
                        {
                          ...card,
                          runId: "run:secret",
                          nodeId: "node:root",
                          type: "secret_request",
                        },
                      ],
              }) as never,
          ),
        dispatch: (command) =>
          Effect.gen(function* () {
            if (command.type === "secret_request.record" && card?.secretStatus !== "saved") {
              card = { id: command.turnItemId, secretStatus: command.secretStatus };
              if (command.secretStatus === "pending") yield* Deferred.succeed(asked, card.id);
            }
            return { sequence: 1, storedEvents: [] } as never;
          }),
      });
      const secretRequests = yield* Effect.service(SecretRequests.SecretRequests).pipe(
        Effect.provide(
          SecretRequests.layer.pipe(
            Layer.provide(Layer.mergeAll(threads, ServerSecretStore.layer)),
          ),
        ),
      );
      const services = Layer.mergeAll(
        layerUnusedServices,
        threads,
        Layer.succeed(SecretRequests.SecretRequests, secretRequests),
      );
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { [secrets]: "active" });
        const ask = host.invoke({
          pluginId: secrets,
          method: "askToken",
          input: { threadId },
          scopes: operate,
        });
        const asking = yield* ask.pipe(Effect.forkChild({ startImmediately: true }));
        // The user answers on the card, as a client does.
        const turnItemId = yield* Deferred.await(asked);
        yield* secretRequests.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "tok_staging" },
        });
        yield* TestClock.adjust("1 second");
        assert.deepStrictEqual(yield* Fiber.join(asking), { saved: "tok_staging" });
        assert.isTrue(Option.isNone(yield* secretRequests.savedRef({ threadId, turnItemId })));

        runStatus = "completed";
        assert.include((yield* Effect.flip(ask)).message, "has no turn in progress");
      }).pipe(Effect.provide(layerHost(services)));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("sends a client that connects during startup one empty list, not two", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Holds startup inside its lock, as it lists the plugins folder.
      const layerHeldStartup = layerFileSystemWith((fs) => ({
        readDirectory: (target, options) =>
          target.endsWith("/plugins")
            ? Deferred.succeed(reached, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(fs.readDirectory(target, options)),
              )
            : fs.readDirectory(target, options),
      }));
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* Deferred.await(reached);
        const lists = yield* host.streamStates.pipe(
          Stream.map((states) => states.map((state) => state.id)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(release, undefined);
        // Waits for startup's lock, so startup has published whatever it does by then.
        yield* host.rescan;
        yield* writeFile(`${stateDir}/plugins/late/t3-plugin.json`, manifestJson("late"));
        yield* host.rescan;
        assert.deepStrictEqual(yield* Fiber.join(lists), [[], ["late"]]);
      }).pipe(Effect.provide(layerHost().pipe(Layer.provide(layerHeldStartup))));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("does not load a disabled plugin at startup", () =>
    Effect.gen(function* () {
      const rootDir = yield* writeInstalledPlugin(
        "dormant",
        `require("node:fs").writeFileSync(__dirname + "/loaded", "");
module.exports = { activate() {} };`,
      );
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const states = yield* waitForStatuses(host, { dormant: "disabled" });
        assert.include(stateOf(states, "dormant"), { enabled: false, hasServer: true });
        const fs = yield* FileSystem.FileSystem;
        assert.isFalse(yield* fs.exists(`${rootDir}/loaded`));
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect(
    "finishes starting before a slow plugin finishes activating, and a rescan meanwhile keeps it",
    () =>
      Effect.gen(function* () {
        const gate = Promise.withResolvers<void>();
        const cleanupStarted = Promise.withResolvers<void>();
        const cleanupGate = Promise.withResolvers<void>();
        Reflect.set(globalThis, "__t3PluginHostTestGate", gate.promise);
        Reflect.set(globalThis, "__t3PluginHostCleanupStarted", cleanupStarted.resolve);
        Reflect.set(globalThis, "__t3PluginHostCleanupGate", cleanupGate.promise);
        yield* writeInstalledPlugin(
          "slow",
          `module.exports = { activate(api) {
  api.rpc.register("ping", () => "pong", { access: "read" });
  return globalThis.__t3PluginHostTestGate;
} };`,
        );
        const goes = yield* writeInstalledPlugin(
          "goes",
          `module.exports = { activate(api) {
  api.onDeactivate(() => { globalThis.__t3PluginHostCleanupStarted(); return globalThis.__t3PluginHostCleanupGate; });
} };`,
        );
        yield* writePluginsConfig({ enabled: { slow: true, goes: true } });
        yield* Effect.gen(function* () {
          const host = yield* PluginHost.PluginHost;
          const fs = yield* FileSystem.FileSystem;
          yield* waitForStatuses(host, { slow: "loading", goes: "active" });

          // The rescan stops the removed plugin while the slow one finishes starting.
          yield* fs.remove(goes, { recursive: true });
          const rescanning = yield* host.rescan.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.promise(() => cleanupStarted.promise);
          gate.resolve();
          yield* waitForStatuses(host, { slow: "active" });
          cleanupGate.resolve();
          yield* Fiber.join(rescanning);

          assert.strictEqual(stateOf(yield* host.list, "slow")?.status, "active");
          assert.strictEqual(
            yield* host.invoke({
              pluginId: PluginId.make("slow"),
              method: "ping",
              input: undefined,
              scopes: operate,
            }),
            "pong",
          );
        }).pipe(Effect.provide(layerHost()));
        Reflect.deleteProperty(globalThis, "__t3PluginHostTestGate");
        Reflect.deleteProperty(globalThis, "__t3PluginHostCleanupStarted");
        Reflect.deleteProperty(globalThis, "__t3PluginHostCleanupGate");
      }).pipe(Effect.provide(layerConfig())),
  );
});

it.live("lists a project's git worktrees for a plugin", () =>
  Effect.gen(function* () {
    const worktrees = PluginId.make("worktrees-plugin");
    const projectId = ProjectId.make("project:plugin-worktrees");
    yield* writePluginsConfig({
      enabled: { [worktrees]: true },
      devPaths: [`${fixturesDir}worktrees-plugin`],
    });
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-worktrees-" });
    const repo = `${parent}/repo`;
    yield* fs.makeDirectory(repo);
    const git = (...args: ReadonlyArray<string>) =>
      NodeChildProcess.execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git(
      "-c",
      "user.email=t@t.test",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    git("worktree", "add", "-q", "-b", "feature", `${parent}/feature`);
    git("worktree", "add", "-q", "--detach", `${parent}/detached`);
    git("worktree", "add", "-q", "-b", "gone", `${parent}/gone`);
    yield* fs.remove(`${parent}/gone`, { recursive: true });
    const services = Layer.mergeAll(
      layerUnusedServices,
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            id === projectId ? Option.some({ workspaceRoot: repo } as Project) : Option.none(),
          ),
      }),
      Layer.succeed(GitVcsDriver.GitVcsDriver, yield* GitVcsDriver.make),
    );
    yield* Effect.gen(function* () {
      const host = yield* PluginHost.PluginHost;
      yield* waitForStatuses(host, { [worktrees]: "active" });
      // The main checkout comes first, then the rest by path; a detached one has no branch, and a
      // removed one is left out.
      assert.deepStrictEqual(
        yield* host.invoke({
          pluginId: worktrees,
          method: "branches",
          input: { projectId },
          scopes: operate,
        }),
        ["main", null, "feature"],
      );
    }).pipe(Effect.provide(layerHost(services)));
  }).pipe(Effect.provide(layerConfig()), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("refuses git URLs that fetch code unencrypted", () =>
  Effect.gen(function* () {
    const installer = yield* PluginInstaller.PluginInstaller;
    for (const [url, scheme] of [
      ["http://127.0.0.1:1/plugin.git", "http"],
      ["GIT://127.0.0.1:1/plugin.git", "git"],
    ] as const) {
      const failed = yield* installer.install({ type: "git", url }).pipe(Effect.flip);
      assert.strictEqual(
        failed.message,
        `${scheme}:// URLs are not encrypted, so anyone on the network could change the plugin's code. Use an https or ssh URL.`,
      );
    }
  }).pipe(
    Effect.provide(
      layerHost().pipe(Layer.provideMerge(layerConfig()), Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);

it.live("keeps a git URL's credentials out of a failed install's reason", () =>
  Effect.gen(function* () {
    const installer = yield* PluginInstaller.PluginInstaller;
    // Older git versions print `user:token@host` for a URL they cannot reach.
    const failed = yield* installer
      .install({ type: "git", url: "https://ash:secret-token@127.0.0.1:1/plugin.git" })
      .pipe(Effect.flip);
    assert.match(failed.message, /^git clone failed: /);
    assert.notInclude(failed.message, "secret-token");
  }).pipe(
    Effect.provide(
      layerHost().pipe(Layer.provideMerge(layerConfig()), Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);
