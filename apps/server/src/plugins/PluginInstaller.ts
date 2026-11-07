import {
  type PluginId,
  PluginManifest,
  type PluginInstallSource,
  type PluginState,
  type PluginUploadFile,
} from "@t3tools/contracts";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import type { DiscoveredPlugin } from "./pluginDiscovery.ts";
import type { PluginConfigError, PluginNotFoundError, PluginsConfigFile } from "./PluginHost.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";

// `reason` is shown to the user as is, so it says what to fix.
export class PluginInstallError extends Schema.TaggedError<PluginInstallError>()(
  "PluginInstallError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * Installs, links and removes plugins. The host builds it and hands it the lifecycle lock, the
 * plugin list and plugins.json, so the host keeps discovery, activation and state, and a new
 * install source only changes this file.
 */
export class PluginInstaller extends Context.Service<
  PluginInstaller,
  {
    /**
     * Copies a plugin folder on the server into the plugins folder, enables it and starts it. It
     * is staged first and swapped in with a rename, so a failed install leaves the previous
     * version. A `link` folder is added to `devPaths` instead, so its edits apply on reload.
     */
    readonly install: (
      source: PluginInstallSource,
    ) => Effect.Effect<PluginState, PluginInstallError | PluginNotFoundError | PluginConfigError>;
    /** Installs a plugin folder a client sent as files, like `install`. */
    readonly installFiles: (
      files: ReadonlyArray<PluginUploadFile>,
    ) => Effect.Effect<PluginState, PluginInstallError | PluginNotFoundError | PluginConfigError>;
    /**
     * Stops a plugin and deletes its folder, settings, secrets and storage; a linked folder is
     * only forgotten. `linkedFolder` names one linked copy. When another copy with its id is in
     * use, only that link is forgotten, and the copy in use keeps running with the data.
     */
    readonly uninstall: (
      pluginId: PluginId,
      linkedFolder?: string,
    ) => Effect.Effect<void, PluginInstallError | PluginNotFoundError | PluginConfigError>;
  }
>()("t3/plugins/PluginInstaller") {}

/** What the installer needs from the host that builds it. */
export interface PluginInstallerHost {
  /**
   * Runs `body` under the lifecycle lock in the host's scope, so a caller that disconnects only
   * stops waiting and never leaves a plugin half replaced.
   */
  readonly lifecycle: <A, E>(body: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  /** Every listed copy in discovery's order, which puts the copy in use before its shadows. */
  readonly copies: Effect.Effect<ReadonlyArray<DiscoveredPlugin>>;
  /** The copy of `pluginId` in use. */
  readonly copyOf: (pluginId: PluginId) => Effect.Effect<DiscoveredPlugin, PluginNotFoundError>;
  /** Stops a plugin; the caller sets what comes next. Only under `lifecycle`. */
  readonly stop: (pluginId: PluginId) => Effect.Effect<void>;
  /**
   * Drops the copy of `pluginId` listed from `folder`; a copy it shadowed is found afresh.
   * Only under `lifecycle`.
   */
  readonly forget: (pluginId: PluginId, folder: string) => Effect.Effect<void, PluginConfigError>;
  /** Rescans the plugin folders and restarts the plugin, waiting until it has started. */
  readonly reload: (
    pluginId: PluginId,
  ) => Effect.Effect<PluginState, PluginNotFoundError | PluginConfigError>;
  /** plugins.json as last read or written. */
  readonly config: Effect.Effect<PluginsConfigFile>;
  readonly writeConfig: (
    update: (current: PluginsConfigFile) => PluginsConfigFile,
  ) => Effect.Effect<void, PluginConfigError>;
}

/** What an install takes a plugin from: a folder on the server, or files a client sent. */
type InstallOrigin =
  | { readonly folder: string }
  | { readonly files: ReadonlyArray<PluginUploadFile> };

const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));

const installFailed = (reason: string) => (cause: unknown) =>
  new PluginInstallError({ reason, cause });

/** Builds the installer for the host. `recoverStaging` runs before the host's first discovery. */
export const make = Effect.fn("PluginInstaller.make")(function* (host: PluginInstallerHost) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const settingsStore = yield* PluginSettingsStore.PluginSettingsStore;
  const storage = yield* PluginStorage.PluginStorage;
  const scope = yield* Effect.scope;

  const pluginsDir = path.join(config.stateDir, "plugins");
  const stagingRoot = path.join(config.stateDir, "plugin-staging");

  // An install interrupted mid-swap (a crash) can leave the old version only in staging. Put it
  // back if nothing replaced it, then drop every leftover staging folder.
  // Listed while the layer builds, before the server serves requests, so recovery never touches
  // the staging folder of an install that starts after that.
  const leftoverStaging = yield* fs
    .readDirectory(stagingRoot)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const recoverStaging = Effect.gen(function* () {
    for (const entry of leftoverStaging) {
      const previous = path.join(stagingRoot, entry, "previous");
      const manifest = yield* fs
        .readFileString(path.join(previous, "t3-plugin.json"))
        .pipe(Effect.flatMap(decodeManifestJson), Effect.option);
      if (Option.isSome(manifest)) {
        const target = path.join(pluginsDir, manifest.value.id);
        const replaced = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true));
        if (!replaced) {
          yield* fs.makeDirectory(pluginsDir, { recursive: true }).pipe(Effect.ignore);
          yield* fs.rename(previous, target).pipe(Effect.ignore);
        }
      }
      yield* fs
        .remove(path.join(stagingRoot, entry), { recursive: true, force: true })
        .pipe(Effect.ignore);
    }
  }).pipe(Effect.withSpan("PluginInstaller.recoverStaging"));

  // A caller that disconnects stops waiting but cannot interrupt a swap or a staging cleanup.
  const inHostScope = <A, E>(body: Effect.Effect<A, E>) =>
    body.pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join));

  const readSourceManifest = (folder: string) =>
    fs.readFileString(path.join(folder, "t3-plugin.json")).pipe(
      Effect.mapError(installFailed("The source has no t3-plugin.json.")),
      Effect.flatMap((raw) =>
        decodeManifestJson(raw).pipe(
          Effect.mapError(installFailed("The source's t3-plugin.json is not a valid manifest.")),
        ),
      ),
    );

  // The upload schema checks that every path stays inside `into`.
  const writeFiles = Effect.fn("PluginInstaller.writeFiles")(function* (
    files: ReadonlyArray<{ readonly path: string; readonly contents: Uint8Array }>,
    into: string,
  ) {
    for (const file of files) {
      const target = path.join(into, ...file.path.split("/"));
      yield* fs
        .makeDirectory(path.dirname(target), { recursive: true })
        .pipe(
          Effect.andThen(fs.writeFile(target, file.contents)),
          Effect.mapError(installFailed(`Could not write ${file.path}.`)),
        );
    }
  });

  // Plugins run with T3's own access, so install takes code only from the folder the user named.
  const copyFolder = Effect.fn("PluginInstaller.copyFolder")(function* (
    folder: string,
    into: string,
  ) {
    const from = path.resolve(folder);
    const info = yield* fs
      .stat(from)
      .pipe(Effect.mapError(installFailed(`${folder} does not exist on the server.`)));
    if (info.type !== "Directory") {
      return yield* new PluginInstallError({ reason: `${folder} is not a folder.` });
    }
    // Before copying, so a folder that is not a plugin (a home folder) is never copied.
    yield* readSourceManifest(from);
    // Copied rather than linked: the installed plugin never changes when the source does.
    yield* fs.copy(from, into).pipe(Effect.mapError(installFailed(`Could not copy ${folder}.`)));
  });

  /** Why this server cannot run `manifest`, checked before anything is stopped or moved. */
  const engineRefusal = (manifest: PluginManifest) =>
    satisfiesSemverRange(packageJson.version, manifest.engines.t3)
      ? undefined
      : `${manifest.name} ${manifest.version} needs T3 Code ${manifest.engines.t3}, and this server is ${packageJson.version}.`;

  /**
   * Swaps `<stagingDir>/plugin` into the plugins folder under the lifecycle lock and starts it. The
   * replaced version waits in `<stagingDir>/previous` and goes back if the new one fails to start.
   * `stagingDir` is removed unless it holds a version's only copy, which startup then restores.
   */
  const swapIn = Effect.fn("PluginInstaller.swapIn")(function* (
    manifest: PluginManifest,
    stagingDir: string,
  ) {
    const staged = path.join(stagingDir, "plugin");
    const previous = path.join(stagingDir, "previous");
    let stopped = false;
    let stranded = false;
    yield* Effect.addFinalizer(() => (stranded ? Effect.void : removeStaging(stagingDir)));
    const swapped = yield* host
      .lifecycle(
        // Read under the lock, so another install or a removal cannot change them before the swap.
        Effect.gen(function* () {
          const copies = yield* host.copies;
          const existing = copies.find((copy) => copy.id === manifest.id);
          if (existing?.source === "dev") {
            return yield* new PluginInstallError({
              reason: `${manifest.id} is linked from ${existing.folder}. Unlink it first.`,
            });
          }
          const target =
            existing === undefined ? path.join(pluginsDir, manifest.id) : existing.folder;
          // A folder put there by hand holds another plugin, or none, which the swap would delete.
          if (
            existing === undefined &&
            (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true)))
          ) {
            const owner = copies.find((copy) => copy.folder === target);
            return yield* new PluginInstallError({
              reason: `The plugins folder already has a ${manifest.id} folder${owner === undefined ? "" : ` holding ${owner.id}`}. Move it, then install again.`,
            });
          }
          // Installing over a disabled plugin keeps it disabled; a new install is enabled.
          const enabled =
            existing === undefined ? true : (yield* host.config).enabled?.[manifest.id] === true;
          stopped = true;
          yield* host.stop(manifest.id);
          yield* fs
            .makeDirectory(pluginsDir, { recursive: true })
            .pipe(Effect.mapError(installFailed("Could not create the plugins folder.")));
          const hadPrevious = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false));
          if (hadPrevious) {
            yield* fs
              .rename(target, previous)
              .pipe(Effect.mapError(installFailed("Could not move the installed version aside.")));
          }
          yield* fs.rename(staged, target).pipe(
            Effect.mapError(installFailed("Could not move the new version into place.")),
            Effect.tapError(() =>
              hadPrevious ? fs.rename(previous, target).pipe(Effect.ignore) : Effect.void,
            ),
          );
          yield* host.writeConfig((current) => ({
            ...current,
            enabled: { ...current.enabled, [manifest.id]: enabled },
          }));
          return {
            target,
            hadPrevious,
            replacedVersion:
              existing !== undefined && "manifest" in existing
                ? existing.manifest.version
                : undefined,
          };
        }),
      )
      .pipe(
        // Whatever failed after the stop, the plugin folder holds one version; start it again.
        Effect.onError(() =>
          stopped ? host.reload(manifest.id).pipe(Effect.ignore) : Effect.void,
        ),
      );
    const started = yield* host.reload(manifest.id);
    if (!swapped.hadPrevious || started.status !== "failed") return started;
    yield* host
      .lifecycle(
        Effect.gen(function* () {
          yield* host.stop(manifest.id);
          yield* fs
            .rename(swapped.target, path.join(stagingDir, "failed"))
            .pipe(Effect.mapError(installFailed("Could not move the failed version aside.")));
          yield* fs.rename(previous, swapped.target).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                stranded = true;
              }),
            ),
            Effect.mapError(
              installFailed("Could not put the previous version back. Restart T3 Code to finish."),
            ),
          );
        }),
      )
      .pipe(Effect.ensuring(host.reload(manifest.id).pipe(Effect.ignore)));
    return yield* new PluginInstallError({
      reason: `${manifest.name} ${manifest.version} failed to start, so ${swapped.replacedVersion ?? "the previous version"} is back. It failed with: ${started.failure?.message ?? "an unknown error"}`,
    });
  }, Effect.scoped);

  /** Copies `origin` into a new staging folder and returns the folder and what it holds. */
  const stage = Effect.fn("PluginInstaller.stage")(function* (origin: InstallOrigin) {
    const stagingDir = path.join(stagingRoot, yield* crypto.randomUUIDv4().pipe(Effect.orDie));
    const staged = path.join(stagingDir, "plugin");
    yield* fs
      .makeDirectory(stagingDir, { recursive: true })
      .pipe(Effect.mapError(installFailed("Could not create the staging folder.")));
    return yield* Effect.gen(function* () {
      yield* "folder" in origin
        ? copyFolder(origin.folder, staged)
        : writeFiles(origin.files, staged);
      return { stagingDir, manifest: yield* readSourceManifest(staged) };
    }).pipe(Effect.tapError(() => removeStaging(stagingDir)));
  });

  const removeStaging = (stagingDir: string) =>
    fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore);

  const installOrigin = Effect.fn("PluginInstaller.installOrigin")(function* (
    origin: InstallOrigin,
  ) {
    const { stagingDir, manifest } = yield* stage(origin);
    const refusal = engineRefusal(manifest);
    if (refusal !== undefined) {
      yield* removeStaging(stagingDir);
      return yield* new PluginInstallError({ reason: refusal });
    }
    return yield* swapIn(manifest, stagingDir);
  });

  // A folder loaded where it is, so an author's edits plus a reload are the whole loop.
  const linkFolder = Effect.fn("PluginInstaller.link")(function* (folder: string) {
    const from = path.resolve(folder);
    const info = yield* fs
      .stat(from)
      .pipe(Effect.mapError(installFailed(`${folder} does not exist on the server.`)));
    if (info.type !== "Directory") {
      return yield* new PluginInstallError({ reason: `${folder} is not a folder.` });
    }
    const manifest = yield* readSourceManifest(from);
    const existing = (yield* host.copies).find((copy) => copy.id === manifest.id);
    // Linking an installed plugin's own folder would list it twice, and the copy that loses
    // shares its id, so removing that copy would delete the installed one.
    if (existing !== undefined && existing.source !== "dev") {
      return yield* new PluginInstallError({
        reason: `${manifest.id} is already installed. Remove it first.`,
      });
    }
    if (existing !== undefined && existing.folder !== from) {
      return yield* new PluginInstallError({
        reason: `${manifest.id} is already linked from ${existing.folder}. Unlink it first.`,
      });
    }
    // Discovery lists what is in the plugins folder as installed, and that copy wins, so removing
    // the plugin would delete the folder instead of unlinking it.
    const realPath = (target: string) =>
      fs.realPath(target).pipe(Effect.orElseSucceed(() => target));
    const fromPlugins = path.relative(yield* realPath(pluginsDir), yield* realPath(from));
    const outside =
      fromPlugins === ".." ||
      fromPlugins.startsWith(`..${path.sep}`) ||
      path.isAbsolute(fromPlugins);
    if (!outside) {
      return yield* new PluginInstallError({
        reason: `${folder} is already in the plugins folder, so T3 finds it there without a link, and removing it deletes it. To keep the folder when removing the plugin, link one outside ${pluginsDir}.`,
      });
    }
    yield* host.writeConfig((current) => ({
      ...current,
      devPaths: [...(current.devPaths ?? []).filter((entry) => path.resolve(entry) !== from), from],
      enabled: { ...current.enabled, [manifest.id]: true },
    }));
    return yield* host.reload(manifest.id);
  });

  const install: PluginInstaller["Service"]["install"] = Effect.fn("PluginInstaller.install")(
    (source) =>
      inHostScope(
        source.link === true ? linkFolder(source.path) : installOrigin({ folder: source.path }),
      ),
  );

  // `PluginInstallFilesInput` bounds the folder's size before it gets here.
  const installFiles: PluginInstaller["Service"]["installFiles"] = Effect.fn(
    "PluginInstaller.installFiles",
  )((files) => inHostScope(installOrigin({ files })));

  const removeFromConfig = (pluginId: PluginId) =>
    host.writeConfig((current) => {
      const { [pluginId]: _removed, ...enabled } = current.enabled ?? {};
      return { ...current, enabled };
    });

  const forgetDevPath = (folder: string) =>
    host.writeConfig((current) => ({
      ...current,
      devPaths: (current.devPaths ?? []).filter((entry) => path.resolve(entry) !== folder),
    }));

  const uninstall: PluginInstaller["Service"]["uninstall"] = Effect.fn("PluginInstaller.uninstall")(
    function* (pluginId, linkedFolder) {
      const plugin = yield* host.copyOf(pluginId);
      if (linkedFolder !== undefined) {
        const folder = path.resolve(linkedFolder);
        const copies = (yield* host.copies).filter((copy) => copy.id === pluginId);
        const link = copies.findIndex((copy) => copy.source === "dev" && copy.folder === folder);
        if (link === -1) {
          return yield* new PluginInstallError({
            reason: `No copy of ${pluginId} is linked from ${linkedFolder}.`,
          });
        }
        // The first copy is the one in use. It keeps running, with the settings and storage the
        // other copies share.
        if (link > 0) {
          return yield* host.lifecycle(
            forgetDevPath(folder).pipe(Effect.andThen(host.forget(pluginId, folder))),
          );
        }
      }
      const { folder, source } = plugin;
      const settingsSchema = "manifest" in plugin ? plugin.manifest.settingsSchema : undefined;
      yield* host.lifecycle(
        Effect.gen(function* () {
          yield* host.stop(pluginId);
          if (source === "dev") {
            // A linked folder is the author's own; only plugins.json forgets it.
            yield* forgetDevPath(folder);
          } else {
            // The folder as listed, not `rootDir`: that is the real path, so a symlinked plugin
            // would delete the user's own folder behind the link.
            yield* fs
              .remove(folder, { recursive: true, force: true })
              .pipe(Effect.mapError(installFailed(`Could not delete ${folder}.`)));
          }
          yield* removeFromConfig(pluginId);
          yield* host.forget(pluginId, folder);
          // Under the lock, or an install that starts meanwhile could lose its new settings.
          yield* settingsStore
            .clear(pluginId, settingsSchema)
            .pipe(
              Effect.mapError(installFailed("The plugin is removed, but its settings are not.")),
            );
          yield* storage
            .clear(pluginId)
            .pipe(Effect.mapError(installFailed("The plugin is removed, but its storage is not.")));
        }),
      );
    },
  );

  return {
    installer: PluginInstaller.of({ install, installFiles, uninstall }),
    recoverStaging,
  };
});
