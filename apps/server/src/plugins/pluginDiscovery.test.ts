import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverPlugins } from "./pluginDiscovery.ts";

const manifest = (id: string) =>
  JSON.stringify({ id, name: id, version: "1.0.0", engines: { t3: ">=0.1.0" } });

it.layer(NodeServices.layer)("discoverPlugins", (it) => {
  it.effect("reports valid, missing, invalid, renamed and duplicate plugins", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugin-discovery-" });
      const pluginsDir = path.join(root, "plugins");
      const write = Effect.fn(function* (dir: string, contents: string | undefined) {
        yield* fs.makeDirectory(dir, { recursive: true });
        if (contents !== undefined) {
          yield* fs.writeFileString(path.join(dir, "t3-plugin.json"), contents);
        }
      });
      yield* write(path.join(pluginsDir, "valid"), manifest("valid"));
      yield* write(path.join(pluginsDir, "empty"), undefined);
      yield* write(
        path.join(pluginsDir, "invalid"),
        JSON.stringify({ ...JSON.parse(manifest("invalid")), version: "1" }),
      );
      yield* write(path.join(pluginsDir, "renamed"), manifest("other-name"));
      yield* write(path.join(pluginsDir, "My Plugin"), manifest("spaced"));
      yield* write(path.join(pluginsDir, "Not An Id"), undefined);
      // Sorts before "valid", but the folder named after the id is the one used.
      yield* write(path.join(pluginsDir, "Copy of valid"), manifest("valid"));
      const devCopy = path.join(root, "dev", "valid");
      yield* write(devCopy, manifest("valid"));
      const devOnly = path.join(root, "dev", "workbench");
      yield* write(devOnly, manifest("dev-only"));

      const plugins = yield* discoverPlugins({ pluginsDir, devPaths: [devCopy, devOnly] });
      const summary = plugins.map((plugin) => ({
        id: plugin.id,
        source: plugin.source,
        stage: "failure" in plugin ? plugin.failure.stage : "ok",
      }));

      assert.deepStrictEqual(summary, [
        { id: "spaced", source: "installed", stage: "ok" },
        { id: "empty", source: "installed", stage: "discovery" },
        { id: "invalid", source: "installed", stage: "manifest" },
        { id: "other-name", source: "installed", stage: "ok" },
        { id: "valid", source: "installed", stage: "ok" },
        { id: "valid", source: "installed", stage: "discovery" },
        { id: "valid", source: "dev", stage: "discovery" },
        { id: "dev-only", source: "dev", stage: "ok" },
      ]);
      assert.strictEqual(plugins[4]?.folder, path.join(pluginsDir, "valid"));
      const invalid = plugins.find((plugin) => plugin.id === "invalid");
      assert.include(invalid && "failure" in invalid ? invalid.failure.message : "", "version");
    }).pipe(Effect.scoped),
  );
});
