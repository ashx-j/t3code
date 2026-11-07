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
import * as PluginHttpRoutes from "./PluginHttpRoutes.ts";
import * as PluginInstaller from "./PluginInstaller.ts";
import { makePluginRpcHandlers } from "./pluginRpcHandlers.ts";
import * as PluginStorage from "./PluginStorage.ts";
import * as PluginUploads from "./pluginUploads.ts";

const hello = PluginId.make("hello-plugin");
const broken = PluginId.make("broken-plugin");
const operate = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] as const;

const manifestJson = (
  id: string,
  options: { readonly name?: string; readonly version?: string; readonly engines?: string } = {},
) =>
  JSON.stringify({
    id,
    name: options.name ?? id,
    version: options.version ?? "0.1.0",
    engines: { t3: options.engines ?? ">=0.1.0" },
  });

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
        const request = { path: "/web.js", query: {} };
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
        const copies = host.list.pipe(
          Effect.map((states) =>
            states
              .filter((state) => state.id === linked)
              .map(({ linkedFolder, status }) => ({ linkedFolder, status })),
          ),
        );
        assert.deepStrictEqual(yield* copies, [
          { linkedFolder: inUse, status: "active" },
          { linkedFolder: shadow, status: "failed" },
        ]);
        // A dropped folder cannot replace a linked one, which is the author's own.
        const refused = yield* installer
          .installFiles([
            { path: "t3-plugin.json", contents: new TextEncoder().encode(manifestJson("linked")) },
          ])
          .pipe(Effect.flip);
        assert.match(refused.message, /is linked from .+\. Unlink it first\./);

        // Unlinking the shadowed copy keeps the one in use running.
        yield* installer.uninstall(linked, shadow);
        assert.deepStrictEqual(yield* copies, [{ linkedFolder: inUse, status: "active" }]);
        assert.deepStrictEqual((yield* readConfig).devPaths, [inUse]);
        const notLinked = yield* installer
          .uninstall(linked, `${stateDir}/elsewhere`)
          .pipe(Effect.flip);
        assert.strictEqual(
          notLinked.message,
          `No copy of linked is linked from ${stateDir}/elsewhere.`,
        );

        yield* installer.uninstall(linked);
        // Forgotten, not only stopped: a rescan does not find it again.
        assert.isUndefined(stateOf((yield* host.rescan).plugins, "linked"));
        assert.deepStrictEqual(yield* readConfig, { enabled: {}, devPaths: [] });
        assert.isTrue(yield* fs.exists(`${inUse}/t3-plugin.json`));
        assert.isTrue(yield* fs.exists(`${shadow}/t3-plugin.json`));

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
        `module.exports = { activate(api) {
  api.rpc.register("throwLater", () => { setTimeout(() => { throw new Error("thrown in a timer"); }, 0); }, { access: "read" });
  api.rpc.register("spawnMissing", () => { require("node:child_process").spawn("t3-plugin-test-missing-command"); }, { access: "read" });
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
        // A child process with no error listener fails onto the row too, though its stack is all
        // Node's.
        const spawned = yield* failureAfter("spawnMissing", thrown);
        assert.include(spawned, "ENOENT");
        assert.include(stateOf(yield* host.list, id), { status: "active" });

        // Code a turned-off plugin left running still fails onto its row, which says so.
        yield* TestClock.adjust("5 seconds");
        const leftover = yield* host
          .setEnabled(id, false)
          .pipe(Effect.andThen(nextFailure(spawned)));
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
      // Holds a publish where it hands over the theme folders, which every publish that changes
      // the list does.
      let held:
        | { readonly reached: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
        | undefined;
      const layerHeldPublish = Layer.mock(EnvironmentTheme.EnvironmentThemeService)({
        setPluginThemeDirectories: () =>
          held === undefined
            ? Effect.void
            : Deferred.succeed(held.reached, undefined).pipe(
                Effect.andThen(Deferred.await(held.release)),
              ),
      });
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
        assert.isTrue(Option.isSome(yield* Fiber.join(sent)));

        const call = yield* host
          .invoke({ pluginId: id, method: "ping", input: undefined, scopes: operate })
          .pipe(Effect.flip);
        assert.strictEqual(
          call.message,
          "Plugin web-only has no server half, so it has no methods or channels.",
        );

        yield* report("load threw");
        yield* report("activate threw");
        assert.strictEqual(yield* webFailure, "activate threw");
        // A restart forgets it, and a report about the earlier start is ignored.
        const reloaded = yield* host.reload(id);
        assert.isUndefined(reloaded.webFailure);
        yield* report("stale");
        assert.isUndefined(yield* webFailure);
        yield* report("fresh", reloaded.revision);
        assert.strictEqual(yield* webFailure, "fresh");
      }).pipe(Effect.provide(layerHost(layerHeldPublish)));
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
      const linkedFolder = `${stateDir}/checkout/linked`;
      yield* writeFile(`${linkedFolder}/t3-plugin.json`, manifestJson("linked"));
      yield* writePluginsConfig({ devPaths: [linkedFolder] });
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
          assert.notProperty(plugin, "linkedFolder");
        }
        const managed = yield* listed([AuthOrchestrationReadScope, AuthSettingsWriteScope]);
        assert.include(stateOf(managed, "linked"), { linkedFolder });
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

  it.effect("refuses a dropped folder that needs a newer T3 Code and keeps the old one", () =>
    Effect.gen(function* () {
      const upgrade = (version: string, engines?: string) => [
        {
          path: "t3-plugin.json",
          contents: new TextEncoder().encode(
            manifestJson("upgrade", { name: "Upgrade", version, ...(engines ? { engines } : {}) }),
          ),
        },
      ];
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, {});
        yield* installer.installFiles(upgrade("1.0.0"));
        const refused = yield* installer
          .installFiles(upgrade("2.0.0", ">=999.0.0"))
          .pipe(Effect.flip);
        assert.strictEqual(
          refused.message,
          `Upgrade 2.0.0 needs T3 Code >=999.0.0, and this server is ${packageJson.version}.`,
        );
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
