// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

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
  WS_METHODS,
} from "@t3tools/contracts";
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
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import packageJson from "../../package.json" with { type: "json" };
import * as PluginHost from "./PluginHost.ts";
import * as PluginHttpRoutes from "./PluginHttpRoutes.ts";
import * as PluginInstaller from "./PluginInstaller.ts";
import { makePluginRpcHandlers } from "./pluginRpcHandlers.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";

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

// Every list of theme folders the host published, for the theme cases.
const publishedThemeDirectories: Array<ReadonlyArray<string>> = [];
const layerThemes = Layer.mock(EnvironmentTheme.EnvironmentThemeService)({
  setPluginThemeDirectories: (directories) =>
    Effect.sync(() => {
      publishedThemeDirectories.push(directories);
    }),
});

const layerHost = (services: typeof layerUnusedServices = layerUnusedServices) =>
  Layer.fresh(
    PluginHost.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(PluginSettingsStore.layer, PluginStorage.layer)),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(services),
      Layer.provide(layerThemes),
      Layer.provideMerge(PluginHttpRoutes.layer),
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

const manifestJson = (id: string, options: { readonly version?: string } = {}) =>
  JSON.stringify({
    id,
    name: id,
    version: options.version ?? "0.1.0",
    engines: { t3: ">=0.1.0" },
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

interface Workbench {
  readonly host: PluginHost.PluginHost["Service"];
  readonly call: (
    method: string,
    input?: Schema.Json,
  ) => ReturnType<PluginHost.PluginHost["Service"]["invoke"]>;
}

/** Runs `body` with the workbench fixture plugin active, in an environment with no threads or projects. */
const withWorkbench = Effect.fn(function* <A, E>(
  body: (workbench: Workbench) => Effect.Effect<A, E>,
) {
  const services = Layer.mergeAll(
    layerUnusedLaunchServices,
    Layer.mock(Orchestrator.OrchestratorV2)({ streamStoredEventsFrom: () => Stream.never }),
    Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
      latestAgentSequence: () => Effect.succeed(0),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      listProjectThreads: () => Effect.succeed([]),
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
    Layer.mock(ServerSettings.ServerSettingsService)({}),
  );
  yield* writePluginsConfig({
    enabled: { [workbench]: true },
    devPaths: [`${fixturesDir}workbench-plugin`],
  });
  return yield* Effect.gen(function* () {
    const host = yield* PluginHost.PluginHost;
    yield* waitForStatuses(host, { [workbench]: "active" });
    return yield* body({
      host,
      call: (method, input) => host.invoke({ pluginId: workbench, method, input, scopes: operate }),
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

  it.effect("unlinks a plugin loaded from devPaths and leaves its folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const inUse = `${stateDir}/checkout/linked`;
      const shadow = `${stateDir}/checkout/linked-copy`;
      yield* writeFile(`${inUse}/t3-plugin.json`, manifestJson("linked"));
      yield* writeFile(`${shadow}/t3-plugin.json`, manifestJson("linked", { version: "0.2.0" }));
      yield* writePluginsConfig({ enabled: { linked: true }, devPaths: [inUse, shadow] });
      const readConfig = fs
        .readFileString(`${stateDir}/plugins.json`)
        .pipe(Effect.map((raw): Record<string, unknown> => JSON.parse(raw)));
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        const linked = PluginId.make("linked");
        yield* waitForStatuses(host, { linked: "active" });
        const copies = () =>
          host.list.pipe(
            Effect.map((states) =>
              states
                .filter((state) => state.id === linked)
                .map(({ linkedFolder, status }) => ({ linkedFolder, status })),
            ),
          );
        assert.deepStrictEqual(yield* copies(), [
          { linkedFolder: inUse, status: "active" },
          { linkedFolder: shadow, status: "failed" },
        ]);
        // A dropped folder cannot replace a linked one, which is the author's own.
        const refused = yield* installer
          .installFiles([
            { path: "t3-plugin.json", contents: new TextEncoder().encode(manifestJson("linked")) },
          ])
          .pipe(Effect.flip);
        assert.include(refused.message, "Unlink it first.");

        // Unlinking the shadowed copy keeps the one in use running, and its data with it.
        const keepsData = yield* installer.uninstall(linked, true, shadow).pipe(Effect.flip);
        assert.include(keepsData.message, "Unlink it without removing data.");
        yield* installer.uninstall(linked, false, shadow);
        assert.deepStrictEqual(yield* copies(), [{ linkedFolder: inUse, status: "active" }]);
        assert.deepStrictEqual((yield* readConfig).devPaths, [inUse]);

        yield* installer.uninstall(linked, false);
        assert.deepStrictEqual(yield* copies(), []);
        assert.deepStrictEqual(yield* readConfig, { enabled: {}, devPaths: [] });
        assert.isTrue(yield* fs.exists(`${inUse}/t3-plugin.json`));
        assert.isTrue(yield* fs.exists(`${shadow}/t3-plugin.json`));
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("lists plugin code that fails outside a call instead of stopping the server", () =>
    Effect.gen(function* () {
      yield* writeInstalledPlugin(
        "leaky",
        `module.exports = { activate(api) {
  api.rpc.register("throwLater", () => { setTimeout(() => { throw new Error("thrown in a timer"); }, 0); }, { access: "read" });
  api.rpc.register("awaitLater", () => { setTimeout(async () => { await api.threads.read("thread:gone"); }, 0); }, { access: "read" });
  api.rpc.register("spawnMissing", () => { require("node:child_process").spawn("t3-plugin-test-missing-command"); }, { access: "read" });
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
        // The same folder dropped again replaces it.
        const replaced = yield* installer.installFiles(helloFiles);
        assert.notStrictEqual(replaced.revision, installed.revision);
        // One that needs a newer T3 is refused, and the version in use keeps running.
        const refused = yield* installer
          .installFiles([
            {
              path: "t3-plugin.json",
              contents: new TextEncoder().encode(
                JSON.stringify({
                  id: hello,
                  name: "Hello",
                  version: "9.0.0",
                  engines: { t3: ">=999.0.0" },
                }),
              ),
            },
          ])
          .pipe(Effect.flip);
        assert.include(refused.message, "needs T3 Code >=999.0.0");
        assert.include(stateOf(yield* host.list, hello), { status: "active" });

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

  it.effect("keeps server folder paths from clients that cannot manage plugins", () =>
    Effect.gen(function* () {
      const linkedFolder = `${fixturesDir}broken-plugin`;
      yield* writePluginsConfig({ devPaths: [linkedFolder] });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, { [broken]: "disabled" });
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
        }
        const managed = yield* listed([AuthOrchestrationReadScope, AuthSettingsWriteScope]);
        assert.include(stateOf(managed, broken), { linkedFolder });
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
      const fs = yield* FileSystem.FileSystem;
      const host = yield* PluginHost.PluginHost;
      const installer = yield* PluginInstaller.PluginInstaller;
      const storage = yield* PluginStorage.PluginStorage;
      const settings = yield* PluginSettingsStore.PluginSettingsStore;
      yield* waitForStatuses(host, {});
      const helloFiles = yield* Effect.forEach(["t3-plugin.json", "server.cjs"], (name) =>
        fs
          .readFile(`${fixturesDir}hello-plugin/${name}`)
          .pipe(Effect.map((contents) => ({ path: name, contents }))),
      );
      yield* installer.installFiles(helloFiles);
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
