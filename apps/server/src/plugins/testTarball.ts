// @effect-diagnostics nodeBuiltinImport:off
import * as NodeZlib from "node:zlib";

const encoder = new TextEncoder();

/** A ustar entry with only the fields the extractor reads, for tests. */
export const tarEntry = (name: string, contents: string, type = "0") => {
  const data = encoder.encode(contents);
  const header = new Uint8Array(512);
  header.set(encoder.encode(name).subarray(0, 100), 0);
  header.set(encoder.encode(`${data.length.toString(8).padStart(11, "0")}\0`), 124);
  header.set(encoder.encode(type), 156);
  header.set(encoder.encode("ustar\0"), 257);
  header.set(encoder.encode("00"), 263);
  // The checksum counts its own field as spaces, then is stored as 6 octal digits, NUL, space.
  header.fill(0x20, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return [header, padded];
};

/** A gzipped tarball of `entries`, the way npm serves packages. */
export const gzipTarball = (...entries: ReadonlyArray<ReadonlyArray<Uint8Array>>) => {
  const blocks = [...entries.flat(), new Uint8Array(1024)];
  const archive = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.length;
  }
  return new Uint8Array(NodeZlib.gzipSync(archive));
};
