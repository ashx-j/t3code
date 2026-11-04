import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { checkPluginFolder } from "./pluginCheck.ts";

const SERVER_VERSION = "0.1.7";

/** A plugin folder in a temporary directory, from relative paths to contents. */
const writeFolder = Effect.fn(function* (files: Readonly<Record<string, string>>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugin-check-" });
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(folder, file);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, contents);
  }
  return folder;
});

const manifest = (fields: object) =>
  JSON.stringify({
    id: "checked",
    name: "Checked",
    version: "0.1.0",
    engines: { t3: ">=0.1.0" },
    ...fields,
  });

const codesOf = (folder: string) =>
  checkPluginFolder(folder, SERVER_VERSION).pipe(
    Effect.map((report) => report.findings.map((finding) => [finding.code, finding.file])),
  );

it.layer(NodeServices.layer)("checkPluginFolder", (it) => {
  it.effect("reports a server entry that is not CommonJS and entries that were not built", () =>
    Effect.gen(function* () {
      const folder = yield* writeFolder({
        "t3-plugin.json": manifest({ server: "./server.js", web: "dist/web.js" }),
      });
      assert.deepStrictEqual(yield* codesOf(folder), [
        ["manifest-invalid", "t3-plugin.json"],
        ["server-not-cjs", "t3-plugin.json"],
        ["entry-missing", "t3-plugin.json"],
        ["entry-missing", "t3-plugin.json"],
      ]);
    }),
  );

  it.effect("warns about bare imports and markup or colors tied to T3's current look", () =>
    Effect.gen(function* () {
      const folder = yield* writeFolder({
        "t3-plugin.json": manifest({
          engines: { t3: ">=99.0.0" },
          web: "dist/web.js",
          settingsSchema: {
            type: "object",
            properties: { interval: { type: "integer", minimum: 1, default: 0 } },
          },
        }),
        "dist/web.js": [
          'import{jsx as e}from"react/jsx-runtime";',
          "const css = `",
          ":root { --accent: #ff00aa; }",
          '[aria-label="Send message"] { color: #ff0000; }',
          '[data-slot="card"] { padding: 0; }',
          ".composer:has(.lucide-send) { margin: 0; }",
          "`;",
        ].join("\n"),
        "dist/extra.css": 'div[class*="titlebar"] { padding-right: env(titlebar-area-width); }',
      });
      const report = yield* checkPluginFolder(folder, SERVER_VERSION);
      assert.deepStrictEqual(
        report.findings.map((finding) => [finding.code, finding.file]),
        [
          ["engine-range", "t3-plugin.json"],
          ["settings-default-invalid", "t3-plugin.json"],
          ["bundle-imports", "dist/web.js"],
          ["aria-label-selector", "dist/web.js"],
          ["data-slot-selector", "dist/web.js"],
          ["has-selector", "dist/web.js"],
          ["icon-class-selector", "dist/web.js"],
          ["fixed-color", "dist/web.js"],
          // Vite writes an imported stylesheet beside the bundle, where T3 never loads it.
          ["css-not-loaded", "dist/extra.css"],
          ["class-attribute-selector", "dist/extra.css"],
          ["window-controls", "dist/extra.css"],
        ],
      );
      assert.include(
        report.findings.find((finding) => finding.code === "bundle-imports")?.problem,
        '"react/jsx-runtime"',
      );
    }),
  );

  it.effect("finds nothing in a plugin built with the preset that uses theme variables", () =>
    Effect.gen(function* () {
      const folder = yield* writeFolder({
        "t3-plugin.json": manifest({
          server: "dist/server.cjs",
          web: "dist/web.js",
          // A required field with no default is the user's to fill, not a broken default.
          settingsSchema: {
            type: "object",
            required: ["token"],
            properties: {
              token: { type: "string" },
              interval: { type: "integer", minimum: 1, default: 5 },
            },
          },
        }),
        "dist/server.cjs": "module.exports = { activate() {} };",
        "dist/web.js": [
          "const host = globalThis.__t3PluginHost.react;",
          'const style = { color: "var(--foreground)" };',
        ].join("\n"),
        "theme.css": ":root { --accent: #ff00aa; }",
      });
      const report = yield* checkPluginFolder(folder, SERVER_VERSION);
      assert.deepStrictEqual(report, { folder, pluginId: "checked", findings: [] });
    }),
  );

  it.effect("reports a settings schema T3 cannot read with the importer's reason", () =>
    Effect.gen(function* () {
      const folder = yield* writeFolder({
        "t3-plugin.json": manifest({
          settingsSchema: { type: "object", properties: { mode: { $ref: "#/$defs/missing" } } },
        }),
      });
      const [finding] = (yield* checkPluginFolder(folder, SERVER_VERSION)).findings;
      assert.strictEqual(finding?.code, "settings-schema-unreadable");
      assert.include(finding?.problem, 'Missing definition "missing"');
    }),
  );
});
