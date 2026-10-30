// @effect-diagnostics nodeBuiltinImport:off - gunzip needs node:zlib; the archive is in memory.
import * as NodeZlib from "node:zlib";

const BLOCK = 512;
// npm packs every file under `package/`; plugins are small, so anything bigger is refused.
const PACKAGE_PREFIX = "package/";
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 4096;

export interface TarballFile {
  /** Relative to the package root, with `/` separators and no `.` or `..` segments. */
  readonly path: string;
  readonly contents: Uint8Array;
}

const text = (block: Uint8Array, start: number, length: number) => {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end));
};

const octal = (block: Uint8Array, start: number, length: number) => {
  const value = text(block, start, length).trim();
  return value === "" ? 0 : Number.parseInt(value, 8);
};

const isSafeRelativePath = (path: string) =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

/**
 * The regular files of an npm package tarball (gzipped ustar), relative to its `package/` folder.
 * Throws on anything but plain files and folders (links, devices), on paths that would leave the
 * package, and past the size and entry caps, so nothing from the archive is written unchecked.
 */
export function unpackNpmTarball(gzipped: Uint8Array): ReadonlyArray<TarballFile> {
  const archive = NodeZlib.gunzipSync(gzipped, { maxOutputLength: MAX_UNPACKED_BYTES });
  const files: Array<TarballFile> = [];
  let offset = 0;
  let longName: string | undefined;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (files.length >= MAX_ENTRIES) throw new Error("The package has too many files.");
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = text(header, 345, 155);
    const name =
      longName ?? (prefix === "" ? text(header, 0, 100) : `${prefix}/${text(header, 0, 100)}`);
    longName = undefined;
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || dataEnd > archive.length) {
      throw new Error("The package archive is truncated or malformed.");
    }
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    // GNU long names and pax headers describe the next entry; pax "path" overrides its name.
    if (type === "L") {
      longName = text(archive, dataStart, size);
      continue;
    }
    if (type === "x") {
      const pathRecord = new TextDecoder()
        .decode(archive.subarray(dataStart, dataEnd))
        .split("\n")
        .map((line) => line.slice(line.indexOf(" ") + 1))
        .find((record) => record.startsWith("path="));
      if (pathRecord !== undefined) longName = pathRecord.slice("path=".length);
      continue;
    }
    if (type === "g") continue;
    if (type === "5") continue;
    if (type !== "0" && type !== "\0") {
      throw new Error(`The package contains ${name}, which is not a plain file.`);
    }
    if (!name.startsWith(PACKAGE_PREFIX)) {
      throw new Error(`The package contains ${name} outside its package folder.`);
    }
    const path = name.slice(PACKAGE_PREFIX.length);
    if (!isSafeRelativePath(path)) throw new Error(`The package contains an unsafe path: ${name}.`);
    files.push({ path, contents: archive.slice(dataStart, dataEnd) });
  }
  return files;
}
