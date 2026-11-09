import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { PluginManifest } from "./plugins.ts";

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
