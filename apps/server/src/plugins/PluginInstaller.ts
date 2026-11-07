import {
  type PluginId,
  type PluginLeftoverData,
  PluginManifest,
  type PluginInstallSource,
  type PluginState,
  type PluginUploadFile,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
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

import packageJson from "../../package.json" with { type: "json" };
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
    /**
     * Installs a plugin again from the source it was installed from. The version it replaces is
     * kept, one per plugin, for `rollback`.
     */
    readonly update: (
      pluginId: PluginId,
    ) => Effect.Effect<PluginState, PluginInstallError | PluginNotFoundError | PluginConfigError>;
    /** Puts back the version the plugin's last update replaced, like an update to it. */
    readonly rollback: (
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
    /** Settings and storage of plugins that are no longer installed, by plugin id. */
    readonly leftoverData: Effect.Effect<ReadonlyArray<PluginLeftoverData>, PluginInstallError>;
    /**
     * Deletes the settings, secrets and storage a removed plugin left, and lists what is left.
     * An installed plugin's data is refused: removing it with its data deletes that.
     */
    readonly deleteLeftoverData: (
      pluginId: PluginId,
    ) => Effect.Effect<ReadonlyArray<PluginLeftoverData>, PluginInstallError>;
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

/**
 * What an install takes a plugin from: a source it records, files a client sent, or the version
 * an update replaced.
 */
type InstallOrigin =
  | { readonly source: PluginInstallSource }
  | { readonly files: ReadonlyArray<PluginUploadFile> }
  | { readonly kept: string };

// Git output can carry the URL's credentials, with or without its scheme
// (`unable to look up user:token@host`).
const withoutCredentials = (text: string, source: PluginInstallSource) => {
  if (source.type !== "git") return text;
  const userinfo = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)@/i.exec(source.url)?.[1];
  return userinfo === undefined ? text : text.replaceAll(`${userinfo}@`, "***@");
};

/** What plugins.json records about how a plugin was installed, put back when a swap is undone. */
interface InstallRecord {
  readonly source: PluginInstallSource | undefined;
  /** The npm version or git commit fetched. */
  readonly installed: string | undefined;
  /** A newer version the last update check found. */
  readonly available: string | undefined;
}

const installRecordOf = (current: PluginsConfigFile, pluginId: PluginId): InstallRecord => ({
  source: current.sources?.[pluginId],
  installed: current.installed?.[pluginId],
  available: current.updates?.available[pluginId],
});

const withInstallRecord = (
  current: PluginsConfigFile,
  pluginId: PluginId,
  record: InstallRecord,
): PluginsConfigFile => {
  const { [pluginId]: _source, ...sources } = current.sources ?? {};
  const { [pluginId]: _installed, ...installed } = current.installed ?? {};
  const { [pluginId]: _available, ...available } = current.updates?.available ?? {};
  return {
    ...current,
    sources: record.source === undefined ? sources : { ...sources, [pluginId]: record.source },
    installed:
      record.installed === undefined ? installed : { ...installed, [pluginId]: record.installed },
    ...(current.updates === undefined && record.available === undefined
      ? {}
      : {
          updates: {
            checkedAt: current.updates?.checkedAt ?? 0,
            available:
              record.available === undefined
                ? available
                : { ...available, [pluginId]: record.available },
          },
        }),
  };
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
  const rollbackRoot = path.join(config.stateDir, "plugin-rollback");
  const rollbackFolderOf = (pluginId: PluginId) => path.join(rollbackRoot, pluginId);

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

  // Prompts off, and only transports that are encrypted or local and cannot run commands (no
  // `ext::`), which also covers redirects and submodules.
  const runGit = (args: ReadonlyArray<string>) =>
    processRunner.run({
      command: "git",
      args: [...args],
      timeout: "2 minutes",
      env: {
        ...process.env,
        ...STATUS_UPSTREAM_REFRESH_ENV,
        GIT_ALLOW_PROTOCOL: "https:ssh:file",
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
    // Refused here with a reason; git would only say the transport is not allowed.
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(source.url)?.[1]?.toLowerCase();
    if (scheme === "http" || scheme === "git") {
      return yield* new PluginInstallError({
        reason: `${scheme}:// URLs are not encrypted, so anyone on the network could change the plugin's code. Use an https or ssh URL.`,
      });
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
  const swapIn = Effect.fn("PluginInstaller.swapIn")(function* (input: {
    readonly manifest: PluginManifest;
    readonly stagingDir: string;
    readonly installed: InstallRecord;
    /** Set by `update`: the id the source must still provide, checked before anything moves. */
    readonly expectedId: PluginId | undefined;
    /** Keeps the replaced version for `rollback` once the new one has started. */
    readonly keepReplaced: boolean;
  }) {
    const { manifest, stagingDir } = input;
    const source = input.installed.source;
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
          const pluginsFile = yield* host.config;
          const recorded = pluginsFile.sources?.[manifest.id];
          // A source may only replace the plugin it installed: another package claiming an
          // installed id would take over that plugin's folder, settings, secrets and storage. Sent
          // files have no source, so they replace only plugins sent or put in the plugins folder.
          const refusal =
            existing?.source === "dev"
              ? `${manifest.id} is linked from ${existing.folder}. Unlink it first.`
              : input.expectedId !== undefined && manifest.id !== input.expectedId
                ? `The source now provides ${manifest.id}, not ${input.expectedId}.`
                : input.expectedId !== undefined && existing === undefined
                  ? `${input.expectedId} is not installed.`
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
          yield* host.writeConfig((current) => ({
            ...withInstallRecord(current, manifest.id, input.installed),
            enabled: { ...current.enabled, [manifest.id]: enabled },
          }));
          return {
            target,
            replaced: hadPrevious
              ? {
                  version:
                    existing !== undefined && "manifest" in existing
                      ? existing.manifest.version
                      : undefined,
                  installed: installRecordOf(pluginsFile, manifest.id),
                }
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
    const { replaced } = swapped;
    if (replaced === undefined) return started;
    if (started.status !== "failed") {
      yield* settingsStore.dropRemovedSecrets(manifest.id, manifest.settingsSchema).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("could not delete the secrets a plugin update dropped", {
            pluginId: manifest.id,
            cause: Cause.pretty(cause).slice(0, 500),
          }),
        ),
      );
      const { version } = replaced;
      if (!input.keepReplaced || version === undefined) return started;
      // The update already succeeded, so a copy that cannot be kept only loses the rollback.
      yield* host
        .lifecycle(
          Effect.gen(function* () {
            const kept = rollbackFolderOf(manifest.id);
            yield* fs.remove(kept, { recursive: true, force: true });
            yield* fs.makeDirectory(rollbackRoot, { recursive: true });
            yield* fs.rename(previous, kept);
            yield* host.writeConfig((current) => ({
              ...current,
              rollback: {
                ...current.rollback,
                [manifest.id]: {
                  version,
                  ...(replaced.installed.installed === undefined
                    ? {}
                    : { installed: replaced.installed.installed }),
                },
              },
            }));
            yield* host.publish;
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("could not keep the version a plugin update replaced", {
              pluginId: manifest.id,
              cause: Cause.pretty(cause).slice(0, 500),
            }),
          ),
        );
      return yield* host.state(manifest.id);
    }
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
          yield* host.writeConfig((current) =>
            withInstallRecord(current, manifest.id, replaced.installed),
          );
        }),
      )
      .pipe(Effect.ensuring(host.reload(manifest.id).pipe(Effect.ignore)));
    return yield* new PluginInstallError({
      reason: `${manifest.name} ${manifest.version} failed to start, so ${replaced.version ?? "the previous version"} is back. It failed with: ${started.failure?.message ?? "an unknown error"}`,
    });
  }, Effect.scoped);

  /** Fetches `origin` into a new staging folder and returns the folder and what it holds. */
  const stage = Effect.fn("PluginInstaller.stage")(function* (origin: InstallOrigin) {
    const stagingDir = path.join(stagingRoot, yield* crypto.randomUUIDv4().pipe(Effect.orDie));
    const staged = path.join(stagingDir, "plugin");
    yield* fs
      .makeDirectory(stagingDir, { recursive: true })
      .pipe(Effect.mapError(installFailed("Could not create the staging folder.")));
    return yield* Effect.gen(function* () {
      const fetched =
        "source" in origin
          ? yield* fetchSource(origin.source, staged)
          : "files" in origin
            ? yield* writeFiles(origin.files, staged).pipe(Effect.as(undefined))
            : yield* fs
                .copy(origin.kept, staged)
                .pipe(
                  Effect.as(undefined),
                  Effect.mapError(installFailed("The kept version could not be copied.")),
                );
      return { stagingDir, manifest: yield* readSourceManifest(staged), fetched };
    }).pipe(Effect.tapError(() => removeStaging(stagingDir)));
  });

  const removeStaging = (stagingDir: string) =>
    fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore);

  const installOrigin = Effect.fn("PluginInstaller.installOrigin")(function* (
    origin: InstallOrigin,
    expectedId: PluginId | undefined,
  ) {
    const { stagingDir, manifest, fetched } = yield* stage(origin);
    const refusal = engineRefusal(manifest);
    if (refusal !== undefined) {
      yield* removeStaging(stagingDir);
      return yield* new PluginInstallError({ reason: refusal });
    }
    return yield* swapIn({
      manifest,
      stagingDir,
      expectedId,
      keepReplaced: true,
      installed: {
        source: "source" in origin ? origin.source : undefined,
        installed: fetched,
        available: undefined,
      },
    });
  });

  /**
   * Whether the newest version at `source`, `latest`, says it runs on this server, read from its
   * manifest, so update checks never offer one that would be refused.
   */
  const runsHere = Effect.fn("PluginInstaller.runsHere")(function* (
    source: PluginInstallSource,
    latest: string,
  ) {
    const { stagingDir, manifest } = yield* stage({
      source: source.type === "npm" ? { ...source, version: latest } : source,
    });
    yield* removeStaging(stagingDir);
    const refusal = engineRefusal(manifest);
    if (refusal !== undefined) {
      yield* Effect.logInfo("not offering a plugin update this server cannot run", {
        pluginId: manifest.id,
        engines: manifest.engines.t3,
      });
    }
    return refusal === undefined;
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

  // Copied rather than moved, so the kept version stays if putting it back fails.
  const rollback: PluginInstaller["Service"]["rollback"] = Effect.fn("PluginInstaller.rollback")(
    (pluginId) =>
      inHostScope(
        Effect.gen(function* () {
          const current = yield* host.config;
          const kept = current.rollback?.[pluginId];
          if (kept === undefined) {
            return yield* new PluginInstallError({
              reason: `${pluginId} has no earlier version to roll back to.`,
            });
          }
          const { stagingDir, manifest } = yield* stage({ kept: rollbackFolderOf(pluginId) });
          const refusal = engineRefusal(manifest);
          if (refusal !== undefined) {
            yield* removeStaging(stagingDir);
            return yield* new PluginInstallError({ reason: refusal });
          }
          yield* swapIn({
            manifest,
            stagingDir,
            expectedId: pluginId,
            keepReplaced: false,
            // The version rolled back from is still the newer one at its source.
            installed: {
              source: current.sources?.[pluginId],
              installed: kept.installed,
              available: current.installed?.[pluginId],
            },
          });
          yield* host.lifecycle(forgetRollback(pluginId).pipe(Effect.andThen(host.publish)));
          return yield* host.state(pluginId);
        }),
      ),
  );

  const forgetRollback = (pluginId: PluginId) =>
    fs.remove(rollbackFolderOf(pluginId), { recursive: true, force: true }).pipe(
      Effect.mapError(installFailed(`Could not delete the kept version of ${pluginId}.`)),
      Effect.andThen(
        host.writeConfig((current) => {
          const { [pluginId]: _kept, ...rollback } = current.rollback ?? {};
          return { ...current, rollback };
        }),
      ),
    );

  const checkUpdates = Effect.fn("PluginInstaller.checkUpdates")(function* () {
    const current = yield* host.config;
    const found: Record<string, string> = {};
    yield* Effect.forEach(
      Object.entries(current.sources ?? {}),
      ([pluginId, source]) =>
        Effect.gen(function* () {
          const latest = yield* remoteVersion(source);
          if (latest === undefined) return;
          if (latest !== current.installed?.[pluginId] && !(yield* runsHere(source, latest))) {
            return;
          }
          found[pluginId] = latest;
        }).pipe(
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
      return {
        ...withInstallRecord(current, pluginId, {
          source: undefined,
          installed: undefined,
          available: undefined,
        }),
        enabled,
      };
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
          yield* forgetRollback(pluginId);
          yield* host.forget(pluginId, folder);
          // Under the lock, or an install that starts meanwhile could lose its new settings.
          if (removeData) {
            yield* settingsStore
              .clear(pluginId, settingsSchema)
              .pipe(
                Effect.mapError(installFailed("The plugin is removed, but its settings are not.")),
              );
            yield* storage
              .clear(pluginId)
              .pipe(
                Effect.mapError(installFailed("The plugin is removed, but its storage is not.")),
              );
          }
        }),
      );
    },
  );

  // Read and deleted under the lifecycle lock, so an install cannot start between them.
  const listLeftovers = Effect.gen(function* () {
    const installed = new Set((yield* host.copies).map((copy) => copy.id));
    const withSettings = yield* settingsStore.pluginIds;
    const storageKeys = yield* storage.keyCounts.pipe(
      Effect.mapError(installFailed("Could not read plugin storage.")),
    );
    return [...new Set([...withSettings, ...storageKeys.keys()])]
      .filter((pluginId) => !installed.has(pluginId))
      .toSorted()
      .map((pluginId): PluginLeftoverData => ({
        pluginId,
        settings: withSettings.includes(pluginId),
        storageKeys: storageKeys.get(pluginId) ?? 0,
      }));
  });

  const leftoverData = host
    .lifecycle(listLeftovers)
    .pipe(Effect.withSpan("PluginInstaller.leftoverData"));

  const deleteLeftoverData: PluginInstaller["Service"]["deleteLeftoverData"] = Effect.fn(
    "PluginInstaller.deleteLeftoverData",
  )((pluginId) =>
    host.lifecycle(
      Effect.gen(function* () {
        if ((yield* host.copies).some((copy) => copy.id === pluginId)) {
          return yield* new PluginInstallError({
            reason: `${pluginId} is installed. Remove it with its data to delete its data.`,
          });
        }
        yield* settingsStore
          .clear(pluginId, undefined)
          .pipe(Effect.mapError(installFailed(`Could not delete the settings of ${pluginId}.`)));
        yield* storage
          .clear(pluginId)
          .pipe(Effect.mapError(installFailed(`Could not delete the storage of ${pluginId}.`)));
        return yield* listLeftovers;
      }),
    ),
  );

  return {
    installer: PluginInstaller.of({
      install,
      installFiles,
      update,
      rollback,
      checkUpdates: checkUpdates(),
      uninstall,
      leftoverData,
      deleteLeftoverData,
    }),
    recoverStaging,
    updateChecks,
  };
});
