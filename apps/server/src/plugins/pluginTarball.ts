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

// The header checksum treats its own 8 bytes as spaces. node-tar skips a header that fails it, so
// accepting one here could install a file that npm's own tools never show.
const checksumMatches = (header: Uint8Array) => {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  return sum === octal(header, 148, 8);
};

const isUstar = (header: Uint8Array) => text(header, 257, 5) === "ustar";

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
  const paths = new Set<string>();
  let offset = 0;
  let longName: string | undefined;
  let paxSize: number | undefined;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      // The archive ends with 2 zero blocks; a lone one followed by more data is malformed.
      const next = archive.subarray(offset + BLOCK, offset + 2 * BLOCK);
      if (next.length === 0 || next.every((byte) => byte === 0)) break;
      throw new Error("The package archive is truncated or malformed.");
    }
    if (files.length >= MAX_ENTRIES) throw new Error("The package has too many files.");
    if (!checksumMatches(header)) throw new Error("The package archive is truncated or malformed.");
    const size = paxSize ?? octal(header, 124, 12);
    paxSize = undefined;
    const type = String.fromCharCode(header[156] ?? 0);
    // Only ustar headers have a prefix field; GNU headers keep other data there.
    const prefix = isUstar(header) ? text(header, 345, 155) : "";
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
      const records = new TextDecoder()
        .decode(archive.subarray(dataStart, dataEnd))
        .split("\n")
        .map((line) => line.slice(line.indexOf(" ") + 1));
      const pathRecord = records.find((record) => record.startsWith("path="));
      const sizeRecord = records.find((record) => record.startsWith("size="));
      if (pathRecord !== undefined) longName = pathRecord.slice("path=".length);
      if (sizeRecord !== undefined) paxSize = Number(sizeRecord.slice("size=".length));
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
    // npm keeps the last copy of a duplicated path; refusing makes the installed file unambiguous.
    if (paths.has(path)) throw new Error(`The package contains ${name} twice.`);
    paths.add(path);
    files.push({ path, contents: archive.slice(dataStart, dataEnd) });
  }
  return files;
}
