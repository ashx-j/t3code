// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  defaultInstanceIdForDriver,
  AuthOrchestrationReadScope,
  EnvironmentId,
  PluginId,
  ProjectId,
  ProviderDriverKind,
  ProviderSessionId,
  RuntimeRequestId,
  SourceControlProviderKind,
  ThreadId,
  type TurnItemId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2DomainEvent,
  type PluginState,
  type Project,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { PluginProviderDriverEnv } from "@t3tools/plugin-sdk/server/providers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
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
import * as ProviderDriverRegistration from "../provider/ProviderDriverRegistration.ts";
import { makeTurnInput } from "../orchestration-v2/Adapters/AcpAdapterV2.testkit.ts";
import { makeProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PullRequestProviderRegistry from "../pullRequest/PullRequestProviderRegistry.ts";
import * as SourceControlDrivers from "../sourceControl/builtInDrivers.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import packageJson from "../../package.json" with { type: "json" };
import { gzipTarball, tarEntry } from "./testTarball.ts";
import type { AcpAgentDriverEnv } from "./acpAgentDriver.ts";
import * as PluginHooks from "./PluginHooks.ts";
import * as PluginHost from "./PluginHost.ts";
import * as PluginHttpRoutes from "./PluginHttpRoutes.ts";
import * as PluginMcpTools from "./PluginMcpTools.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";
import { withPluginTextGeneration } from "./pluginTextGeneration.ts";

// None of these messages replays an accepted command.
const notAccepted = Effect.succeed(false);
const echoAgent = ProviderDriverKind.make("echoAgent");
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
  Layer.mock(ProviderDriverRegistration.ProviderDriverRegistration)({}),
  Layer.mock(SourceControlDrivers.SourceControlPluginDrivers)({ current: () => [] }),
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

// The last theme folders the host published, for the web files case.
let publishedThemeDirectories: ReadonlyArray<string> = [];
const layerThemes = Layer.mock(EnvironmentTheme.EnvironmentThemeService)({
  setPluginThemeDirectories: (directories) =>
    Effect.sync(() => {
      publishedThemeDirectories = directories;
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
    const body = url.endsWith(".tgz")
      ? new Response(npmTarball)
      : url.endsWith("/npm-hello")
        ? Response.json(npmDocument("npm-hello", npmIntegrity))
        : url.endsWith("/npm-tampered")
          ? Response.json(npmDocument("npm-tampered", "sha512-AAAA"))
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

  it.effect("gives agents a plugin's skills and instructions until it is disabled", () =>
    Effect.gen(function* () {
      const skills = PluginId.make("skills-plugin");
      const rootDir = `${fixturesDir}skills-plugin`;
      yield* writePluginsConfig({ enabled: { [skills]: true }, devPaths: [rootDir] });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const hooks = yield* PluginHooks.PluginHooks;
        yield* waitForStatuses(host, { [skills]: "active" });
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        // Claude loads a whole folder as a plugin, so it gets one holding only the skills.
        const agentFolder = `${stateDir}/plugin-agents/skills-plugin`;
        assert.deepStrictEqual(yield* hooks.agentContext, {
          instructions: [
            '<t3_code_plugin name="Release helper">\nWrite release notes in the past tense.\n</t3_code_plugin>',
          ],
          skillFolders: [{ plugin: agentFolder, skills: `${agentFolder}/skills` }],
        });
        assert.deepStrictEqual((yield* fs.readDirectory(agentFolder)).toSorted(), [
          ".claude-plugin",
          "skills",
        ]);
        assert.include(
          JSON.parse(yield* fs.readFileString(`${agentFolder}/.claude-plugin/plugin.json`)),
          { name: "skills-plugin" },
        );
        assert.isTrue(yield* fs.exists(`${agentFolder}/skills/release-notes/SKILL.md`));

        // The `$` picker lists the skill for the providers that receive it, by each one's name.
        const listed = PluginHooks.withPluginSkills(
          [
            {
              driver: "claudeAgent",
              skills: [],
              workspaceSnapshots: [{ cwd: "/repo", skills: [] }],
            },
            { driver: "codex", skills: [] },
            { driver: "cursor", skills: [] },
          ] as unknown as ReadonlyArray<ServerProvider>,
          yield* hooks.currentSkills,
        );
        const skill = {
          path: `${agentFolder}/skills/release-notes/SKILL.md`,
          enabled: true,
          scope: "plugin",
          displayName: "Release helper: release-notes",
          description: "Drafts release notes from the commits since the last tag.",
        };
        const claudeSkill = { name: "skills-plugin:release-notes", ...skill };
        assert.deepStrictEqual(
          listed.map((provider) => provider.skills),
          [[claudeSkill], [{ name: "release-notes", ...skill }], []],
        );
        assert.deepStrictEqual(listed[0]?.workspaceSnapshots?.[0]?.skills, [claudeSkill]);

        yield* host.setEnabled(skills, false);
        assert.isUndefined(yield* hooks.agentContext);
        assert.deepStrictEqual(yield* hooks.currentSkills, []);
        assert.isFalse(yield* fs.exists(agentFolder));
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("starts a plugin's provider driver and removes it when the plugin is turned off", () =>
    Effect.gen(function* () {
      const providerPlugin = PluginId.make("provider-plugin");
      yield* writePluginsConfig({
        enabled: { [providerPlugin]: true },
        devPaths: [`${fixturesDir}provider-plugin`],
      });
      const { registry, addDriver } = yield* makeProviderInstanceRegistry<PluginProviderDriverEnv>({
        drivers: [],
        // Saved and on, as the provider's switch in settings leaves it; unsaved defaults start off.
        configMap: {
          [defaultInstanceIdForDriver(echoAgent)]: { driver: echoAgent, enabled: true },
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            TestProviderHost.layer(),
            Layer.succeed(SecretResolver.SecretResolver, {
              read: () => Effect.succeed([]),
              invalidate: () => Effect.void,
            }),
          ),
        ),
      );
      const services = Layer.mergeAll(
        layerUnusedServices,
        Layer.succeed(ProviderDriverRegistration.ProviderDriverRegistration, {
          // Plugin drivers need only the plugin driver services this registry provides.
          add: addDriver as ProviderDriverRegistration.ProviderDriverRegistration["Service"]["add"],
        }),
      );
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        // Activation waits for the driver the fixture registers.
        yield* waitForStatuses(host, { [providerPlugin]: "active" });
        const [instance] = yield* registry.listInstances;
        assert.strictEqual(instance?.instanceId, defaultInstanceIdForDriver(echoAgent));
        const snapshot = yield* instance!.snapshot.getSnapshot;
        assert.include(snapshot, { driver: echoAgent, displayName: "Echo agent", status: "ready" });
        // Clients have no definition for a plugin's driver, so its snapshot describes its form.
        assert.deepStrictEqual(snapshot.settingsSchema, {
          type: "object",
          properties: { greeting: { type: "string", title: "Greeting" } },
        });
        assert.match(snapshot.iconUrl ?? "", /^data:image\/svg\+xml,/);

        const changes = yield* registry.subscribeChanges;
        yield* host.setEnabled(providerPlugin, false);
        yield* PubSub.take(changes);
        assert.deepStrictEqual(yield* registry.listInstances, []);
      }).pipe(Effect.provide(layerHost(services)));
    }).pipe(Effect.provide(layerConfig()), Effect.scoped),
  );

  it.effect("adds a plugin's source control host to remote recognition and pull requests", () =>
    Effect.gen(function* () {
      const sourceControlPlugin = PluginId.make("source-control-plugin");
      yield* writePluginsConfig({
        enabled: { [sourceControlPlugin]: true },
        devPaths: [`${fixturesDir}source-control-plugin`],
      });
      const pluginDrivers = yield* SourceControlDrivers.makePluginDrivers.pipe(
        Effect.provide(
          Layer.mergeAll(
            TestSourceControlHost.layer(),
            SourceControlRateLimit.layer,
            layerNpmRegistry,
          ),
        ),
      );
      const services = Layer.mergeAll(
        layerUnusedServices,
        Layer.succeed(SourceControlDrivers.SourceControlPluginDrivers, pluginDrivers),
      );
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { [sourceControlPlugin]: "active" });
        // The pull request lookup recognizes the remote, then asks that host's provider.
        const remote = "git@git.example.test:team/app.git";
        const kind = sourceControlDefinitions.recognizeRemote(remote)?.kind;
        assert.strictEqual(kind, "examplegit");
        const pullRequests = yield* PullRequestProviderRegistry.make.pipe(
          Effect.provideService(SourceControlDrivers.SourceControlDrivers, []),
          Effect.provideService(SourceControlDrivers.SourceControlPluginDrivers, pluginDrivers),
        );
        assert.deepStrictEqual(pullRequests.kinds, [SourceControlProviderKind.make("examplegit")]);
        const provider = pullRequests.get(SourceControlProviderKind.make("examplegit"));
        assert.strictEqual(
          yield* provider!.getViewer({ cwd: process.cwd(), host: "git.example.test" }),
          "example-bot",
        );

        yield* host.setEnabled(sourceControlPlugin, false);
        assert.strictEqual(sourceControlDefinitions.recognizeRemote(remote)?.kind, "unknown");
        assert.isNull(pullRequests.get(SourceControlProviderKind.make("examplegit")));
      }).pipe(Effect.provide(layerHost(services)));
    }).pipe(Effect.provide(layerConfig()), Effect.scoped),
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

  it.effect("gives a plugin threads, projects, server info, schedules, hooks and commands", () =>
    Effect.gen(function* () {
      const workbench = PluginId.make("workbench-plugin");
      const threadId = ThreadId.make("thread:plugin-workbench");
      const dispatched: Array<OrchestrationV2ServerCommand> = [];
      const responded = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
      // Approval and question events reach the plugin's runtime request hook; the records are
      // what the projection holds when each event is read.
      const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      let records = { runtimeRequests: [] as Array<unknown>, turnItems: [] as Array<unknown> };
      const projectId = ProjectId.make("project:plugin-workbench");
      const defaultModel = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.5",
      };
      const project: Project = {
        id: projectId,
        title: "Workbench project",
        workspaceRoot: "/repo",
        defaultModelSelection: defaultModel,
        scripts: [],
        createdAt: "2026-10-31T00:00:00.000Z",
        updatedAt: "2026-10-31T00:00:00.000Z",
        deletedAt: null,
      };
      const launched: Array<ThreadLaunchService.ThreadLaunchInput> = [];
      const projectUpdates: Array<unknown> = [];
      const services = Layer.mergeAll(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              launched.push(input);
              return { threadId: input.threadId } as never;
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome(project),
          update: (input) =>
            Effect.sync(() => {
              projectUpdates.push(input);
              return { ...project, pinnedAt: "2026-10-31T00:00:00.000Z" };
            }),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderDriverRegistration.ProviderDriverRegistration)({}),
        Layer.mock(SourceControlDrivers.SourceControlPluginDrivers)({ current: () => [] }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamStoredEventsFrom: () => Stream.never,
          streamDomainEvents: Stream.fromQueue(domainEvents),
          getThreadRecords: () => Effect.sync(() => records as never),
        }),
        Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
          latestAgentSequence: () => Effect.succeed(0),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          listProjectThreads: () => Effect.succeed([]),
          getThreadShell: () => Effect.succeed({ id: threadId, projectId } as never),
          settleThread: (input) =>
            Effect.sync(() => {
              dispatched.push({ type: "thread.settle", ...input } as never);
              return { sequence: 1 };
            }),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1, storedEvents: [] } as never;
            }).pipe(
              Effect.tap(() =>
                command.type === "runtime-request.respond"
                  ? Queue.offer(responded, command)
                  : Effect.void,
              ),
            ),
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

        yield* call("noteThread", { threadId });
        assert.deepInclude(dispatched[1], {
          type: "thread.notification.record",
          threadId,
          notification: {
            source: { kind: "system" },
            outcome: "completed",
            summary: "Workbench: Checked",
          },
        });

        assert.strictEqual(
          yield* hooks.beforeDispatch(
            {
              threadId,
              messageId: "message:context",
              text: "Ship it #context",
              createdBy: "user",
              attachments: [],
            },
            notAccepted,
          ),
          "Ship it #context\n\nContext from workbench-plugin.",
        );
        const outgoing = (text: string) =>
          hooks.beforeDispatch(
            {
              threadId,
              messageId: "message:workbench",
              text,
              createdBy: "user",
              attachments: [],
            },
            notAccepted,
          );
        assert.strictEqual(yield* outgoing("#shout ship it"), "SHIP IT");
        assert.strictEqual(
          (yield* Effect.flip(outgoing("Deploy with #secret"))).message,
          "Workbench: Remove the secret first.",
        );

        // The plugin's command runs instead of the send hooks, and lists with every provider's.
        assert.strictEqual(
          yield* outgoing("/deploy staging"),
          "Deploy to staging and report back.",
        );
        assert.strictEqual(
          (yield* Effect.flip(outgoing("/deploy"))).message,
          "Workbench: Name an environment, for example /deploy staging.",
        );
        assert.deepStrictEqual(yield* outgoing("/status"), {
          reply: "**staging** is up to date.",
        });
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
        const listed = [
          {
            name: "deploy",
            description: "Deploy to an environment",
            input: { hint: "environment" },
          },
          { name: "status", description: "Show the deploy status" },
        ];
        assert.deepStrictEqual(provider?.slashCommands, [{ name: "review" }, ...listed]);
        assert.deepStrictEqual(provider?.workspaceSnapshots?.[0]?.slashCommands, listed);

        const request = (id: string, kind: string) => ({
          id,
          nodeId: `node:${id}`,
          kind,
          status: "pending",
          responseCapability: {
            type: "live",
            providerSessionId: "session:workbench",
            supportsFeedback: true,
          },
        });
        const item = (requestId: string, fields: object) => ({
          id: `item:${requestId}`,
          threadId,
          runId: "run:workbench",
          requestId,
          status: "waiting",
          ...fields,
        });
        const event = (type: string, payload: object) => ({ type, threadId, payload }) as never;
        const gitStatus = item("request:git", {
          type: "approval_request",
          requestKind: "command",
          prompt: "git status --short",
        });
        const remove = item("request:rm", {
          type: "approval_request",
          requestKind: "command",
          prompt: "rm -rf build",
        });
        const question = item("request:ask", {
          type: "user_input_request",
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which files?",
              options: [
                { label: "Only src", description: "Leave tests alone" },
                { label: "Everything", description: "Touch all files" },
              ],
            },
          ],
        });

        // Claude records the request before its item, so the plugin is asked once the item lands.
        records = { runtimeRequests: [request("request:git", "command")], turnItems: [] };
        yield* Queue.offer(
          domainEvents,
          event("runtime-request.updated", records.runtimeRequests[0]!),
        );
        records = { ...records, turnItems: [gitStatus] };
        yield* Queue.offer(domainEvents, event("turn-item.updated", gitStatus));
        assert.deepInclude(yield* Queue.take(responded), {
          requestId: RuntimeRequestId.make("request:git"),
          decision: "accept",
        });

        // Codex records the item first.
        records = { runtimeRequests: [], turnItems: [remove] };
        yield* Queue.offer(domainEvents, event("turn-item.updated", remove));
        records = { ...records, runtimeRequests: [request("request:rm", "command")] };
        yield* Queue.offer(
          domainEvents,
          event("runtime-request.updated", records.runtimeRequests[0]!),
        );
        assert.deepInclude(yield* Queue.take(responded), {
          requestId: RuntimeRequestId.make("request:rm"),
          decision: "decline",
          feedback: "Workbench does not allow rm.",
        });

        records = {
          runtimeRequests: [request("request:ask", "user_input")],
          turnItems: [question],
        };
        yield* Queue.offer(domainEvents, event("turn-item.updated", question));
        assert.deepInclude(yield* Queue.take(responded), {
          requestId: RuntimeRequestId.make("request:ask"),
          answers: { scope: "Only src" },
        });

        // The plugin titles the threads it recognises and leaves the rest to T3.
        const titles = withPluginTextGeneration(hooks, {
          generateThreadTitle: () => Effect.succeed({ title: "T3 title" }),
        } as unknown as ProviderTextGeneration);
        const title = (message: string) =>
          titles.generateThreadTitle({
            cwd: "/repo",
            message,
            modelSelection: defaultModel,
          });
        assert.deepStrictEqual(yield* title("#titled Release prep"), {
          title: "Workbench: Release prep",
        });
        assert.deepStrictEqual(yield* title("Release prep"), { title: "T3 title" });

        // Thread and project management go through the commands and services clients use.
        dispatched.length = 0;
        const tidied = yield* call("tidyThread", { threadId, projectId });
        assert.deepStrictEqual(
          dispatched.map((command) => command.type),
          [
            "thread.archive",
            "thread.unarchive",
            "thread.snooze",
            "thread.unsnooze",
            "thread.settle",
            "thread.unsettle",
            "thread.delete",
          ],
        );
        assert.deepInclude(dispatched[2], { snoozedUntil: "2026-11-01T09:00:00.000Z" });
        assert.deepInclude(launched[0], {
          projectId,
          title: "Follow-up",
          modelSelection: defaultModel,
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          createdBy: "agent",
          creationSource: "server",
        });
        assert.strictEqual(launched[0]?.initialMessage?.text, "Check the deploy.");
        assert.deepInclude(projectUpdates[0], { projectId, pinned: true });
        assert.deepStrictEqual(tidied, {
          threadId: launched[0]?.threadId ?? null,
          project: "Workbench project",
        });

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

  it.effect(
    "installs from a folder, keeps the old version when a reinstall fails, and uninstalls",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const broken = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugin-broken-" });
        yield* writeFile(`${broken}/t3-plugin.json`, JSON.stringify({ id: "hello-plugin" }));
        yield* Effect.gen(function* () {
          const host = yield* PluginHost.PluginHost;
          yield* waitForStatuses(host, {});

          const source = { type: "path" as const, path: `${fixturesDir}hello-plugin` };
          const installed = yield* host.install(source);
          assert.deepStrictEqual(installed.installSource, source);
          const updated = yield* host.update(hello);
          assert.include(updated, { status: "active" });
          assert.notStrictEqual(updated.revision, installed.revision);
          assert.include(installed, {
            id: hello,
            status: "active",
            enabled: true,
            source: "installed",
          });
          assert.isTrue(yield* fs.exists(`${stateDir}/plugins/hello-plugin/server.cjs`));

          const failed = yield* host.install({ type: "path", path: broken }).pipe(Effect.flip);
          assert.strictEqual(failed._tag, "PluginInstallError");
          assert.include(stateOf(yield* host.list, hello), { status: "active" });
          assert.isTrue(yield* fs.exists(`${stateDir}/plugins/hello-plugin/server.cjs`));

          yield* host.uninstall(hello, true);
          assert.isUndefined(stateOf(yield* host.list, hello));
          assert.isFalse(yield* fs.exists(`${stateDir}/plugins/hello-plugin`));

          // A plugin linked into the plugins folder: removing it removes the link, not its source.
          yield* fs.symlink(`${fixturesDir}hello-plugin`, `${stateDir}/plugins/hello-plugin`);
          yield* host.reload(hello).pipe(Effect.ignore);
          yield* host.uninstall(hello, false);
          assert.isFalse(yield* fs.exists(`${stateDir}/plugins/hello-plugin`));
          assert.isTrue(yield* fs.exists(`${fixturesDir}hello-plugin/server.cjs`));

          npmLatest = "1.0.0";
          const fromNpm = yield* host.install({ type: "npm", name: "npm-hello" });
          assert.include(fromNpm, { id: PluginId.make("npm-hello"), status: "active" });
          assert.isUndefined(stateOf(yield* host.checkUpdates, "npm-hello")?.availableUpdate);
          npmLatest = "1.1.0";
          assert.deepStrictEqual(stateOf(yield* host.checkUpdates, "npm-hello")?.availableUpdate, {
            version: "1.1.0",
          });
          // Another source claiming an installed id is refused before anything moves.
          const impostor = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugin-impostor-" });
          yield* writeFile(
            `${impostor}/t3-plugin.json`,
            JSON.stringify({
              id: "npm-hello",
              name: "Impostor",
              version: "9.0.0",
              engines: { t3: ">=0.1.0" },
            }),
          );
          const takeover = yield* host.install({ type: "path", path: impostor }).pipe(Effect.flip);
          assert.match(takeover.message, /already installed from somewhere else/);
          // Updating a disabled plugin keeps it disabled.
          yield* host.setEnabled(PluginId.make("npm-hello"), false);
          const npmUpdated = yield* host.update(PluginId.make("npm-hello"));
          assert.include(npmUpdated, { enabled: false });
          assert.isUndefined(npmUpdated.availableUpdate);
          const tampered = yield* host
            .install({ type: "npm", name: "npm-tampered" })
            .pipe(Effect.flip);
          assert.match(tampered.message, /integrity/);
          assert.deepStrictEqual((yield* fs.readDirectory(`${stateDir}/plugins`)).toSorted(), [
            "npm-hello",
          ]);
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
        assert.strictEqual(npmMetadataRequests, 1);
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

it.live("runs a turn with the ACP agent a plugin registers by its command", () =>
  Effect.gen(function* () {
    const acpPlugin = PluginId.make("acp-agent-plugin");
    yield* writePluginsConfig({
      enabled: { [acpPlugin]: true },
      devPaths: [`${fixturesDir}acp-agent-plugin`],
    });
    const echoAcp = ProviderDriverKind.make("echoAcp");
    const { registry, addDriver } = yield* makeProviderInstanceRegistry<AcpAgentDriverEnv>({
      drivers: [],
      configMap: { [defaultInstanceIdForDriver(echoAcp)]: { driver: echoAcp, enabled: true } },
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestProviderHost.layer(),
          IdAllocator.layer,
          McpProviderSessions.layer,
          Layer.succeed(SecretResolver.SecretResolver, {
            read: () => Effect.succeed([]),
            invalidate: () => Effect.void,
          }),
        ),
      ),
    );
    const services = Layer.mergeAll(
      layerUnusedServices,
      Layer.succeed(ProviderDriverRegistration.ProviderDriverRegistration, {
        // This registry provides what the ACP agent driver uses.
        add: addDriver as ProviderDriverRegistration.ProviderDriverRegistration["Service"]["add"],
      }),
    );
    yield* Effect.gen(function* () {
      const host = yield* PluginHost.PluginHost;
      yield* waitForStatuses(host, { [acpPlugin]: "active" });
      const instanceId = defaultInstanceIdForDriver(echoAcp);
      const instance = yield* registry.getInstance(instanceId);
      assert.include(yield* instance!.snapshot.getSnapshot, {
        displayName: "Echo ACP",
        status: "ready",
      });

      const threadId = ThreadId.make("thread:echo-acp");
      const modelSelection = { instanceId, model: "default" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const session = yield* instance!.orchestrationAdapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session:echo-acp"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const replies = yield* session.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* session.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          messageText: "Hello there",
        }),
      );
      const events = Array.from(yield* Fiber.join(replies));
      assert.include(events.at(-1), { type: "turn.terminal", status: "completed" });
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.text.includes("Echo: Hello there"),
        ),
      );
    }).pipe(Effect.provide(layerHost(services)));
  }).pipe(Effect.provide(layerConfig()), Effect.scoped, Effect.provide(NodeServices.layer)),
);
