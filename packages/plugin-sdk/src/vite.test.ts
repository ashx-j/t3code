// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { build } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";

import { t3PluginWeb } from "./vite.ts";

const fixtureRoot = NodePath.join(import.meta.dirname, "../fixtures/hello-web");

describe("t3PluginWeb", () => {
  it("bundles a web plugin without React and reads shared modules from the host", async () => {
    const output = await build({
      root: fixtureRoot,
      configFile: false,
      logLevel: "silent",
      plugins: [t3PluginWeb()],
      build: { write: false, minify: false },
    });
    const chunks = (Array.isArray(output) ? output : [output]).flatMap((result) =>
      "output" in result ? result.output.filter((item) => item.type === "chunk") : [],
    );

    expect(chunks.map((chunk) => chunk.fileName)).toEqual(["web.js"]);
    const [chunk] = chunks;
    expect(chunk?.moduleIds.filter((id) => id.includes("node_modules"))).toEqual([]);
    expect(chunk?.code).not.toMatch(/^import /m);
    for (const key of ["react", "jsxRuntime", "ui"]) {
      expect(chunk?.code).toContain(`globalThis.__t3PluginHost.${key}`);
    }
  });
});
