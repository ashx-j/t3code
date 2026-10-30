import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { PluginManifest } from "./plugins.ts";

const decodeManifest = Schema.decodeUnknownSync(PluginManifest);

const manifest = {
  id: "hello-plugin",
  name: "Hello",
  version: "0.1.0",
  engines: { t3: ">=0.1.6" },
  server: "./dist/server.cjs",
  web: "dist/web.js",
  settingsSchema: { type: "object", properties: { greeting: { type: "string" } } },
  permissions: ["Reads thread titles"],
  contributes: {},
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

  it.each([
    ["a missing id", { id: undefined }],
    ["an id with uppercase letters", { id: "Hello" }],
    ["an id with an underscore", { id: "hello_plugin" }],
    ["a version that is not semver", { version: "1.0" }],
    ["an engines range the host cannot evaluate", { engines: { t3: "~0.1.6" } }],
    ["an unknown contribution kind", { contributes: { panels: [] } }],
    ["a server entry that escapes the plugin directory", { server: "../other/server.cjs" }],
    ["an absolute server entry", { server: "/usr/lib/server.cjs" }],
    ["a Windows server entry", { server: "C:\\plugins\\server.cjs" }],
    ["a server entry that is not CommonJS", { server: "dist/server.js" }],
    ["a web entry that escapes the plugin directory", { web: "dist/../../web.js" }],
  ])("rejects %s", (_name, override) => {
    expect(() => decodeManifest({ ...manifest, ...override })).toThrow();
  });
});
