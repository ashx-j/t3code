import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PluginId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PluginHost from "./PluginHost.ts";
import {
  fixturesDir,
  layerConfig,
  layerHost,
  publishedThemeDirectories,
  stateOf,
  waitForStatuses,
  writePluginsConfig,
} from "./pluginHostTestHarness.ts";
import * as PluginHttpRoutes from "./PluginHttpRoutes.ts";

it.layer(NodeServices.layer)("PluginWebFiles", (it) => {
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
});
