import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PluginId, type PluginState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import type { DiscoveredPlugin } from "./pluginDiscovery.ts";
import { PluginNotFoundError } from "./PluginHost.ts";
import * as PluginInstaller from "./PluginInstaller.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";

const linked = PluginId.make("linked");
const linkedCopy: DiscoveredPlugin = {
  id: linked,
  rootDir: "/plugins/linked",
  folder: "/plugins/linked",
  source: "dev",
  manifest: { id: linked, name: "Linked", version: "1.0.0", engines: { t3: ">=0.0.1" } },
};

/**
 * A host holding one linked plugin, whose lifecycle lock records whether it is held, and stores
 * that record what they deleted and whether the lock was held then.
 */
const harness = Effect.fn(function* () {
  let locked = false;
  const cleared: Array<{ readonly what: string; readonly locked: boolean }> = [];
  const host: PluginInstaller.PluginInstallerHost = {
    lifecycle: (body) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          locked = true;
        }),
        () => body,
        () =>
          Effect.sync(() => {
            locked = false;
          }),
      ),
    copies: Effect.succeed([linkedCopy]),
    copyOf: (pluginId) =>
      pluginId === linked
        ? Effect.succeed(linkedCopy)
        : Effect.fail(new PluginNotFoundError({ pluginId })),
    stop: () => Effect.void,
    forget: () => Effect.void,
    reload: (pluginId) => Effect.fail(new PluginNotFoundError({ pluginId })),
    state: (pluginId) => Effect.fail(new PluginNotFoundError({ pluginId })),
    states: Effect.succeed<ReadonlyArray<PluginState>>([]),
    config: Effect.succeed({}),
    writeConfig: () => Effect.void,
    publish: Effect.void,
  };
  const { installer } = yield* PluginInstaller.make(host).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(PluginSettingsStore.PluginSettingsStore)({
          clear: () => Effect.sync(() => cleared.push({ what: "settings", locked })),
        }),
        Layer.mock(PluginStorage.PluginStorage)({
          clear: () => Effect.sync(() => cleared.push({ what: "storage", locked })),
        }),
        Layer.mock(ProcessRunner.ProcessRunner)({}),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("This test reaches no network.")),
        ),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3code-plugin-installer-test-" }),
      ),
    ),
  );
  return { installer, cleared };
});

it.layer(NodeServices.layer)("PluginInstaller", (it) => {
  it.effect("deletes a removed plugin's data before another plugin change can start", () =>
    Effect.gen(function* () {
      const { installer, cleared } = yield* harness();
      yield* installer.uninstall(linked, true);
      assert.deepStrictEqual(cleared, [
        { what: "settings", locked: true },
        { what: "storage", locked: true },
      ]);
    }),
  );
});
