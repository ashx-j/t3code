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
  type PluginStatesEvent,
  type Project,
  ProviderInstanceId,
  type ServerProvider,
  WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
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
import * as PluginHooks from "./PluginHooks.ts";
import * as PluginHost from "./PluginHost.ts";
import {
  fixturesDir,
  layerConfig,
  layerFileSystemWith,
  layerHost,
  layerUnusedServices,
  stateOf,
  waitForStatuses,
  writeFile,
  writeInstalledPlugin,
  writePluginsConfig,
} from "./pluginHostTestHarness.ts";
import * as PluginHttpRoutes from "./PluginHttpRoutes.ts";
import * as PluginInstaller from "./PluginInstaller.ts";
import { makePluginRpcHandlers } from "./pluginRpcHandlers.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";

// None of these messages replays an accepted command.
const notAccepted = Effect.succeed(false);
const hello = PluginId.make("hello-plugin");
const broken = PluginId.make("broken-plugin");
const operate = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] as const;

const upgrade = PluginId.make("upgrade");
/** Version `version` of the `upgrade` plugin in `folder`, whose `activate` runs `activate`. */
const writeUpgradeVersion = Effect.fn(function* (
  folder: string,
  version: string,
  options: {
    readonly activate?: string;
    readonly engines?: string;
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
    }),
  );
  yield* writeFile(
    `${folder}/server.cjs`,
    `module.exports = { activate() { ${options.activate ?? ""} } };`,
  );
});

const workbench = PluginId.make("workbench-plugin");
const workbenchThread = ThreadId.make("thread:plugin-workbench");
const workbenchProject = ProjectId.make("project:plugin-workbench");
const workbenchModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };

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
}

/**
 * Runs `body` with the workbench fixture plugin active, over a project and a thread, and services
 * that record what the plugin asks of them.
 */
const withWorkbench = Effect.fn(function* <A, E>(
  body: (workbench: Workbench) => Effect.Effect<A, E>,
) {
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
    ServerSettings.layerTest().pipe(Layer.orDie),
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
      const cursorKey = "t3.turns.afterRunCompleted.steps";
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

        yield* installer.uninstall(id);
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
        yield* installer.uninstall(id, folder);
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
        yield* installer.uninstall(id);
        yield* installer.install({ type: "path", path: folder, link: true });
        yield* writeInstalledPlugin("in-place", plugin("installed"));
        yield* host.reload(id);
        yield* installer.uninstall(id);
        const left = (yield* host.list).filter((state) => state.id === "in-place");
        assert.deepStrictEqual(
          left.map((state) => [state.source, state.status, state.failure]),
          [["dev", "disabled", undefined]],
        );
        yield* host.setEnabled(id, true);
        assert.strictEqual(yield* which, "v2");

        const notLinked = yield* installer.uninstall(id, `${stateDir}/elsewhere`).pipe(Effect.flip);
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
        yield* installer.uninstall(threeCopies);
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
        `let sends = 0;
module.exports = { activate(api) {
  api.rpc.register("throwLater", () => { setTimeout(() => { throw new Error("thrown in a timer"); }, 0); }, { access: "read" });
  api.rpc.register("awaitLater", () => { setTimeout(async () => { await api.threads.read("thread:gone"); }, 0); }, { access: "read" });
  api.rpc.register("spawnMissing", () => { require("node:child_process").spawn("t3-plugin-test-missing-command"); }, { access: "read" });
  api.turns.beforeDispatch(() => { sends += 1; throw new Error("send hook failed " + sends); });
  api.onDeactivate(() => { setTimeout(() => { throw new Error("left running"); }, 0); });
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
        const send = hooks.beforeDispatch(
          {
            threadId: ThreadId.make("thread:leaky"),
            messageId: "message:leaky",
            text: "Fix it",
            createdBy: "user",
            creationSource: "web",
            attachments: [],
          },
          notAccepted,
        );
        const failures = yield* host.streamStates.pipe(
          Stream.map((states) => stateOf(states, id)?.serverFailure),
          Stream.changes,
          Stream.takeUntil((failure) => failure === "send hook failed 3"),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* send;
        yield* nextFailure(spawned);
        yield* send;
        yield* send;
        yield* TestClock.adjust("5 seconds");
        assert.deepStrictEqual(yield* Fiber.join(failures), [
          spawned,
          "send hook failed 1",
          "send hook failed 3",
        ]);

        // Code a turned-off plugin left running still fails onto its row, which says so.
        yield* TestClock.adjust("5 seconds");
        const leftover = yield* host
          .setEnabled(id, false)
          .pipe(Effect.andThen(nextFailure("send hook failed 3")));
        assert.strictEqual(leftover, "left running");
        assert.include(stateOf(yield* host.list, id), { enabled: false, status: "disabled" });

        // A failure while starting belongs to that start, so Disable clears it.
        const starting = PluginId.make("leaky-start");
        assert.include(stateOf(yield* host.list, starting), {
          serverFailure: "thrown while starting",
        });
        assert.isUndefined((yield* host.setEnabled(starting, false)).serverFailure);
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("keeps the web failure a client reports for a plugin's current start", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      yield* writeFile(
        `${stateDir}/plugins/web-only/t3-plugin.json`,
        JSON.stringify({
          id: "web-only",
          name: "Web only",
          version: "0.1.0",
          engines: { t3: ">=0.1.0" },
          web: "./web.js",
        }),
      );
      yield* writeFile(`${stateDir}/plugins/web-only/web.js`, "export default {};");
      yield* writePluginsConfig({ enabled: { "web-only": true } });
      // Holds a publish at its skills check, which it runs for each active plugin.
      let held:
        | { readonly reached: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
        | undefined;
      const layerHeldPublish = layerFileSystemWith((fs) => ({
        exists: (target) =>
          held !== undefined && target.endsWith("skills")
            ? Deferred.succeed(held.reached, undefined).pipe(
                Effect.andThen(Deferred.await(held.release)),
                Effect.andThen(fs.exists(target)),
              )
            : fs.exists(target),
      }));
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const id = PluginId.make("web-only");
        const revision = stateOf(yield* waitForStatuses(host, { [id]: "active" }), id)?.revision;
        assert.isDefined(revision);
        const webFailure = Effect.map(host.list, (states) => stateOf(states, id)?.webFailure);
        const report = (message: string, at = revision) =>
          host.reportWebFailure({ pluginId: id, revision: at, message });

        // A client that disconnects mid-publish still gets its report to the others.
        const sent = yield* host.streamStates.pipe(
          Stream.filter((states) => stateOf(states, id)?.webFailure === "load threw"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        held = { reached: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
        const reporting = yield* report("load threw").pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(held.reached);
        const interrupting = yield* Fiber.interrupt(reporting).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(held.release, undefined);
        held = undefined;
        yield* Fiber.join(interrupting);
        yield* report("load threw");
        assert.isTrue(Option.isSome(yield* Fiber.join(sent)));

        const call = yield* host
          .invoke({ pluginId: id, method: "ping", input: undefined, scopes: operate })
          .pipe(Effect.flip);
        assert.strictEqual(
          call.message,
          "Plugin web-only has no server half, so it has no methods or channels.",
        );

        yield* report("activate threw");
        assert.strictEqual(yield* webFailure, "activate threw");
        yield* report("a part threw");
        assert.deepInclude((yield* host.check({ pluginId: id })).findings[0], {
          code: "web-failed",
          problem: "Its web half failed in the browser: a part threw",
        });
        // A restart forgets it, and a report about the earlier start is ignored.
        const reloaded = yield* host.reload(id);
        assert.isUndefined(reloaded.webFailure);
        yield* report("stale");
        assert.isUndefined(yield* webFailure);
        yield* report("fresh", reloaded.revision);
        assert.strictEqual(yield* webFailure, "fresh");
      }).pipe(Effect.provide(layerHost().pipe(Layer.provide(layerHeldPublish))));
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
          const settings = yield* PluginSettingsStore.PluginSettingsStore;
          const storage = yield* PluginStorage.PluginStorage;
          yield* waitForStatuses(host, {});
          // Agents get the plugin tools only once the user turns them on, plugins or not.
          const agentTools = Stream.runHead(host.agentTools).pipe(Effect.map(Option.getOrThrow));
          assert.isFalse(yield* agentTools);

          // A folder that is not a plugin, such as a home folder, is refused before it is copied.
          const notInstalled = yield* installer
            .install({ type: "path", path: notPlugin })
            .pipe(Effect.flip);
          assert.strictEqual(notInstalled.message, "The source has no t3-plugin.json.");
          assert.notInclude(copiedFrom, notPlugin);

          const source = { type: "path" as const, path: `${fixturesDir}hello-plugin` };
          const installed = yield* installer.install(source);
          assert.isFalse(yield* agentTools);
          yield* host.setAgentTools(true);
          assert.isTrue(yield* agentTools);
          yield* host.setAgentTools(false);
          assert.isFalse(yield* agentTools);
          // Installing the folder again, written another way, replaces it.
          const reinstalled = yield* installer.install({ ...source, path: `${source.path}/` });
          assert.include(reinstalled, { status: "active" });
          assert.notStrictEqual(reinstalled.revision, installed.revision);
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

          // Removing a plugin deletes its settings, secrets and storage with it.
          yield* host.updateSettings(hello, { greeting: "hey", token: "secret" });
          yield* storage.set(hello, "visits", 2);
          yield* installer.uninstall(hello);
          assert.isUndefined(stateOf(yield* host.list, hello));
          assert.isFalse(yield* fs.exists(`${stateDir}/plugins/hello-plugin`));
          assert.deepStrictEqual(yield* storage.list(hello), []);
          assert.deepStrictEqual(yield* settings.get(hello, installed.settingsSchema), {});

          // A plugin linked into the plugins folder: removing it removes the link, not its source.
          yield* fs.symlink(`${fixturesDir}hello-plugin`, `${stateDir}/plugins/hello-plugin`);
          yield* host.reload(hello).pipe(Effect.ignore);
          yield* installer.uninstall(hello);
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
          yield* installer.uninstall(PluginId.make("hand-copied"));

          // Installing over a disabled plugin keeps it disabled.
          yield* installer.install(source);
          yield* host.setEnabled(hello, false);
          assert.include(yield* installer.install(source), { status: "disabled", enabled: false });
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
        // The same folder dropped again replaces it.
        const replaced = yield* installer.installFiles(helloFiles);
        assert.notStrictEqual(replaced.revision, installed.revision);

        // Copied in by hand under any name, a plugin is listed on the next rescan, turned off.
        yield* writeFile(`${stateDir}/plugins/My Notes/t3-plugin.json`, notesManifest("1.0.0"));
        yield* writeFile(`${stateDir}/plugins/My Notes/skills/notes/SKILL.md`, "Notes.");
        const { plugins } = yield* host.rescan;
        assert.include(stateOf(plugins, "notes"), {
          status: "disabled",
          enabled: false,
          hasSkills: true,
        });
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
        yield* installer.uninstall(PluginId.make("notes"));
        assert.isFalse(yield* fs.exists(`${stateDir}/plugins/My Notes`));
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("puts the working version back when a new version fails to start", () =>
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
        const failed = yield* installer.install({ type: "path", path: folder }).pipe(Effect.flip);
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
                applyPluginStatesEvent(
                  { plugins: [], agentTools: false },
                  Option.getOrThrow(first),
                ),
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
        const folded = [first!, ...changes].reduce(applyPluginStatesEvent, {
          plugins: [],
          agentTools: false,
        });
        assert.deepStrictEqual(folded, yield* host.listForClient(operate));
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("refuses a version that needs a newer T3 Code before stopping the one in use", () =>
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
        const refused = yield* installer.install({ type: "path", path: folder }).pipe(Effect.flip);
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
      // Holds startup inside its lock, before it lists the plugins folder.
      const layerHeldStartup = layerFileSystemWith((fs) => ({
        remove: (target, options) =>
          target.endsWith("plugin-agents")
            ? Deferred.succeed(reached, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(fs.remove(target, options)),
              )
            : fs.remove(target, options),
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
        yield* writeFile(
          `${stateDir}/plugins/late/t3-plugin.json`,
          JSON.stringify({
            id: "late",
            name: "Late",
            version: "0.1.0",
            engines: { t3: ">=0.1.0" },
          }),
        );
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
