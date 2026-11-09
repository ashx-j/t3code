// @effect-diagnostics nodeBuiltinImport:off - stylesheet revisions are sha256 digests.
import * as NodeCrypto from "node:crypto";

import type { PluginState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { DiscoveredPlugin } from "./pluginDiscovery.ts";

const WEB_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
};

const contentRevision = (contents: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(contents).digest("hex").slice(0, 16);

/** What an active plugin serves: the real path of its `styles/`. */
export interface PluginWebFolders {
  readonly styles: string | undefined;
}

export interface PluginWebFile {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/** Finds the stylesheets a starting plugin serves, and reads them for the host. */
export const makePluginWebFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Reads a plain file whose real path stays inside the real folder `within`, so a path or link
  // out of it, a link cycle, or a pipe reads nothing. Untraced: each caller has its span.
  const readWithin = Effect.fnUntraced(function* (within: string, file: string) {
    const resolved = yield* fs.realPath(file).pipe(Effect.option);
    if (Option.isNone(resolved)) return Option.none();
    const real = resolved.value;
    if (!real.startsWith(`${within}${path.sep}`)) return Option.none();
    const info = yield* fs.stat(real).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return Option.none();
    return yield* fs.readFile(real).pipe(
      Effect.map((body) => Option.some({ real, body })),
      Effect.orElseSucceed(() => Option.none()),
    );
  });

  // The real path of the plugin's `name` folder, unless a link takes it out of the plugin.
  const folderOf = Effect.fnUntraced(function* (plugin: DiscoveredPlugin, name: "styles") {
    const dir = yield* fs.realPath(path.join(plugin.rootDir, name)).pipe(Effect.option);
    return Option.isSome(dir) && dir.value.startsWith(`${plugin.rootDir}${path.sep}`)
      ? dir.value
      : undefined;
  });

  // The `.css` files directly in `styles/`, in name order, each with the revision for its URL.
  const stylesIn = Effect.fnUntraced(function* (dir: string) {
    const names = yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    // Only the ones it serves, so not a folder named like a stylesheet or a link out of `styles/`.
    const styles = yield* Effect.forEach(
      names.filter((name) => name.endsWith(".css")).toSorted(),
      (file) =>
        readWithin(dir, path.join(dir, file)).pipe(
          Effect.map(
            Option.match({
              onNone: () => [],
              onSome: ({ body }) => [{ file, revision: contentRevision(body) }],
            }),
          ),
        ),
    );
    return styles.flat();
  });

  /** What a starting plugin serves: `styles/`. */
  const find = Effect.fn("PluginHost.findWebFiles")(function* (plugin: DiscoveredPlugin) {
    const folders: PluginWebFolders = { styles: yield* folderOf(plugin, "styles") };
    const styles: PluginState["styles"] =
      folders.styles === undefined ? [] : yield* stylesIn(folders.styles);
    return { folders, styles };
  });

  // The file `requestPath` names, the folder it has to stay inside, and whether a revision in
  // its URL may name its contents.
  const locate = (folders: PluginWebFolders, requestPath: string) => {
    const [, rest] = /^\/styles\/(.*)$/.exec(requestPath) ?? [];
    const dir = folders.styles;
    if (dir === undefined || rest === undefined) return undefined;
    try {
      return { file: path.join(dir, decodeURIComponent(rest)), within: dir, revisioned: true };
    } catch {
      // A malformed escape names no file.
      return undefined;
    }
  };

  /**
   * Reads `/styles/<file>` of an active plugin. A request whose `revision` names the file's
   * contents may be cached for good. Untraced: the host's lookup has the span.
   */
  const read = Effect.fnUntraced(function* (
    folders: PluginWebFolders,
    requestPath: string,
    revision: string | undefined,
  ) {
    const located = locate(folders, requestPath);
    if (located === undefined) return Option.none<PluginWebFile>();
    const found = yield* readWithin(located.within, located.file);
    if (Option.isNone(found)) return Option.none<PluginWebFile>();
    const { real, body } = found.value;
    return Option.some<PluginWebFile>({
      headers: {
        "content-type":
          WEB_CONTENT_TYPES[path.extname(real).toLowerCase()] ?? "application/octet-stream",
        "cache-control":
          located.revisioned && revision !== undefined && revision === contentRevision(body)
            ? "private, max-age=31536000, immutable"
            : "no-store",
      },
      body,
    });
  });

  return { find, read };
});
