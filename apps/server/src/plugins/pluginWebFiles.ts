// @effect-diagnostics nodeBuiltinImport:off - bundle revisions are sha256 digests.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { DiscoveredPlugin } from "./pluginDiscovery.ts";
import * as PluginHttpRoutes from "./PluginHttpRoutes.ts";

const WEB_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const contentRevision = (contents: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(contents).digest("hex").slice(0, 16);

/**
 * Builds what serves a starting plugin's `web.js`, `assets/` and `styles/` among its HTTP routes.
 * The host stops them with the plugin's other routes.
 */
export const makePluginWebFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpRoutes = yield* PluginHttpRoutes.PluginHttpRoutes;
  const context = yield* Effect.context<never>();

  // Web files are served from the plugin's real folder; a path or symlink out of `within` is refused.
  // A request whose `revision` names the file's contents may be cached for good.
  const readWebFile = Effect.fn("PluginHost.readWebFile")(function* (
    within: string,
    file: string | undefined,
    revision?: string,
  ) {
    const notFound = { status: 404, body: "Not found." };
    if (file === undefined) return notFound;
    const resolved = yield* fs.realPath(file).pipe(Effect.option);
    if (Option.isNone(resolved)) return notFound;
    const real = resolved.value;
    if (real !== within && !real.startsWith(`${within}${path.sep}`)) return notFound;
    const info = yield* fs.stat(real).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return notFound;
    const body = yield* fs.readFile(real);
    return {
      status: 200,
      headers: {
        "content-type":
          WEB_CONTENT_TYPES[path.extname(real).toLowerCase()] ?? "application/octet-stream",
        "cache-control":
          revision !== undefined && revision === contentRevision(body)
            ? "private, max-age=31536000, immutable"
            : "no-store",
      },
      body,
    };
  });

  const registerFileRoute = (
    plugin: DiscoveredPlugin,
    routePath: string,
    read: (requestPath: string) => string | undefined,
    within: string,
    revisioned = false,
  ) =>
    httpRoutes
      .register({
        pluginId: plugin.id,
        method: "GET",
        path: routePath,
        handler: (request) =>
          Effect.runPromiseWith(context)(
            readWebFile(within, read(request.path), revisioned ? request.query.v : undefined),
          ),
      })
      .pipe(Effect.orDie);

  // Serves the plugin's `name` folder below `/<name>/` and resolves with its real path, if it has
  // one. A symlinked folder outside the plugin would serve whatever it points at.
  const serveFolder = Effect.fn("PluginHost.serveFolder")(function* (
    plugin: DiscoveredPlugin,
    name: "assets" | "styles",
    revisioned: boolean,
  ) {
    const dir = yield* fs.realPath(path.join(plugin.rootDir, name)).pipe(Effect.option);
    if (Option.isNone(dir) || !dir.value.startsWith(`${plugin.rootDir}${path.sep}`)) return;
    yield* registerFileRoute(
      plugin,
      `/${name}/*`,
      (requestPath) => {
        try {
          return path.join(dir.value, decodeURIComponent(requestPath.slice(`/${name}/`.length)));
        } catch {
          // A malformed escape names no file.
          return undefined;
        }
      },
      dir.value,
      revisioned,
    );
    return dir.value;
  });

  /** Serves the web bundle at `entry` and the `assets/` folder; resolves with the bundle's revision. */
  const serveWebFiles = Effect.fn("PluginHost.serveWebFiles")(function* (
    plugin: DiscoveredPlugin,
    entry: string,
  ) {
    const bundle = path.join(plugin.rootDir, entry);
    yield* registerFileRoute(plugin, "/web.js", () => bundle, plugin.rootDir, true);
    yield* serveFolder(plugin, "assets", false);
    // The bundle's contents now, for its URL; one that cannot be read gets no revision.
    return yield* fs
      .readFile(bundle)
      .pipe(Effect.map(contentRevision), Effect.option, Effect.map(Option.getOrUndefined));
  });

  // The `.css` files directly in `styles/`, in name order, each with the revision for its URL.
  const serveStyles = Effect.fn("PluginHost.serveStyles")(function* (plugin: DiscoveredPlugin) {
    const dir = yield* serveFolder(plugin, "styles", true);
    if (dir === undefined) return [];
    const names = yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const styles = yield* Effect.forEach(
      names.filter((name) => name.endsWith(".css")).toSorted(),
      (file) =>
        fs.readFile(path.join(dir, file)).pipe(
          Effect.map((contents) => [{ file, revision: contentRevision(contents) }]),
          // Such as a folder named like a stylesheet.
          Effect.orElseSucceed(() => []),
        ),
    );
    return styles.flat();
  });

  return { serveWebFiles, serveStyles };
});
