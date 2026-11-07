import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { PLUGIN_UPLOAD_MAX_BYTES, PluginInstallFilesInput, PluginManifest } from "./plugins.ts";

const decodeManifest = Schema.decodeUnknownSync(PluginManifest);

const manifest = {
  id: "hello-plugin",
  name: "Hello",
  version: "0.1.0",
  engines: { t3: ">=0.1.6" },
  server: "./dist/server.cjs",
  settingsSchema: { type: "object", properties: { greeting: { type: "string" } } },
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
    ["a server entry that escapes the plugin directory", { server: "../other/server.cjs" }],
    ["an absolute server entry", { server: "/usr/lib/server.cjs" }],
    ["a Windows server entry", { server: "C:\\plugins\\server.cjs" }],
    ["a server entry that is not CommonJS", { server: "dist/server.js" }],
  ])("rejects %s", (_name, override) => {
    expect(() => decodeManifest({ ...manifest, ...override })).toThrow();
  });
});

const decodeFileTypes = Schema.decodeUnknownSync(Schema.toType(PluginInstallFilesInput));

describe("PluginInstallFilesInput", () => {
  const decodeFiles = Schema.decodeUnknownSync(PluginInstallFilesInput);

  it("decodes file contents from base64 and refuses paths outside the folder", () => {
    expect(decodeFiles({ files: [{ path: "dist/web.js", contents: "aGk=" }] }).files[0]).toEqual({
      path: "dist/web.js",
      contents: new TextEncoder().encode("hi"),
    });
    for (const path of ["../outside.js", "/etc/passwd", "C:/plugin/web.js", "dist\\web.js"]) {
      expect(() => decodeFiles({ files: [{ path, contents: "" }] })).toThrow();
    }
  });

  it("refuses a folder over the size limit with a reason", () => {
    const half = new Uint8Array(PLUGIN_UPLOAD_MAX_BYTES / 2 + 1);
    const files = [
      { path: "a.bin", contents: half },
      { path: "b.bin", contents: half },
    ];
    expect(() => decodeFileTypes({ files })).toThrow("A plugin folder can have up to 25 MB.");
  });
});
