import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { PLUGIN_UPLOAD_MAX_BYTES, PluginManifest, PluginUploadFiles } from "./plugins.ts";

const decodeManifest = Schema.decodeUnknownSync(PluginManifest);

const manifest = {
  id: "hello-plugin",
  name: "Hello",
  version: "0.1.0",
  engines: { t3: ">=0.1.6" },
  permissions: ["Reads thread titles"],
};

describe("PluginManifest", () => {
  it("decodes a valid manifest", () => {
    expect(decodeManifest(manifest)).toEqual(manifest);
    expect(decodeManifest({ ...manifest, version: "1.0.0-beta.2+build.5" }).version).toBe(
      "1.0.0-beta.2+build.5",
    );
    expect(decodeManifest({ ...manifest, engines: { t3: "^0.1 || >=1.0.0 <2" } }).engines.t3).toBe(
      "^0.1 || >=1.0.0 <2",
    );
  });

  it("loads a manifest written when it could have `contributes`, without the key", () => {
    expect(decodeManifest({ ...manifest, contributes: { panels: [] } })).toEqual(manifest);
  });

  it.each([
    ["a missing id", { id: undefined }],
    ["an id with uppercase letters", { id: "Hello" }],
    ["an id with an underscore", { id: "hello_plugin" }],
    ["a version that is not semver", { version: "1.0" }],
    ["an engines range the host cannot evaluate", { engines: { t3: "~0.1.6" } }],
  ])("rejects %s", (_name, override) => {
    expect(() => decodeManifest({ ...manifest, ...override })).toThrow();
  });
});

describe("PluginUploadFiles", () => {
  const decodeFiles = Schema.decodeUnknownSync(PluginUploadFiles);

  it("refuses paths outside the folder", () => {
    const contents = new TextEncoder().encode("hi");
    expect(decodeFiles([{ path: "dist/web.js", contents }])[0]).toEqual({
      path: "dist/web.js",
      contents,
    });
    for (const path of ["../outside.js", "/etc/passwd", "C:/plugin/web.js", "dist\\web.js"]) {
      expect(() => decodeFiles([{ path, contents }])).toThrow();
    }
  });

  it("refuses a folder over the size limit with a reason", () => {
    const half = new Uint8Array(PLUGIN_UPLOAD_MAX_BYTES / 2 + 1);
    const files = [
      { path: "a.bin", contents: half },
      { path: "b.bin", contents: half },
    ];
    expect(() => decodeFiles(files)).toThrow("A plugin folder can have up to 25 MB.");
  });
});
