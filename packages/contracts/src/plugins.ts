import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Lowercase because the id names the plugin's directory on case-insensitive filesystems.
export const PluginId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[a-z][a-z0-9-]*$/),
).pipe(Schema.brand("PluginId"));
export type PluginId = typeof PluginId.Type;

// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const PluginVersion = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(SEMVER_PATTERN, { expected: "a semver version such as 1.2.3" }),
);

// The syntax `satisfiesSemverRange` in packages/shared/src/semver.ts evaluates. Anything else,
// such as `~1.2`, would never match, so it fails here with a reason instead.
const ENGINE_COMPARATOR = String.raw`(?:\^|>=|>|<=|<|=)?v?\d+(?:\.\d+){0,2}`;
const ENGINE_GROUP = String.raw`${ENGINE_COMPARATOR}(?:\s+${ENGINE_COMPARATOR})*`;
const PluginEngineRange = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(new RegExp(String.raw`^${ENGINE_GROUP}(?:\s*\|\|\s*${ENGINE_GROUP})*$`), {
    expected: "a version range using ^, >=, >, <=, <, = and ||, such as >=0.1.6",
  }),
);

// Lexical check only. Code that reads or serves the file still resolves symlinks.
const isInsidePluginDirectory = Schema.makeFilter(
  (path: string) =>
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/^[a-zA-Z]:/.test(path) &&
    path.split("/").every((segment) => segment !== ".."),
  { expected: "a relative path inside the plugin directory" },
);

/** `t3-plugin.json` at the root of a plugin directory. */
export const PluginManifest = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  version: PluginVersion,
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  engines: Schema.Struct({ t3: PluginEngineRange }),
  /** Shown to the user before enabling. Not enforced. */
  permissions: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(200))).check(
      Schema.isMaxLength(32),
    ),
  ),
});
export type PluginManifest = typeof PluginManifest.Type;

/** `dev` is a folder loaded where it is, one listed in `devPaths`. */
export const PluginSource = Schema.Literals(["installed", "dev"]);
export type PluginSource = typeof PluginSource.Type;

export const PluginStatus = Schema.Literals(["active", "disabled", "failed", "loading"]);
export type PluginStatus = typeof PluginStatus.Type;

export const PluginFailureStage = Schema.Literals(["discovery", "manifest", "compatibility"]);
export type PluginFailureStage = typeof PluginFailureStage.Type;

export const PluginFailure = Schema.Struct({
  stage: PluginFailureStage,
  message: Schema.String,
});
export type PluginFailure = typeof PluginFailure.Type;

/** What the server knows about one discovered plugin, including ones whose manifest failed. */
export const PluginState = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString,
  /** Absent when the manifest could not be decoded. */
  version: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  permissions: Schema.Array(Schema.String),
  source: PluginSource,
  enabled: Schema.Boolean,
  status: PluginStatus,
  failure: Schema.optionalKey(PluginFailure),
  /**
   * The `.css` files in its `styles` folder while it runs, in the order clients apply them. Each
   * `revision` names the file's contents and is sent as its URL's `v`, which the server then lets
   * browsers cache for good.
   */
  styles: Schema.optionalKey(
    Schema.Array(Schema.Struct({ file: Schema.String, revision: Schema.String })),
  ),
  /** The folder a `dev` plugin loads from, as plugins.json lists it. */
  linkedFolder: Schema.optionalKey(Schema.String),
});
export type PluginState = typeof PluginState.Type;

export const PluginListInput = Schema.Struct({});
export type PluginListInput = typeof PluginListInput.Type;

export const PluginListResult = Schema.Struct({
  plugins: ForwardCompatibleArray(PluginState),
});
export type PluginListResult = typeof PluginListResult.Type;

/**
 * `plugins.subscribeStates`: the whole list first, then only the rows that differ from the event
 * before, by position, so a change to one plugin does not resend the others.
 */
export const PluginStatesEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    plugins: Schema.Array(PluginState),
  }),
  Schema.TaggedStruct("changed", {
    /** How many plugins the list has now; rows past it are gone. */
    length: Schema.Number,
    rows: Schema.Array(Schema.Struct({ index: Schema.Number, plugin: PluginState })),
  }),
]);
export type PluginStatesEvent = typeof PluginStatesEvent.Type;

/** The list after `event`, from the list before it. Rows the event leaves out keep their value. */
export const applyPluginStatesEvent = (
  current: PluginListResult,
  event: PluginStatesEvent,
): PluginListResult => {
  if (event._tag === "snapshot") return { plugins: event.plugins };
  const plugins = current.plugins.slice(0, event.length);
  for (const { index, plugin } of event.rows) plugins[index] = plugin;
  return { plugins };
};

export const PluginSetEnabledInput = Schema.Struct({
  pluginId: PluginId,
  enabled: Schema.Boolean,
});
export type PluginSetEnabledInput = typeof PluginSetEnabledInput.Type;

export const PluginReloadInput = Schema.Struct({
  pluginId: PluginId,
});
export type PluginReloadInput = typeof PluginReloadInput.Type;

/** Limits on a folder sent with `plugins.installFiles`, which travels as one message. */
export const PLUGIN_UPLOAD_MAX_FILES = 1_000;
export const PLUGIN_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** One file of a plugin folder dropped into a client, by its path inside that folder. */
export const PluginUploadFile = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(1024), isInsidePluginDirectory),
  contents: Schema.Uint8ArrayFromBase64,
});
export type PluginUploadFile = typeof PluginUploadFile.Type;

export const PluginInstallFilesInput = Schema.Struct({
  files: Schema.Array(PluginUploadFile).check(
    Schema.isMaxLength(PLUGIN_UPLOAD_MAX_FILES, {
      message: `A plugin folder can have up to ${PLUGIN_UPLOAD_MAX_FILES} files.`,
    }),
    Schema.makeFilter(
      (files) =>
        files.reduce((total, file) => total + file.contents.byteLength, 0) <=
        PLUGIN_UPLOAD_MAX_BYTES,
      { message: `A plugin folder can have up to ${PLUGIN_UPLOAD_MAX_BYTES / 1024 / 1024} MB.` },
    ),
  ),
});
export type PluginInstallFilesInput = typeof PluginInstallFilesInput.Type;

export const PluginRescanInput = Schema.Struct({});
export type PluginRescanInput = typeof PluginRescanInput.Type;

export const PluginUninstallInput = Schema.Struct({
  pluginId: PluginId,
  /**
   * A `dev` row's `linkedFolder`: unlinks exactly that folder, even when another copy with the
   * same id is in use.
   */
  linkedFolder: Schema.optionalKey(Schema.String),
});
export type PluginUninstallInput = typeof PluginUninstallInput.Type;

export const PluginUninstallResult = Schema.Struct({ pluginId: PluginId });
export type PluginUninstallResult = typeof PluginUninstallResult.Type;

/** Result of `plugins.setEnabled`, `plugins.reload` and `plugins.installFiles`. */
export const PluginMutationResult = Schema.Struct({
  plugin: PluginState,
});
export type PluginMutationResult = typeof PluginMutationResult.Type;

export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  message: Schema.String,
  pluginId: Schema.optionalKey(PluginId),
}) {}
