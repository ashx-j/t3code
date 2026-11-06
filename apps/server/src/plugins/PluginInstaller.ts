import {
  type PluginId,
  PluginManifest,
  type PluginInstallSource,
  type PluginState,
  type PluginUploadFile,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { STATUS_UPSTREAM_REFRESH_ENV } from "../vcs/GitVcsDriverCore.ts";
import type { DiscoveredPlugin } from "./pluginDiscovery.ts";
import type { PluginConfigError, PluginNotFoundError, PluginsConfigFile } from "./PluginHost.ts";
import { fetchNpmPackage, resolveNpmVersion } from "./pluginNpm.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";
import { commitFromLsRemote, lsRemotePatterns } from "./pluginUpdates.ts";

const UPDATE_CHECK_INTERVAL = Duration.hours(24);

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
 * Fetches, installs, links, updates and removes plugins. The host builds it and hands it the
 * lifecycle lock, the plugin list and plugins.json, so the host keeps discovery, activation and
 * state, and a new install source only changes this file.
 */
export class PluginInstaller extends Context.Service<
  PluginInstaller,
  {
    /**
     * Copies or clones a plugin into the plugins folder, enables it and starts it. It is staged
     * first and swapped in with a rename, so a failed install leaves the previous version. A
     * `link` folder is added to `devPaths` instead, so its edits apply on reload.
     */
    readonly install: (
      source: PluginInstallSource,
    ) => Effect.Effect<PluginState, PluginInstallError | PluginNotFoundError | PluginConfigError>;
    /**
     * Installs a plugin folder a client sent as files, like `install`. It records no source, so
     * the same folder sent again replaces it, but it cannot replace one installed from a source.
     */
    readonly installFiles: (
      files: ReadonlyArray<PluginUploadFile>,
    ) => Effect.Effect<PluginState, PluginInstallError | PluginNotFoundError | PluginConfigError>;
    /** Installs a plugin again from the source it was installed from. */
    readonly update: (
      pluginId: PluginId,
    ) => Effect.Effect<PluginState, PluginInstallError | PluginNotFoundError | PluginConfigError>;
    /**
     * Asks the git or npm source of each plugin installed from one for a newer version, records
     * what it finds and returns the list. The host also checks once a day.
     */
    readonly checkUpdates: Effect.Effect<ReadonlyArray<PluginState>, PluginConfigError>;
    /**
     * Stops a plugin and deletes its folder, or for a linked folder only forgets it;
     * `removeData` also deletes its settings. `linkedFolder` names one linked copy, which is only
     * forgotten when another copy with its id is in use; that copy keeps the data, so
     * `removeData` is refused for it.
     */
    readonly uninstall: (
      pluginId: PluginId,
      removeData: boolean,
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
  readonly state: (pluginId: PluginId) => Effect.Effect<PluginState, PluginNotFoundError>;
  readonly states: Effect.Effect<ReadonlyArray<PluginState>>;
  /** plugins.json as last read or written. */
  readonly config: Effect.Effect<PluginsConfigFile>;
  readonly writeConfig: (
    update: (current: PluginsConfigFile) => PluginsConfigFile,
  ) => Effect.Effect<void, PluginConfigError>;
  /** Sends clients the list, when it changed since the last time. */
  readonly publish: Effect.Effect<void>;
}

/** What an install takes a plugin from: a source it records, or files a client sent. */
type InstallOrigin =
  | { readonly source: PluginInstallSource }
  | { readonly files: ReadonlyArray<PluginUploadFile> };

// Git output can carry the URL's credentials, with or without its scheme
// (`unable to look up user:token@host`).
const withoutCredentials = (text: string, source: PluginInstallSource) => {
  if (source.type !== "git") return text;
  const userinfo = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)@/i.exec(source.url)?.[1];
  return userinfo === undefined ? text : text.replaceAll(`${userinfo}@`, "***@");
};

const withoutAvailableUpdate = (current: PluginsConfigFile, pluginId: PluginId) => {
  if (current.updates === undefined) return current;
  const { [pluginId]: _found, ...available } = current.updates.available;
  return { ...current, updates: { ...current.updates, available } };
};

const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));

const installFailed = (reason: string) => (cause: unknown) =>
  new PluginInstallError({ reason, cause });

/**
 * Builds the installer for the host. `recoverStaging` runs before the host's first discovery, and
 * `updateChecks` runs for the host's lifetime once plugins started.
 */
export const make = Effect.fn("PluginInstaller.make")(function* (host: PluginInstallerHost) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const crypto = yield* Crypto.Crypto;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const http = yield* HttpClient.HttpClient;
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

  // Prompts off, and only transports that cannot run commands (no `ext::`).
  const runGit = (args: ReadonlyArray<string>) =>
    processRunner.run({
      command: "git",
      args: [...args],
      timeout: "2 minutes",
      env: {
        ...process.env,
        ...STATUS_UPSTREAM_REFRESH_ENV,
        GIT_ALLOW_PROTOCOL: "https:http:ssh:git:file",
      },
    });

  // Callers check that every path stays inside `into`: the tarball reader and the upload schema.
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

  // Plugins run with T3's own access, so install takes code only from the sources the user named.
  const fetchSource = Effect.fn("PluginInstaller.fetch")(function* (
    source: PluginInstallSource,
    into: string,
  ) {
    if (source.type === "path") {
      const from = path.resolve(source.path);
      const info = yield* fs
        .stat(from)
        .pipe(Effect.mapError(installFailed(`${source.path} does not exist on the server.`)));
      if (info.type !== "Directory") {
        return yield* new PluginInstallError({ reason: `${source.path} is not a folder.` });
      }
      // Before copying, so a folder that is not a plugin (a home folder) is never copied.
      yield* readSourceManifest(from);
      // Copied rather than linked: the installed plugin never changes when the source does.
      yield* fs
        .copy(from, into)
        .pipe(Effect.mapError(installFailed(`Could not copy ${source.path}.`)));
      return undefined;
    }
    if (source.type === "npm") {
      const { version, files } = yield* fetchNpmPackage(source.name, source.version).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.mapError((error) => new PluginInstallError({ reason: error.reason, cause: error })),
      );
      yield* writeFiles(files, into);
      return version;
    }
    const result = yield* runGit([
      "clone",
      "--depth",
      "1",
      ...(source.ref === undefined ? [] : ["--branch", source.ref]),
      "--",
      source.url,
      into,
    ]).pipe(Effect.mapError(installFailed("Could not run git.")));
    if (result.code !== 0) {
      return yield* new PluginInstallError({
        reason: `git clone failed: ${withoutCredentials(result.stderr.trim(), source).slice(-300) || `exit ${result.code}`}`,
      });
    }
    const head = yield* runGit(["-C", into, "rev-parse", "HEAD"]).pipe(Effect.option);
    yield* fs.remove(path.join(into, ".git"), { recursive: true, force: true }).pipe(Effect.ignore);
    return Option.isSome(head) && head.value.code === 0 ? head.value.stdout.trim() : undefined;
  });

  // Windows and macOS volumes ignore case in paths by default.
  const folderKey = (folder: string) =>
    platform === "win32" || platform === "darwin"
      ? path.resolve(folder).toLowerCase()
      : path.resolve(folder);
  /**
   * Whether `next` installs from where `recorded` did: the same folder however it is written, the
   * same repository or the same package, whatever ref or version each names.
   */
  const sameSource = (
    recorded: PluginInstallSource | undefined,
    next: PluginInstallSource | undefined,
  ) => {
    if (recorded === undefined || next === undefined) return recorded === next;
    switch (next.type) {
      case "path":
        return recorded.type === "path" && folderKey(recorded.path) === folderKey(next.path);
      case "git":
        return recorded.type === "git" && recorded.url === next.url;
      case "npm":
        return recorded.type === "npm" && recorded.name === next.name;
    }
  };

  /** The npm version or git commit installing `source` would fetch now; nothing for a folder. */
  const remoteVersion = Effect.fn("PluginInstaller.remoteVersion")(function* (
    source: PluginInstallSource,
  ) {
    if (source.type === "path") return undefined;
    if (source.type === "npm") {
      return yield* resolveNpmVersion(source.name, source.version).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
    }
    const result = yield* runGit(["ls-remote", "--", source.url, ...lsRemotePatterns(source.ref)]);
    return result.code === 0 ? commitFromLsRemote(result.stdout, source.ref) : undefined;
  });

  const installOrigin = Effect.fn("PluginInstaller.installOrigin")(function* (
    origin: InstallOrigin,
    /** Set by `update`: the id the source must still provide, checked before anything moves. */
    expectedId: PluginId | undefined,
  ) {
    const source = "source" in origin ? origin.source : undefined;
    const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const stagingDir = path.join(stagingRoot, id);
    const staged = path.join(stagingDir, "plugin");
    yield* fs
      .makeDirectory(stagingDir, { recursive: true })
      .pipe(Effect.mapError(installFailed("Could not create the staging folder.")));
    const { manifest, fetched } = yield* Effect.gen(function* () {
      const fetched =
        "source" in origin
          ? yield* fetchSource(origin.source, staged)
          : yield* writeFiles(origin.files, staged).pipe(Effect.as(undefined));
      return { manifest: yield* readSourceManifest(staged), fetched };
    }).pipe(
      Effect.tapError(() =>
        fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    const previous = path.join(stagingDir, "previous");
    let stopped = false;
    yield* host
      .lifecycle(
        // Read under the lock, so another install or a removal cannot change them before the swap.
        Effect.gen(function* () {
          const copies = yield* host.copies;
          const existing = copies.find((copy) => copy.id === manifest.id);
          const pluginsFile = yield* host.config;
          const recorded = pluginsFile.sources?.[manifest.id];
          // A source may only replace the plugin it installed: another package claiming an
          // installed id would take over that plugin's folder, settings, secrets and storage. Sent
          // files have no source, so they replace only plugins sent or put in the plugins folder.
          const refusal =
            existing?.source === "dev"
              ? `${manifest.id} is linked from ${existing.folder}. Unlink it first.`
              : expectedId !== undefined && manifest.id !== expectedId
                ? `The source now provides ${manifest.id}, not ${expectedId}.`
                : existing !== undefined && !sameSource(recorded, source)
                  ? `${manifest.id} is already installed from somewhere else. Remove it first to replace it.`
                  : undefined;
          if (refusal !== undefined) return yield* new PluginInstallError({ reason: refusal });
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
          // An update keeps a disabled plugin disabled; a new install is enabled.
          const enabled =
            existing === undefined ? true : pluginsFile.enabled?.[manifest.id] === true;
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
          yield* host.writeConfig((current) => {
            const { [manifest.id]: _previous, ...installed } = current.installed ?? {};
            const { [manifest.id]: _source, ...sources } = current.sources ?? {};
            return {
              ...withoutAvailableUpdate(current, manifest.id),
              enabled: { ...current.enabled, [manifest.id]: enabled },
              sources: source === undefined ? sources : { ...sources, [manifest.id]: source },
              installed:
                fetched === undefined ? installed : { ...installed, [manifest.id]: fetched },
            };
          });
        }),
      )
      .pipe(
        Effect.ensuring(
          fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
        // Whatever happened after the stop, the plugin folder holds one version; start it again.
        Effect.ensuring(
          Effect.suspend(() =>
            stopped ? host.reload(manifest.id).pipe(Effect.ignore) : Effect.void,
          ),
        ),
      );
    return yield* host.state(manifest.id);
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
        source.type === "path" && source.link === true
          ? linkFolder(source.path)
          : installOrigin({ source }, undefined),
      ),
  );

  // `PluginInstallFilesInput` bounds the folder's size before it gets here.
  const installFiles: PluginInstaller["Service"]["installFiles"] = Effect.fn(
    "PluginInstaller.installFiles",
  )((files) => inHostScope(installOrigin({ files }, undefined)));

  const update: PluginInstaller["Service"]["update"] = Effect.fn("PluginInstaller.update")(
    function* (pluginId) {
      const source = (yield* host.config).sources?.[pluginId];
      if (source === undefined) {
        return yield* new PluginInstallError({
          reason: `${pluginId} has no source to update from. Add the folder of its new version to replace it.`,
        });
      }
      return yield* inHostScope(installOrigin({ source }, pluginId));
    },
  );

  const checkUpdates = Effect.fn("PluginInstaller.checkUpdates")(function* () {
    const current = yield* host.config;
    const found: Record<string, string> = {};
    yield* Effect.forEach(
      Object.entries(current.sources ?? {}),
      ([pluginId, source]) =>
        remoteVersion(source).pipe(
          Effect.map((latest) => {
            if (latest !== undefined) found[pluginId] = latest;
          }),
          // A source that cannot be reached keeps what the last check found.
          Effect.catchCause((cause) => {
            const previous = current.updates?.available[pluginId];
            if (previous !== undefined) found[pluginId] = previous;
            return Effect.logWarning("plugin update check failed", {
              pluginId,
              cause: withoutCredentials(Cause.pretty(cause), source).slice(0, 500),
            });
          }),
        ),
      { concurrency: 4, discard: true },
    );
    const checkedAt = yield* Clock.currentTimeMillis;
    // Compared with what is installed when writing, so an update that finished meanwhile counts.
    yield* host.writeConfig((latest) => ({
      ...latest,
      updates: {
        checkedAt,
        available: Object.fromEntries(
          Object.entries(found).filter(([pluginId, version]) => {
            const installed = latest.installed?.[pluginId];
            return installed !== undefined && installed !== version;
          }),
        ),
      },
    }));
    yield* host.publish;
    return yield* host.states;
  });

  // Sleeps until the next check is due, so a start between checks reaches no network. A server
  // with no plugin installed from git or npm never checks.
  const updateChecks = Effect.gen(function* () {
    const checkedAt = (yield* host.config).updates?.checkedAt ?? 0;
    const dueIn =
      checkedAt + Duration.toMillis(UPDATE_CHECK_INTERVAL) - (yield* Clock.currentTimeMillis);
    if (dueIn > 0) yield* Effect.sleep(Duration.millis(dueIn));
    const checkIfInstalled = host.config.pipe(
      Effect.flatMap((current) =>
        Object.values(current.sources ?? {}).some((source) => source.type !== "path")
          ? checkUpdates()
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("plugin update check failed", {
          cause: Cause.pretty(cause).slice(0, 500),
        }),
      ),
    );
    return yield* checkIfInstalled.pipe(
      Effect.andThen(Effect.sleep(UPDATE_CHECK_INTERVAL)),
      Effect.forever,
    );
  });

  const removeFromConfig = (pluginId: PluginId) =>
    host.writeConfig((current) => {
      const { [pluginId]: _removed, ...enabled } = current.enabled ?? {};
      const { [pluginId]: _source, ...sources } = current.sources ?? {};
      const { [pluginId]: _installed, ...installed } = current.installed ?? {};
      return { ...withoutAvailableUpdate(current, pluginId), enabled, sources, installed };
    });

  const forgetDevPath = (folder: string) =>
    host.writeConfig((current) => ({
      ...current,
      devPaths: (current.devPaths ?? []).filter((entry) => path.resolve(entry) !== folder),
    }));

  const uninstall: PluginInstaller["Service"]["uninstall"] = Effect.fn("PluginInstaller.uninstall")(
    function* (pluginId, removeData, linkedFolder) {
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
        // The first copy is the one in use, and the others share its settings and storage.
        if (link > 0 && removeData) {
          return yield* new PluginInstallError({
            reason: `${linkedFolder} is not the copy of ${pluginId} in use, and the copy in use keeps the data. Unlink it without removing data.`,
          });
        }
        // The copy in use keeps running.
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
        }),
      );
      if (removeData) {
        yield* settingsStore
          .clear(pluginId, settingsSchema)
          .pipe(Effect.mapError(installFailed("The plugin is removed, but its settings are not.")));
        yield* storage
          .clear(pluginId)
          .pipe(Effect.mapError(installFailed("The plugin is removed, but its storage is not.")));
      }
    },
  );

  return {
    installer: PluginInstaller.of({
      install,
      installFiles,
      update,
      checkUpdates: checkUpdates(),
      uninstall,
    }),
    recoverStaging,
    updateChecks,
  };
});
