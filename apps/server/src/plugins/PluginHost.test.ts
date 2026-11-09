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
import { makePluginRpcHandlers } from "./pluginRpcHandlers.ts";

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

  it.effect("keeps server folder paths from clients that cannot manage plugins", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const folder = `${stateDir}/checkout/linked`;
      yield* writeFile(`${folder}/t3-plugin.json`, manifestJson("linked"));
      yield* writePluginsConfig({ devPaths: [folder] });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { linked: "disabled" });
        const listed = (scopes: ReadonlyArray<AuthEnvironmentScope>) => {
          const handlers = makePluginRpcHandlers(host, scopes);
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
