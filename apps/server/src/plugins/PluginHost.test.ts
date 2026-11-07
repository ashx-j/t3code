import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  applyPluginStatesEvent,
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  PluginId,
  type PluginState,
  type PluginStatesEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as EnvironmentTheme from "../environmentTheme.ts";
import * as ServerConfig from "../config.ts";
import * as PluginHost from "./PluginHost.ts";
import * as PluginHttpRoutes from "./PluginHttpRoutes.ts";
import * as PluginInstaller from "./PluginInstaller.ts";
import { makePluginRpcHandlers } from "./pluginRpcHandlers.ts";

const fixturesDir = new URL("../../../../packages/plugin-sdk/fixtures/", import.meta.url).pathname;
const manage = [AuthOrchestrationReadScope, AuthSettingsWriteScope] as const;

const layerConfig = () =>
  Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-plugin-host-test-" }));

// Every list of theme folders the host published, for the theme cases.
const publishedThemeDirectories: Array<ReadonlyArray<string>> = [];
const layerThemes = Layer.mock(EnvironmentTheme.EnvironmentThemeService)({
  setPluginThemeDirectories: (directories) =>
    Effect.sync(() => {
      publishedThemeDirectories.push(directories);
    }),
});

const layerHost = () =>
  Layer.fresh(
    PluginHost.layer.pipe(Layer.provide(layerThemes), Layer.provideMerge(PluginHttpRoutes.layer)),
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

/** A plugin with no code written for one test, under `<stateDir>/plugins/<id>`, with a stylesheet. */
const writeStylesPlugin = Effect.fn(function* (
  id: string,
  options: Parameters<typeof manifestJson>[1] = {},
) {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const rootDir = `${stateDir}/plugins/${id}`;
  yield* writeFile(`${rootDir}/t3-plugin.json`, manifestJson(id, options));
  yield* writeFile(`${rootDir}/styles/base.css`, `/* ${id} */`);
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

const styleRequest = { path: "/styles/base.css", query: {} };

it.layer(NodeServices.layer)("PluginHost", (it) => {
  it.effect("reload picks up a changed manifest, and a plugin that needs a newer T3 fails", () =>
    Effect.gen(function* () {
      const rootDir = yield* writeStylesPlugin("reloading");
      yield* writeStylesPlugin("future", { engines: ">=999.0.0" });
      yield* writePluginsConfig({ enabled: { reloading: true, future: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const states = yield* waitForStatuses(host, { reloading: "active", future: "failed" });
        assert.strictEqual(stateOf(states, "future")?.failure?.stage, "compatibility");
        assert.isUndefined(stateOf(states, "future")?.styles);

        yield* writeFile(
          `${rootDir}/t3-plugin.json`,
          manifestJson("reloading", { name: "Reloaded", version: "0.2.0" }),
        );
        const reloaded = yield* host.reload(PluginId.make("reloading"));
        assert.include(reloaded, { status: "active", version: "0.2.0", name: "Reloaded" });
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("reload stops serving a plugin whose folder was removed", () =>
    Effect.gen(function* () {
      yield* writeStylesPlugin("stays");
      const goes = yield* writeStylesPlugin("goes");
      yield* writePluginsConfig({ enabled: { stays: true, goes: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const routes = yield* PluginHttpRoutes.PluginHttpRoutes;
        const fs = yield* FileSystem.FileSystem;
        yield* waitForStatuses(host, { stays: "active", goes: "active" });
        yield* fs.remove(goes, { recursive: true });

        yield* host.reload(PluginId.make("stays"));

        assert.isUndefined(stateOf(yield* host.list, "goes"));
        const gone = yield* routes
          .handle({ pluginId: "goes", request: styleRequest })
          .pipe(Effect.flip);
        assert.strictEqual(gone._tag, "PluginHttpRouteNotFoundError");
        const missing = yield* host.reload(PluginId.make("goes")).pipe(Effect.flip);
        assert.strictEqual(missing._tag, "PluginNotFoundError");
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("publishes the theme folders of enabled plugins, and keeps them through a reload", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const themed = yield* writeStylesPlugin("themed");
      yield* writeStylesPlugin("future", { engines: ">=999.0.0" });
      yield* writePluginsConfig({ enabled: { themed: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { themed: "active", future: "disabled" });
        // A disabled plugin offers no themes, and neither does one that fails to start.
        const themes = `${yield* fs.realPath(themed)}/themes`;
        assert.deepStrictEqual(publishedThemeDirectories.at(-1), [themes]);
        assert.include(yield* host.setEnabled(PluginId.make("future"), true), {
          status: "failed",
        });
        assert.deepStrictEqual(publishedThemeDirectories.at(-1), [themes]);

        // A reload publishes its folder again, so its files are read again, without dropping it
        // first: windows would flash T3's colors.
        publishedThemeDirectories.length = 0;
        yield* host.reload(PluginId.make("themed"));
        assert.isNotEmpty(publishedThemeDirectories);
        assert.deepStrictEqual(
          publishedThemeDirectories.filter((directories) => !directories.includes(themes)),
          [],
        );

        yield* host.setEnabled(PluginId.make("themed"), false);
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
        const request = { path: "/styles/base.css", query: { v: styles[0]?.revision ?? "" } };
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
      const encode = (text: string) => new TextEncoder().encode(text);
      const dropped = (version: string, engines?: string) => [
        {
          path: "t3-plugin.json",
          contents: encode(manifestJson("dropped", { version, ...(engines ? { engines } : {}) })),
        },
        { path: "styles/base.css", contents: encode(`/* ${version} */`) },
      ];
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, {});
        // The docs point people at the plugins folder, so a rescan makes sure it exists.
        yield* host.rescan;
        assert.isTrue(yield* fs.exists(`${stateDir}/plugins`));

        const installed = yield* installer.installFiles(dropped("1.0.0"));
        assert.include(installed, {
          id: PluginId.make("dropped"),
          status: "active",
          enabled: true,
        });
        // The same folder dropped again replaces it, and its new stylesheet gets a new revision.
        const replaced = yield* installer.installFiles(dropped("1.0.1"));
        assert.include(replaced, { version: "1.0.1", status: "active" });
        assert.notStrictEqual(replaced.styles?.[0]?.revision, installed.styles?.[0]?.revision);
        // One that needs a newer T3 is refused, and the version in use keeps running.
        const refused = yield* installer
          .installFiles(dropped("2.0.0", ">=999.0.0"))
          .pipe(Effect.flip);
        assert.include(refused.message, "needs T3 Code >=999.0.0");
        assert.include(stateOf(yield* host.list, "dropped"), {
          version: "1.0.1",
          status: "active",
        });

        // Copied in by hand under any name, a plugin is listed on the next rescan, turned off.
        yield* writeFile(`${stateDir}/plugins/My Notes/t3-plugin.json`, manifestJson("notes"));
        const { plugins } = yield* host.rescan;
        assert.include(stateOf(plugins, "notes"), { status: "disabled", enabled: false });
        // A new version copied over one that is off is what Settings lists and what starts.
        yield* writeFile(
          `${stateDir}/plugins/My Notes/t3-plugin.json`,
          manifestJson("notes", { version: "1.0.5" }),
        );
        assert.include(stateOf((yield* host.rescan).plugins, "notes"), { version: "1.0.5" });

        // A dropped folder replaces a plugin copied in by hand, in the folder it was copied to.
        yield* installer.installFiles([
          { path: "t3-plugin.json", contents: encode(manifestJson("notes", { version: "1.1.0" })) },
        ]);
        assert.include(stateOf(yield* host.list, "notes"), { version: "1.1.0", enabled: false });
        assert.deepStrictEqual((yield* fs.readDirectory(`${stateDir}/plugins`)).toSorted(), [
          "My Notes",
          "dropped",
        ]);
        yield* installer.uninstall(PluginId.make("notes"));
        assert.isFalse(yield* fs.exists(`${stateDir}/plugins/My Notes`));
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

        // Unlinking the shadowed copy keeps the one in use running.
        yield* installer.uninstall(linked, shadow);
        assert.deepStrictEqual(yield* copies(), [{ linkedFolder: inUse, status: "active" }]);
        assert.deepStrictEqual((yield* readConfig).devPaths, [inUse]);

        yield* installer.uninstall(linked);
        assert.deepStrictEqual(yield* copies(), []);
        assert.deepStrictEqual(yield* readConfig, { enabled: {}, devPaths: [] });
        assert.isTrue(yield* fs.exists(`${inUse}/t3-plugin.json`));
        assert.isTrue(yield* fs.exists(`${shadow}/t3-plugin.json`));
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("keeps server folder paths from clients that cannot manage plugins", () =>
    Effect.gen(function* () {
      const linkedFolder = `${fixturesDir}styles-plugin`;
      yield* writePluginsConfig({ devPaths: [linkedFolder] });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, { "styles-plugin": "disabled" });
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

        const readOnly = yield* listed([AuthOrchestrationReadScope]);
        assert.lengthOf(readOnly, 2);
        for (const plugin of readOnly) assert.notProperty(plugin, "linkedFolder");
        for (const plugin of yield* listed(manage)) {
          assert.include(plugin, { linkedFolder });
        }
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("sends a client only the plugins that changed after the first list", () =>
    Effect.gen(function* () {
      yield* writeStylesPlugin("changes");
      yield* writeStylesPlugin("stays");
      yield* writePluginsConfig({ enabled: { changes: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const changes = PluginId.make("changes");
        yield* waitForStatuses(host, { changes: "active", stays: "disabled" });
        const disabled = (event: PluginStatesEvent) =>
          event._tag === "changed" &&
          event.rows.some(({ plugin }) => plugin.id === changes && plugin.status === "disabled");
        const events = yield* host
          .streamForClient(manage)
          .pipe(
            Stream.takeUntil(disabled),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true }),
          );
        yield* host.setEnabled(changes, false);
        const [first, ...rest] = yield* Fiber.join(events);
        assert.strictEqual(first?._tag, "snapshot");
        assert.isNotEmpty(rest);
        for (const change of rest) {
          assert.deepStrictEqual(
            change._tag === "changed" ? change.rows.map(({ plugin }) => plugin.id) : [],
            [changes],
          );
        }
        const folded = [first!, ...rest].reduce(applyPluginStatesEvent, { plugins: [] });
        assert.deepStrictEqual(folded, yield* host.listForClient(manage));
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
