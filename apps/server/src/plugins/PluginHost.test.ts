import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  PluginId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type PluginState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import packageJson from "../../package.json" with { type: "json" };
import * as PluginHooks from "./PluginHooks.ts";
import * as PluginHost from "./PluginHost.ts";
import * as PluginHttpRoutes from "./PluginHttpRoutes.ts";
import * as PluginMcpTools from "./PluginMcpTools.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";

const fixturesDir = new URL("../../../../packages/plugin-sdk/fixtures/", import.meta.url).pathname;
const hello = PluginId.make("hello-plugin");
const broken = PluginId.make("broken-plugin");
const operate = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] as const;

const layerConfig = () =>
  Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-plugin-host-test-" }));

// Orchestration services the lifecycle tests never reach.
const layerUnusedServices = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ServerEnvironment.ServerEnvironment)({}),
  Layer.mock(ServerSettings.ServerSettingsService)({}),
);

// The last theme folders the host published, for the web files case.
let publishedThemeDirectories: ReadonlyArray<string> = [];
const layerThemes = Layer.mock(EnvironmentTheme.EnvironmentThemeService)({
  setPluginThemeDirectories: (directories) =>
    Effect.sync(() => {
      publishedThemeDirectories = directories;
    }),
});

const layerHost = (services: typeof layerUnusedServices = layerUnusedServices) =>
  Layer.fresh(
    PluginHost.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(PluginSettingsStore.layer, PluginStorage.layer)),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(services),
      Layer.provide(layerThemes),
      Layer.provideMerge(
        Layer.mergeAll(PluginHooks.layer, PluginMcpTools.layer, PluginHttpRoutes.layer),
      ),
    ),
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
      yield* writePluginsConfig({ enabled: { stays: true, goes: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const fs = yield* FileSystem.FileSystem;
        yield* waitForStatuses(host, { stays: "active", goes: "active" });
        yield* fs.remove(goes, { recursive: true });

        yield* host.reload(PluginId.make("stays"));

        assert.isTrue(yield* fs.exists(`${stays}/../../goes-cleaned`));
        assert.isUndefined(stateOf(yield* host.list, "goes"));
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

  it.effect("gives a plugin threads, projects, server info, schedules and send hooks", () =>
    Effect.gen(function* () {
      const workbench = PluginId.make("workbench-plugin");
      const threadId = ThreadId.make("thread:plugin-workbench");
      const dispatched: Array<OrchestrationV2ServerCommand> = [];
      const services = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamStoredEventsFrom: () => Stream.never,
        }),
        Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
          latestAgentSequence: () => Effect.succeed(0),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          listProjectThreads: () => Effect.succeed([]),
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              projectId: ProjectId.make("project:plugin-workbench"),
            } as never),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1, storedEvents: [] } as never;
            }),
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
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const hooks = yield* PluginHooks.PluginHooks;
        yield* waitForStatuses(host, { [workbench]: "active" });
        const call = (method: string, input?: Schema.Json) =>
          host.invoke({ pluginId: workbench, method, input, scopes: operate });

        assert.deepStrictEqual(yield* call("overview"), {
          version: packageJson.version,
          environment: "Workbench host",
          threads: 0,
          projects: 0,
          firstThreadId: null,
        });

        yield* call("renameThread", { threadId, title: "Renamed by a plugin" });
        assert.deepInclude(dispatched[0], {
          type: "thread.metadata.update",
          threadId,
          title: "Renamed by a plugin",
        });

        assert.strictEqual(
          yield* hooks.beforeDispatch({
            threadId,
            messageId: "message:context",
            text: "Ship it #context",
            createdBy: "user",
            attachments: [],
          }),
          "Ship it #context\n\nContext from workbench-plugin.",
        );

        const tick = yield* host
          .subscribe({ pluginId: workbench, channel: "ticks" })
          .pipe(Stream.runHead, Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("1 second");
        assert.deepStrictEqual(yield* Fiber.join(tick), Option.some(1));
      }).pipe(Effect.provide(layerHost(services)));
    }).pipe(Effect.provide(layerConfig())),
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
        assert.deepStrictEqual(publishedThemeDirectories, [`${fixturesDir}hello-web/themes`]);
        const asset = yield* routes.handle({
          pluginId: helloWeb,
          request: { ...request, path: "/assets/hello.txt" },
        });
        assert.strictEqual(asset.headers["content-type"], "text/plain; charset=utf-8");
        const escaped = yield* routes
          .handle({ pluginId: helloWeb, request: { ...request, path: "/assets/..%2Fserver.cjs" } })
          .pipe(Effect.flip);
        assert.strictEqual(escaped._tag, "PluginHttpHandlerError");

        yield* host.setEnabled(helloWeb, false);
        const missing = yield* routes.handle({ pluginId: helloWeb, request }).pipe(Effect.flip);
        assert.strictEqual(missing._tag, "PluginHttpRouteNotFoundError");
        assert.deepStrictEqual(publishedThemeDirectories, []);
      }).pipe(Effect.provide(layerHost()));
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

  it.effect("finishes starting before a slow plugin finishes activating", () =>
    Effect.gen(function* () {
      const gate = Promise.withResolvers<void>();
      Reflect.set(globalThis, "__t3PluginHostTestGate", gate.promise);
      yield* writeInstalledPlugin(
        "slow",
        `module.exports = { activate() { return globalThis.__t3PluginHostTestGate; } };`,
      );
      yield* writePluginsConfig({ enabled: { slow: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { slow: "loading" });
        gate.resolve();
        yield* waitForStatuses(host, { slow: "active" });
      }).pipe(Effect.provide(layerHost()));
      Reflect.deleteProperty(globalThis, "__t3PluginHostTestGate");
    }).pipe(Effect.provide(layerConfig())),
  );
});
