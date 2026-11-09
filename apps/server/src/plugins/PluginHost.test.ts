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

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as PluginHost from "./PluginHost.ts";
import {
  layerConfig,
  layerFileSystemWith,
  layerHost,
  publishedThemeDirectories,
  stateOf,
  waitForStatuses,
  writeFile,
  writePluginsConfig,
} from "./pluginHostTestHarness.ts";
import * as PluginInstaller from "./PluginInstaller.ts";
import { makePluginRpcHandlers } from "./pluginRpcHandlers.ts";
import * as PluginUploads from "./pluginUploads.ts";

const hello = PluginId.make("hello-plugin");
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
  it.effect("saves plugins turned on and off, reloads a changed manifest and rescans folders", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const manifestPath = (id: string) => `${stateDir}/plugins/${id}/t3-plugin.json`;
      yield* writeFile(manifestPath("reloading"), manifestJson("reloading"));
      yield* writeFile(manifestPath("goes"), manifestJson("goes"));
      yield* writePluginsConfig({ enabled: { goes: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const fs = yield* FileSystem.FileSystem;
        const reloading = PluginId.make("reloading");
        yield* waitForStatuses(host, { reloading: "disabled", goes: "active" });
        assert.include(yield* host.setEnabled(reloading, true), { status: "active" });
        yield* host.setEnabled(PluginId.make("goes"), false);
        assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(`${stateDir}/plugins.json`)), {
          enabled: { goes: false, reloading: true },
        });

        const reloaded = manifestJson("reloading", { version: "0.2.0" });
        yield* writeFile(manifestPath("reloading"), reloaded);
        assert.include(yield* host.reload(reloading), { status: "active", version: "0.2.0" });

        // A rescan lists a folder copied in since, turned off, and drops one that was removed.
        yield* writeFile(manifestPath("arrives"), manifestJson("arrives"));
        yield* fs.remove(`${stateDir}/plugins/goes`, { recursive: true });
        const { plugins } = yield* host.rescan;
        assert.include(stateOf(plugins, "arrives"), { status: "disabled", enabled: false });
        assert.isUndefined(stateOf(plugins, "goes"));
        // plugins.json forgets the switch of a folder that is gone.
        assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(`${stateDir}/plugins.json`)), {
          enabled: { reloading: true },
        });
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("publishes the theme folders of plugins that are on", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const future = manifestJson("future", { engines: ">=999.0.0" });
      yield* writeFile(`${stateDir}/plugins/future/t3-plugin.json`, future);
      yield* writeFile(`${stateDir}/plugins/themed/t3-plugin.json`, manifestJson("themed"));
      yield* writePluginsConfig({ enabled: { themed: true, future: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const states = yield* waitForStatuses(host, { themed: "active", future: "failed" });
        // One that needs a newer T3 fails when it starts, and offers no themes.
        assert.strictEqual(stateOf(states, "future")?.failure?.stage, "compatibility");
        const themes = `${yield* fs.realPath(`${stateDir}/plugins/themed`)}/themes`;
        assert.deepStrictEqual(publishedThemeDirectories.at(-1), [themes]);
        publishedThemeDirectories.length = 0;
        yield* host.reload(PluginId.make("themed"));
        assert.deepStrictEqual(publishedThemeDirectories, [[themes]]);
        yield* host.setEnabled(PluginId.make("themed"), false);
        assert.deepStrictEqual(publishedThemeDirectories.at(-1), []);
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
        yield* waitForStatuses(host, { [id]: "active" });
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

  it.effect("installs a dropped folder turned off, and one dropped again keeps its switch", () =>
    Effect.gen(function* () {
      const helloFiles = (version: string) => [
        {
          path: "t3-plugin.json",
          contents: new TextEncoder().encode(manifestJson(hello, { version })),
        },
      ];
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, {});
        // Nothing of a new plugin runs until its switch is turned on.
        const installed = yield* installer.installFiles(helloFiles("0.1.0"));
        assert.include(installed, { id: hello, status: "disabled", enabled: false });
        yield* host.setEnabled(hello, true);
        const replaced = yield* installer.installFiles(helloFiles("0.1.1"));
        assert.include(replaced, { status: "active", enabled: true, version: "0.1.1" });
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
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const changing = PluginId.make("changing");
      yield* writeFile(`${stateDir}/checkout/steady/t3-plugin.json`, manifestJson("steady"));
      yield* writeFile(`${stateDir}/checkout/changing/t3-plugin.json`, manifestJson(changing));
      yield* writePluginsConfig({
        enabled: { [changing]: true },
        devPaths: [`${stateDir}/checkout/steady`, `${stateDir}/checkout/changing`],
      });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { [changing]: "active", steady: "disabled" });
        const disabled = (event: PluginStatesEvent) =>
          event._tag === "changed" &&
          event.rows.some(({ plugin }) => plugin.id === changing && plugin.status === "disabled");
        const events = yield* host
          .streamForClient(operate)
          .pipe(
            Stream.takeUntil(disabled),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true }),
          );
        yield* host.setEnabled(changing, false);
        const [first, ...changes] = yield* Fiber.join(events);
        assert.strictEqual(first?._tag, "snapshot");
        for (const change of changes) {
          assert.deepStrictEqual(
            change._tag === "changed" ? change.rows.map(({ plugin }) => plugin.id) : [],
            [changing],
          );
        }
        const folded = [first!, ...changes].reduce(applyPluginStatesEvent, { plugins: [] });
        assert.deepStrictEqual(folded, yield* host.listForClient(operate));
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("refuses a dropped folder this server can't run and keeps the old one", () =>
    Effect.gen(function* () {
      const upgrade = (version: string, options: { readonly engines?: string } = {}) => [
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
});
