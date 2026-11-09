import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  applyPluginStatesEvent,
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  PluginId,
  type PluginStatesEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as PluginHost from "./PluginHost.ts";
import {
  fixturesDir,
  layerConfig,
  layerFileSystemWith,
  layerHost,
  stateOf,
  waitForStatuses,
  writeFile,
  writeInstalledPlugin,
  writePluginsConfig,
} from "./pluginHostTestHarness.ts";
import * as PluginInstaller from "./PluginInstaller.ts";
import { makePluginRpcHandlers } from "./pluginRpcHandlers.ts";
import * as PluginStorage from "./PluginStorage.ts";
import * as PluginUploads from "./pluginUploads.ts";

const hello = PluginId.make("hello-plugin");
const broken = PluginId.make("broken-plugin");
const operate = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] as const;

const manifestJson = (
  id: string,
  options: {
    readonly name?: string;
    readonly version?: string;
    readonly engines?: string;
    readonly settingsSchema?: object;
  } = {},
) =>
  JSON.stringify({
    id,
    name: options.name ?? id,
    version: options.version ?? "0.1.0",
    engines: { t3: options.engines ?? ">=0.1.0" },
    settingsSchema: options.settingsSchema,
  });

const enableHello = writePluginsConfig({
  enabled: { [hello]: true },
  devPaths: [`${fixturesDir}hello-plugin`],
});

/** A `linked` plugin in a checkout folder, which the plugins folder holds a symlink to. */
const linkPluginFolder = Effect.fn(function* (entries: {
  readonly server?: string;
  readonly web?: string;
}) {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const realDir = `${stateDir}/checkout/linked`;
  yield* writeFile(
    `${realDir}/t3-plugin.json`,
    JSON.stringify({
      id: "linked",
      name: "Linked",
      version: "0.1.0",
      engines: { t3: ">=0.1.0" },
      ...entries,
    }),
  );
  yield* fs.makeDirectory(`${stateDir}/plugins`, { recursive: true });
  yield* fs.symlink(realDir, `${stateDir}/plugins/linked`);
  return realDir;
});

const leaky = PluginId.make("leaky");
// Fails outside a call: in a timer a method sets, or in a read a method never awaits.
const leakyServer = `module.exports = { activate(api) {
  api.rpc.register("rejectLater", () => { setTimeout(() => { Promise.reject(new Error("rejected in a timer")); }, 0); }, { access: "read" });
  api.rpc.register("readMissing", () => { void require("node:fs/promises").readFile("/t3-plugin-test-missing-file"); }, { access: "read" });
} };`;

/** The next failure outside a call that the plugin's row shows. */
const nextServerFailure = (host: PluginHost.PluginHost["Service"], pluginId: PluginId) =>
  host.streamStates.pipe(
    Stream.map((states) => stateOf(states, pluginId)?.serverFailure),
    Stream.filter((failure) => failure !== undefined),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("PluginHost", (it) => {
  it.effect("activates an enabled plugin and serves its methods with the caller's access", () =>
    Effect.gen(function* () {
      yield* enableHello;
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const states = yield* waitForStatuses(host, { [hello]: "active" });
        assert.include(stateOf(states, hello), { source: "dev", hasServer: true, enabled: true });

        const ping = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
          host.invoke({ pluginId: hello, method: "ping", input: "a", scopes });
        assert.deepStrictEqual(yield* ping(operate), {
          pong: "a",
          greeting: "hello",
          access: "write",
        });
        // A read method tells a session that can only read from one that can also write.
        assert.deepStrictEqual(yield* ping([AuthOrchestrationReadScope]), {
          pong: "a",
          greeting: "hello",
          access: "read",
        });

        const count = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
          host.invoke({ pluginId: hello, method: "count", input: undefined, scopes });
        const counted = yield* host
          .subscribe({ pluginId: hello, channel: "counted" })
          .pipe(Stream.runHead, Effect.forkChild({ startImmediately: true }));
        assert.strictEqual(yield* count(operate), 1);
        assert.deepStrictEqual(yield* Fiber.join(counted), Option.some(1));
        const denied = yield* count([AuthOrchestrationReadScope]).pipe(Effect.flip);
        assert.strictEqual(denied._tag, "PluginAccessDeniedError");
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("hands an active plugin its saved settings and tells it when they change", () =>
    Effect.gen(function* () {
      yield* enableHello;
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const states = yield* waitForStatuses(host, { [hello]: "active" });
        assert.include(stateOf(states, hello), { hasSettings: true });

        const changed = yield* host
          .subscribe({ pluginId: hello, channel: "settings" })
          .pipe(Stream.runHead, Effect.forkChild({ startImmediately: true }));
        yield* host.updateSettings(hello, { greeting: "hey" });
        assert.deepStrictEqual(yield* Fiber.join(changed), Option.some({ greeting: "hey" }));
        assert.deepInclude(
          yield* host.invoke({ pluginId: hello, method: "ping", input: "b", scopes: operate }),
          { greeting: "hey" },
        );
        // The settings form's schema comes with the settings, not on every row.
        const { settings, settingsSchema } = yield* host.getSettings(hello);
        assert.deepStrictEqual(settings, { greeting: "hey" });
        assert.include(settingsSchema, { additionalProperties: false });
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

  it.effect("fails a plugin with server code below Node 24 and runs one without", () =>
    Effect.gen(function* () {
      const styles = PluginId.make("styles-plugin");
      yield* writePluginsConfig({
        enabled: { [hello]: true, [styles]: true },
        devPaths: [`${fixturesDir}hello-plugin`, `${fixturesDir}styles-plugin`],
      });
      // As `npx t3` runs on Node 22.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const running = process.versions.node;
          Object.defineProperty(process.versions, "node", { value: "22.16.0" });
          return running;
        }),
        (running) =>
          Effect.sync(() => Object.defineProperty(process.versions, "node", { value: running })),
      );
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const states = yield* waitForStatuses(host, { [hello]: "failed", [styles]: "active" });
        assert.deepStrictEqual(stateOf(states, hello)?.failure, {
          stage: "compatibility",
          message: "Needs Node 24 or later for its server code; this server runs Node 22.16.0.",
        });
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.scoped, Effect.provide(layerConfig())),
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
      const rootDir = yield* writeInstalledPlugin(
        "typo",
        `module.exports = { activate(api) { api.rpc.register("go", () => 1, { access: "Write" }); } };`,
      );
      yield* writeFile(`${rootDir}/styles/base.css`, "body {}");
      yield* writePluginsConfig({ enabled: { typo: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const states = yield* waitForStatuses(host, { typo: "failed" });
        assert.deepStrictEqual(stateOf(states, "typo")?.failure, {
          stage: "activate",
          message: 'Method "go" needs access "read" or "write".',
        });
        // Nor does it serve its files.
        const served = yield* host.readWebFile({
          pluginId: "typo",
          path: "/styles/base.css",
          revision: undefined,
        });
        assert.isTrue(Option.isNone(served));
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

        // A folder copied in later with its id is a plugin the user hasn't seen, so it starts off,
        // and reloading the gone plugin still lists it.
        yield* writeInstalledPlugin("goes", `module.exports = { activate() {} };`);
        const missing = yield* host.reload(PluginId.make("arrives")).pipe(Effect.flip);
        assert.strictEqual(missing._tag, "PluginNotFoundError");
        assert.include(stateOf(yield* host.list, "goes"), { status: "disabled", enabled: false });
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("reload runs new code from a symlinked plugin folder", () =>
    Effect.gen(function* () {
      const realDir = yield* linkPluginFolder({ server: "./server.cjs" });
      const plugin = (version: string) =>
        `module.exports = { activate(api) { api.rpc.register("which", () => "${version}", { access: "read" }); } };`;
      yield* writeFile(`${realDir}/server.cjs`, plugin("v1"));
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

  it.effect("serves no file of an assets folder linked out of a symlinked plugin folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const realDir = yield* linkPluginFolder({ web: "./web.js" });
      yield* writeFile(`${realDir}/web.js`, "export default {};");
      yield* writeFile(`${stateDir}/checkout/outside/secret.txt`, "Not the plugin's.");
      yield* fs.symlink(`${stateDir}/checkout/outside`, `${realDir}/assets`);
      yield* writePluginsConfig({ enabled: { linked: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { linked: "active" });
        const served = (path: string) =>
          host
            .readWebFile({ pluginId: "linked", path, revision: undefined })
            .pipe(Effect.map(Option.isSome));
        assert.isTrue(yield* served("/web.js"));
        assert.isFalse(yield* served("/assets/secret.txt"));
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("unlinks a plugin loaded from devPaths and leaves its folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const folder = `${stateDir}/checkout/linked`;
      yield* writeFile(`${folder}/t3-plugin.json`, manifestJson("linked"));
      yield* writePluginsConfig({ enabled: { linked: true }, devPaths: [folder] });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, { linked: "active" });

        yield* installer.uninstall(PluginId.make("linked"));
        // Forgotten, not only stopped: a rescan does not find it again.
        assert.isUndefined(stateOf((yield* host.rescan).plugins, "linked"));
        const saved = yield* fs.readFileString(`${stateDir}/plugins.json`);
        assert.deepStrictEqual(JSON.parse(saved), { enabled: {}, devPaths: [] });
        assert.isTrue(yield* fs.exists(`${folder}/t3-plugin.json`));
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("refuses a dropped folder that would replace a linked plugin", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const folder = `${stateDir}/checkout/linked`;
      yield* writeFile(`${folder}/t3-plugin.json`, manifestJson("linked"));
      yield* writePluginsConfig({ devPaths: [folder] });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, { linked: "disabled" });
        const refused = yield* installer
          .installFiles([
            { path: "t3-plugin.json", contents: new TextEncoder().encode(manifestJson("linked")) },
          ])
          .pipe(Effect.flip);
        assert.strictEqual(refused.message, `linked is linked from ${folder}. Unlink it first.`);
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("refuses a later folder with a plugin's id, and removes or unlinks it alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const id = PluginId.make("twice");
      const installed = `${stateDir}/plugins/twice-copy`;
      const linked = `${stateDir}/checkout/twice`;
      yield* writeFile(`${stateDir}/plugins/twice/t3-plugin.json`, manifestJson(id));
      yield* writeFile(`${installed}/t3-plugin.json`, manifestJson(id, { version: "0.2.0" }));
      yield* writeFile(`${linked}/t3-plugin.json`, manifestJson(id, { version: "0.3.0" }));
      yield* writePluginsConfig({ enabled: { [id]: true }, devPaths: [linked] });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        const storage = yield* PluginStorage.PluginStorage;
        yield* waitForStatuses(host, { [id]: "active" });
        yield* storage.set(id, "kept", true);
        const copies = host.list.pipe(
          Effect.map((states) =>
            states
              .filter((state) => state.id === id)
              .map((state) => [state.version, state.status, state.failure?.message]),
          ),
        );
        const refused =
          'The installed folder "twice" already has the id twice. Remove or unlink one of them.';
        assert.deepStrictEqual(yield* copies, [
          ["0.1.0", "active", undefined],
          ["0.2.0", "failed", refused],
          ["0.3.0", "failed", refused],
        ]);

        yield* installer.uninstall(id, linked);
        yield* installer.uninstall(id, installed);
        assert.deepStrictEqual(yield* copies, [["0.1.0", "active", undefined]]);
        assert.isFalse(yield* fs.exists(installed));
        assert.isTrue(yield* fs.exists(linked));
        // The copy in use keeps the id's data.
        assert.deepStrictEqual(yield* storage.get(id, "kept"), Option.some(true));

        const elsewhere = yield* installer.uninstall(id, `${stateDir}/elsewhere`).pipe(Effect.flip);
        assert.strictEqual(elsewhere.message, `No copy of twice is in ${stateDir}/elsewhere.`);
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("lists a later folder with a removed plugin's id afresh, turned off", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const id = PluginId.make("twice");
      yield* writeFile(`${stateDir}/plugins/twice/t3-plugin.json`, manifestJson(id));
      yield* writeFile(`${stateDir}/plugins/twice-copy/t3-plugin.json`, manifestJson(id));
      yield* writePluginsConfig({ enabled: { [id]: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, { [id]: "active" });

        yield* installer.uninstall(id);
        const left = (yield* host.list).filter((state) => state.id === id);
        assert.deepStrictEqual(
          left.map((state) => [state.folder, state.status, state.enabled, state.failure]),
          [[`${stateDir}/plugins/twice-copy`, "disabled", false, undefined]],
        );
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("lists a plugin's rejection in a timer on its row instead of stopping the server", () =>
    Effect.gen(function* () {
      yield* writeInstalledPlugin("leaky", leakyServer);
      yield* writePluginsConfig({ enabled: { leaky: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { leaky: "active" });
        yield* host.invoke({
          pluginId: leaky,
          method: "rejectLater",
          input: undefined,
          scopes: operate,
        });
        assert.strictEqual(yield* nextServerFailure(host, leaky), "rejected in a timer");
        assert.include(stateOf(yield* host.list, leaky), { status: "active" });
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("lists a failed read a plugin never awaited, though its stack is all Node's", () =>
    Effect.gen(function* () {
      yield* writeInstalledPlugin("leaky", leakyServer);
      yield* writePluginsConfig({ enabled: { leaky: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { leaky: "active" });
        yield* host.invoke({
          pluginId: leaky,
          method: "readMissing",
          input: undefined,
          scopes: operate,
        });
        assert.include(yield* nextServerFailure(host, leaky), "ENOENT");
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("lists a failure of code a turned-off plugin left running on its row", () =>
    Effect.gen(function* () {
      const id = PluginId.make("leftover");
      yield* writeInstalledPlugin(
        id,
        `module.exports = { activate(api) {
  api.onDeactivate(() => { setTimeout(() => { Promise.reject(new Error("left running")); }, 0); });
} };`,
      );
      yield* writePluginsConfig({ enabled: { [id]: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { [id]: "active" });
        yield* host.setEnabled(id, false);
        assert.strictEqual(yield* nextServerFailure(host, id), "left running");
        assert.include(stateOf(yield* host.list, id), { enabled: false, status: "disabled" });
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("clears a failure from a start that failed once the plugin is turned off", () =>
    Effect.gen(function* () {
      const id = PluginId.make("leaky-start");
      // A timer it sets while starting fails, then it fails to start.
      yield* writeInstalledPlugin(
        id,
        `module.exports = { activate() {
  setTimeout(() => { Promise.reject(new Error("rejected while starting")); }, 0);
  return new Promise((_, reject) => setTimeout(() => reject(new Error("activate failed")), 0));
} };`,
      );
      yield* writePluginsConfig({ enabled: { [id]: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { [id]: "failed" });
        assert.strictEqual(yield* nextServerFailure(host, id), "rejected while starting");
        assert.isUndefined((yield* host.setEnabled(id, false)).serverFailure);
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("does not start a plugin that stopped the server until it is turned on again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const rootDir = yield* writeInstalledPlugin(
        "crashing",
        `require("node:fs").writeFileSync(__dirname + "/loaded", "");
module.exports = { activate() {} };`,
      );
      yield* writePluginsConfig({ enabled: { crashing: true } });
      const id = PluginId.make("crashing");
      const thrown = new Error("thrown in a timer");
      thrown.stack = `Error: thrown in a timer\n    at ${yield* fs.realPath(rootDir)}/server.cjs:1:1`;
      yield* Effect.gen(function* () {
        yield* waitForStatuses(yield* PluginHost.PluginHost, { crashing: "active" });
        // As Node reports an uncaught exception, just before it exits.
        process.emit("uncaughtExceptionMonitor", thrown);
      }).pipe(Effect.provide(layerHost()));
      yield* fs.remove(`${rootDir}/loaded`);

      // The next start lists it as failed and leaves its code unloaded.
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const states = yield* waitForStatuses(host, { crashing: "failed" });
        // Its switch shows it off, so turning it on is how the user retries it.
        assert.deepInclude(stateOf(states, id), {
          enabled: false,
          failure: { stage: "crash", message: "thrown in a timer" },
        });
        assert.isFalse(yield* fs.exists(`${rootDir}/loaded`));
        assert.include(yield* host.setEnabled(id, true), { status: "active" });
      }).pipe(Effect.provide(layerHost()));
      // Turned on again, it starts with the server again.
      yield* Effect.gen(function* () {
        yield* waitForStatuses(yield* PluginHost.PluginHost, { crashing: "active" });
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("keeps a quiet channel's value while a busy channel overflows its buffer", () =>
    Effect.gen(function* () {
      yield* writeInstalledPlugin(
        "channels",
        `module.exports = { activate(api) {
  api.rpc.register("wake", () => api.rpc.publish("quiet", "wake"), { access: "read" });
  api.rpc.register("burst", () => {
    for (let index = 0; index < 100; index++) api.rpc.publish("busy", index);
    api.rpc.publish("quiet", "after");
  }, { access: "read" });
} };`,
      );
      yield* writePluginsConfig({ enabled: { channels: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const id = PluginId.make("channels");
        const call = (method: string) =>
          host.invoke({ pluginId: id, method, input: undefined, scopes: operate });
        yield* waitForStatuses(host, { channels: "active" });
        // A subscriber still busy with its first value, as one whose socket is slow to send.
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const quiet = yield* host.subscribe({ pluginId: id, channel: "quiet" }).pipe(
          Stream.mapEffect((value) =>
            Deferred.succeed(reached, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(value),
            ),
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* call("wake");
        yield* Deferred.await(reached);
        yield* call("burst");
        yield* Deferred.succeed(release, undefined);
        assert.deepStrictEqual(yield* Fiber.join(quiet), ["wake", "after"]);
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("gives up on a method that does not answer within 30 seconds, and aborts it", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      const aborted = Promise.withResolvers<void>();
      Reflect.set(globalThis, "__t3PluginHostInvokeStarted", started.resolve);
      Reflect.set(globalThis, "__t3PluginHostInvokeAborted", aborted.resolve);
      yield* writeInstalledPlugin(
        "hangs",
        `module.exports = { activate(api) {
  api.rpc.register("wait", (_input, { signal }) => new Promise(() => {
    signal.addEventListener("abort", () => globalThis.__t3PluginHostInvokeAborted());
    globalThis.__t3PluginHostInvokeStarted();
  }), { access: "read" });
} };`,
      );
      yield* writePluginsConfig({ enabled: { hangs: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const id = PluginId.make("hangs");
        yield* waitForStatuses(host, { hangs: "active" });
        const call = yield* host
          .invoke({ pluginId: id, method: "wait", input: undefined, scopes: operate })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => started.promise);
        yield* TestClock.adjust("30 seconds");
        assert.strictEqual(
          (yield* Fiber.join(call)).message,
          "Plugin hangs did not answer wait within 30 seconds.",
        );
        yield* Effect.promise(() => aborted.promise);
        assert.include(stateOf(yield* host.list, id), { status: "active" });
      }).pipe(Effect.provide(layerHost()));
      Reflect.deleteProperty(globalThis, "__t3PluginHostInvokeStarted");
      Reflect.deleteProperty(globalThis, "__t3PluginHostInvokeAborted");
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("finishes disabling a plugin when the caller gives up, or while it starts", () =>
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
      // Every publish that changes the theme folders hands them over, and holds there while `held`
      // is set.
      const themeFolders: Array<ReadonlyArray<string>> = [];
      let held:
        | { readonly reached: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
        | undefined;
      const layerHeldPublish = Layer.mock(EnvironmentTheme.EnvironmentThemeService)({
        setPluginThemeDirectories: (directories) => {
          themeFolders.push(directories);
          return held === undefined
            ? Effect.void
            : Deferred.succeed(held.reached, undefined).pipe(
                Effect.andThen(Deferred.await(held.release)),
              );
        },
      });
      // A disable's last wait before it stops the plugin is removing the temporary folder of its
      // plugins.json write. A fork runs only once the disable waits again, which is at that stop.
      let releaseOnWrite: Deferred.Deferred<void> | undefined;
      const layerReleaseOnWrite = layerFileSystemWith((fs) => ({
        remove: (target, options) =>
          fs
            .remove(target, options)
            .pipe(
              Effect.andThen(
                releaseOnWrite !== undefined && target.includes("plugins.json.")
                  ? Effect.forkChild(Deferred.succeed(releaseOnWrite, undefined))
                  : Effect.void,
              ),
            ),
      }));
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

        // A stop that interrupts a start while it hands over its theme folder still lets that
        // list go out, or the disabled list would match the last one sent and keep the folder.
        const starting = {
          reached: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        held = starting;
        const enabling = yield* host
          .setEnabled(id, true)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(starting.reached);
        releaseOnWrite = starting.release;
        assert.include(yield* host.setEnabled(id, false), { status: "disabled" });
        yield* Fiber.join(enabling);
        assert.deepStrictEqual(themeFolders.at(-1), []);
      }).pipe(Effect.provide(layerHost(layerHeldPublish).pipe(Layer.provide(layerReleaseOnWrite))));
      Reflect.deleteProperty(globalThis, "__t3PluginHostCleanupStarted");
      Reflect.deleteProperty(globalThis, "__t3PluginHostCleanupGate");
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("installs a dropped folder turned off, and one dropped again keeps its switch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const helloFiles = yield* Effect.forEach(["t3-plugin.json", "server.cjs"], (name) =>
        fs
          .readFile(`${fixturesDir}hello-plugin/${name}`)
          .pipe(Effect.map((contents) => ({ path: name, contents }))),
      );
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, {});
        // Nothing of a new plugin runs until its switch is turned on.
        const installed = yield* installer.installFiles(helloFiles);
        assert.include(installed, { id: hello, status: "disabled", enabled: false });
        const started = yield* host.setEnabled(hello, true);
        const replaced = yield* installer.installFiles(helloFiles);
        assert.include(replaced, { status: "active", enabled: true });
        assert.notStrictEqual(replaced.revision, started.revision);
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect(
    "lists a folder copied in by hand turned off, and a dropped one replaces it there",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const notesManifest = (version: string) =>
          JSON.stringify({ id: "notes", name: "Notes", version, engines: { t3: ">=0.1.0" } });
        yield* Effect.gen(function* () {
          const host = yield* PluginHost.PluginHost;
          const installer = yield* PluginInstaller.PluginInstaller;
          yield* waitForStatuses(host, {});
          // The docs point people at the plugins folder, so a rescan makes sure it exists.
          yield* host.rescan;
          assert.isTrue(yield* fs.exists(`${stateDir}/plugins`));

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
          assert.deepStrictEqual(yield* fs.readDirectory(`${stateDir}/plugins`), ["My Notes"]);
          yield* installer.uninstall(PluginId.make("notes"));
          assert.isFalse(yield* fs.exists(`${stateDir}/plugins/My Notes`));
        }).pipe(Effect.provide(layerHost()));
      }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("puts the working version back when a new dropped version fails to start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const encode = (text: string) => new TextEncoder().encode(text);
      const upgrade = (version: string, activate = "") => [
        {
          path: "t3-plugin.json",
          contents: encode(
            JSON.stringify({
              id: "upgrade",
              name: "Upgrade",
              version,
              engines: { t3: ">=0.1.0" },
              server: "./server.cjs",
            }),
          ),
        },
        {
          path: "server.cjs",
          contents: encode(`module.exports = { activate() { ${activate} } };`),
        },
      ];
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, {});
        yield* installer.installFiles(upgrade("1.0.0"));
        yield* host.setEnabled(PluginId.make("upgrade"), true);
        const failed = yield* installer
          .installFiles(upgrade("2.0.0", `throw new Error("2.0.0 refuses to start");`))
          .pipe(Effect.flip);
        assert.strictEqual(
          failed.message,
          "Upgrade 2.0.0 failed to start, so 1.0.0 is back. It failed with: 2.0.0 refuses to start",
        );
        assert.include(stateOf(yield* host.list, "upgrade"), {
          version: "1.0.0",
          status: "active",
        });
        assert.notInclude(
          yield* fs.readFileString(`${stateDir}/plugins/upgrade/server.cjs`),
          "refuses to start",
        );
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("keeps server folder paths from clients that cannot manage plugins", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const folder = `${stateDir}/checkout/linked`;
      yield* writeFile(`${folder}/t3-plugin.json`, manifestJson("linked"));
      yield* writePluginsConfig({ devPaths: [folder] });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, { linked: "disabled" });
        const listed = (scopes: ReadonlyArray<AuthEnvironmentScope>) => {
          // Listing never signs an upload URL.
          const uploads = PluginUploads.PluginUploads.of({
            issueUrl: Effect.die("unused"),
            claim: () => Effect.die("unused"),
          });
          const handlers = makePluginRpcHandlers(host, installer, uploads, scopes);
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
          assert.notProperty(plugin, "folder");
        }
        const managed = yield* listed([AuthOrchestrationReadScope, AuthSettingsWriteScope]);
        assert.include(stateOf(managed, "linked"), { folder });
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

  it.effect("refuses a dropped folder this server can't run and keeps the old one", () =>
    Effect.gen(function* () {
      const upgrade = (
        version: string,
        options: { readonly engines?: string; readonly settingsSchema?: object } = {},
      ) => [
        {
          path: "t3-plugin.json",
          contents: new TextEncoder().encode(
            manifestJson("upgrade", { name: "Upgrade", version, ...options }),
          ),
        },
      ];
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, {});
        yield* installer.installFiles(upgrade("1.0.0"));
        yield* host.setEnabled(PluginId.make("upgrade"), true);
        const refused = yield* installer
          .installFiles(upgrade("2.0.0", { engines: ">=999.0.0" }))
          .pipe(Effect.flip);
        assert.strictEqual(
          refused.message,
          `Upgrade 2.0.0 needs T3 Code >=999.0.0, and this server is ${packageJson.version}.`,
        );
        const unchecked = yield* installer
          .installFiles(
            upgrade("2.0.0", {
              settingsSchema: { type: "object", properties: { count: { $ref: "#/$defs/no" } } },
            }),
          )
          .pipe(Effect.flip);
        assert.include(
          unchecked.message,
          "Upgrade 2.0.0 has a settingsSchema T3 Code cannot validate",
        );
        assert.include(unchecked.message, 'Missing definition "no"');
        assert.include(stateOf(yield* host.list, "upgrade"), {
          version: "1.0.0",
          status: "active",
        });
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
