// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { build } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";

import { t3PluginWeb } from "./vite.ts";

describe("t3PluginWeb", () => {
  it("keeps a lazily imported module inside web.js, since T3 loads no other file", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-plugin-lazy-"));
    await using _root = { [Symbol.asyncDispose]: () => NodeFSP.rm(root, { recursive: true }) };
    await NodeFSP.writeFile(NodePath.join(root, "later.ts"), 'export const later = "later";\n');
    await NodeFSP.writeFile(
      NodePath.join(root, "web.tsx"),
      'export default { activate: () => import("./later.ts") };\n',
    );

    const output = await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [t3PluginWeb()],
      build: { write: false, minify: false },
    });
    const files = (Array.isArray(output) ? output : [output]).flatMap((result) =>
      "output" in result ? result.output.map((item) => item.fileName) : [],
    );
    expect(files).toEqual(["web.js"]);
  });

  it("refuses a stylesheet T3 would never load", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-plugin-css-"));
    await using _root = { [Symbol.asyncDispose]: () => NodeFSP.rm(root, { recursive: true }) };
    await NodeFSP.writeFile(NodePath.join(root, "web.css"), "p { color: red; }");
    await NodeFSP.writeFile(
      NodePath.join(root, "web.tsx"),
      'import "./web.css";\nexport default {};\n',
    );

    await expect(
      build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [t3PluginWeb()],
        build: { write: false, minify: false },
      }),
    ).rejects.toThrow("which T3 never loads");
  });
});
