import { describe, expect, it } from "vite-plus/test";

import { unpackNpmTarball } from "./pluginTarball.ts";
import { gzipTarball as tarball, tarEntry as entry } from "./testTarball.ts";

describe("unpackNpmTarball", () => {
  it("returns the package's files relative to its folder", () => {
    const files = unpackNpmTarball(
      tarball(
        entry("package/", "", "5"),
        entry("package/t3-plugin.json", '{"id":"hello"}'),
        entry("package/dist/web.js", "export default {}"),
        entry("PaxHeader", "30 path=package/a-long-name.txt\n", "x"),
        entry("ignored", "long name"),
      ),
    );
    expect(files.map((file) => [file.path, new TextDecoder().decode(file.contents)])).toEqual([
      ["t3-plugin.json", '{"id":"hello"}'],
      ["dist/web.js", "export default {}"],
      ["a-long-name.txt", "long name"],
    ]);
  });

  it.each([
    ["a path that leaves the package", entry("package/../escape.js", "x"), /unsafe path/],
    ["a file outside the package folder", entry("other/file.js", "x"), /outside its package/],
    ["a symlink", entry("package/link", "", "2"), /not a plain file/],
    ["a hard link", entry("package/hard", "", "1"), /not a plain file/],
  ])("refuses %s", (_label, bad, message) => {
    expect(() => unpackNpmTarball(tarball(entry("package/ok.js", "ok"), bad))).toThrow(message);
  });
});
