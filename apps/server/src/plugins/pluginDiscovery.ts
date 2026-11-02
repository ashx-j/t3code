import {
  PluginId,
  PluginManifest,
  type PluginFailure,
  type PluginSource,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const PLUGIN_MANIFEST_FILE = "t3-plugin.json";

// Discovery runs at startup and on every reload, so a plugins folder full of unrelated
// directories or an oversized manifest must not stall the server.
const MAX_PLUGIN_DIRECTORIES = 64;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_FAILURE_MESSAGE_CHARS = 500;

const decodeManifest = Schema.decodeUnknownExit(Schema.fromJsonString(PluginManifest));
const decodeLooseId = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: PluginId })),
);
const isPluginId = Schema.is(PluginId);

const causeMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

interface PluginLocation {
  readonly id: PluginId;
  readonly rootDir: string;
  /** The folder as listed, before links resolve. Installed ones are inside the plugins folder. */
  readonly folder: string;
  readonly source: PluginSource;
}

/** A plugin directory, with its manifest when it could be read and decoded. */
export type DiscoveredPlugin = PluginLocation &
  (
    | { readonly manifest: PluginManifest; readonly hasSkills: boolean }
    | { readonly failure: PluginFailure }
  );

const failed = (location: PluginLocation, failure: PluginFailure): DiscoveredPlugin => ({
  ...location,
  failure: { ...failure, message: failure.message.slice(0, MAX_FAILURE_MESSAGE_CHARS) },
});

/**
 * Lists installed plugins (`<pluginsDir>/<any folder>/t3-plugin.json`) and dev plugins
 * (`devPaths`). Each id is used once: an installed plugin wins over a dev plugin, and a folder
 * named after its plugin's id over other copies. The copies that lose are reported as failed.
 */
export const discoverPlugins = Effect.fn("PluginDiscovery.discover")(function* (input: {
  readonly pluginsDir: string;
  readonly devPaths: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const readManifest = Effect.fnUntraced(function* (rootDir: string) {
    const manifestPath = path.join(rootDir, PLUGIN_MANIFEST_FILE);
    const info = yield* fs.stat(manifestPath).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "File") {
      return { _tag: "Missing" } as const;
    }
    if (Number(info.value.size) > MAX_MANIFEST_BYTES) {
      return { _tag: "TooLarge" } as const;
    }
    const raw = yield* fs.readFileString(manifestPath).pipe(Effect.option);
    return raw._tag === "None"
      ? ({ _tag: "Missing" } as const)
      : ({ _tag: "Read", raw: raw.value } as const);
  });

  // Node caches modules by real path, so reload can only find a plugin's modules by its real root.
  const inspect = Effect.fnUntraced(function* (
    location: string,
    source: PluginSource,
    fallbackId: PluginId | undefined,
  ) {
    const rootDir = yield* fs.realPath(location).pipe(Effect.orElseSucceed(() => location));
    const manifest = yield* readManifest(rootDir);
    if (manifest._tag !== "Read") {
      if (fallbackId === undefined) return undefined;
      return failed(
        { id: fallbackId, rootDir, folder: location, source },
        {
          stage: "discovery",
          message:
            manifest._tag === "Missing"
              ? `No ${PLUGIN_MANIFEST_FILE} in the plugin folder.`
              : `${PLUGIN_MANIFEST_FILE} is larger than ${MAX_MANIFEST_BYTES} bytes.`,
        },
      );
    }
    const decoded = decodeManifest(manifest.raw);
    if (decoded._tag === "Success") {
      const hasSkills = yield* fs
        .exists(path.join(rootDir, "skills"))
        .pipe(Effect.orElseSucceed(() => false));
      return {
        id: decoded.value.id,
        rootDir,
        folder: location,
        source,
        manifest: decoded.value,
        hasSkills,
      } as const;
    }
    const looseId = decodeLooseId(manifest.raw);
    const id = looseId._tag === "Some" ? looseId.value.id : fallbackId;
    if (id === undefined) return undefined;
    return failed(
      { id, rootDir, folder: location, source },
      {
        stage: "manifest",
        message: `Invalid ${PLUGIN_MANIFEST_FILE}: ${causeMessage(decoded.cause)}`,
      },
    );
  });

  const plugins: Array<DiscoveredPlugin> = [];
  const seen = new Set<string>();
  let examined = 0;
  const underLimit = Effect.fnUntraced(function* (location: string) {
    examined += 1;
    if (examined <= MAX_PLUGIN_DIRECTORIES) return true;
    yield* Effect.logWarning("ignoring plugin folders past the limit", {
      path: location,
      limit: MAX_PLUGIN_DIRECTORIES,
    });
    return false;
  });

  const entries = yield* fs
    .readDirectory(input.pluginsDir)
    .pipe(Effect.orElseSucceed((): Array<string> => []));
  // People copy plugin folders in by hand, so the manifest names the plugin, not the folder.
  const installed: Array<DiscoveredPlugin> = [];
  for (const entry of entries.toSorted()) {
    if (entry.startsWith(".")) continue;
    const folder = path.join(input.pluginsDir, entry);
    const info = yield* fs.stat(folder).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "Directory") continue;
    if (!(yield* underLimit(input.pluginsDir))) break;
    const plugin = yield* inspect(folder, "installed", isPluginId(entry) ? entry : undefined);
    if (plugin === undefined) {
      yield* Effect.logWarning("ignoring plugin folder without a plugin id", { path: folder });
      continue;
    }
    installed.push(plugin);
  }
  const namedAfterId = (plugin: DiscoveredPlugin) => path.basename(plugin.folder) === plugin.id;
  const used = new Map<PluginId, DiscoveredPlugin>();
  for (const plugin of installed) {
    const current = used.get(plugin.id);
    if (current === undefined || (!namedAfterId(current) && namedAfterId(plugin))) {
      used.set(plugin.id, plugin);
    }
  }
  // Losing copies go last: the host finds a plugin's record by id and takes the first.
  for (const plugin of installed) {
    if (used.get(plugin.id) === plugin) plugins.push(plugin);
  }
  for (const plugin of installed) {
    const winner = used.get(plugin.id);
    if (winner === undefined || winner === plugin) continue;
    plugins.push(
      failed(plugin, {
        stage: "discovery",
        message: `Another copy of this plugin, in the "${path.basename(winner.folder)}" folder, is used instead.`,
      }),
    );
  }
  for (const id of used.keys()) seen.add(id);

  for (const devPath of input.devPaths) {
    const rootDir = path.resolve(devPath);
    if (!(yield* underLimit(rootDir))) break;
    const basename = path.basename(rootDir);
    const plugin = yield* inspect(rootDir, "dev", isPluginId(basename) ? basename : undefined);
    if (plugin === undefined) {
      yield* Effect.logWarning("ignoring dev plugin path without a usable plugin id", {
        path: rootDir,
      });
      continue;
    }
    if (seen.has(plugin.id)) {
      plugins.push(
        failed(plugin, {
          stage: "discovery",
          message:
            "Another plugin with this id is already loaded from the plugins folder or an earlier dev path.",
        }),
      );
      continue;
    }
    seen.add(plugin.id);
    plugins.push(plugin);
  }

  return plugins;
});
