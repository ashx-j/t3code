import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Lowercase because the id names the plugin's directory on case-insensitive filesystems. No
// underscores, so the `plg_<id>_` prefix on plugin MCP tool names belongs to exactly one plugin.
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
const PluginEntryPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  isInsidePluginDirectory,
);

// The packaged server is a Node single executable that can only `require` plugin code, and a
// `.js` file under a `"type": "module"` package.json would load as ESM.
const PluginServerEntryPath = PluginEntryPath.check(
  Schema.isPattern(/\.cjs$/, { expected: "a CommonJS file ending in .cjs" }),
);

/** `t3-plugin.json` at the root of a plugin directory. */
export const PluginManifest = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  version: PluginVersion,
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  engines: Schema.Struct({ t3: PluginEngineRange }),
  server: Schema.optionalKey(PluginServerEntryPath),
  web: Schema.optionalKey(PluginEntryPath),
  /**
   * JSON Schema for the plugin's settings. Top-level string fields with `format: "t3-secret"` are
   * write-only and kept in the secret store; `t3-secret` anywhere else is saved as plain text.
   */
  settingsSchema: Schema.optionalKey(Schema.JsonObject),
  /** Shown to the user before enabling. Not enforced: plugins are trusted code. */
  permissions: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(200))).check(
      Schema.isMaxLength(32),
    ),
  ),
});
export type PluginManifest = typeof PluginManifest.Type;

/** `dev` is a folder loaded where it is: one in `devPaths` or installed with `link`. */
export const PluginSource = Schema.Literals(["installed", "dev"]);
export type PluginSource = typeof PluginSource.Type;

export const PluginStatus = Schema.Literals(["active", "disabled", "failed", "loading"]);
export type PluginStatus = typeof PluginStatus.Type;

export const PluginFailureStage = Schema.Literals([
  "discovery",
  "manifest",
  "compatibility",
  "load",
  "activate",
]);
export type PluginFailureStage = typeof PluginFailureStage.Type;

export const PluginFailure = Schema.Struct({
  stage: PluginFailureStage,
  message: Schema.String,
});
export type PluginFailure = typeof PluginFailure.Type;

/** Where `plugins.install` gets a plugin: a folder on the server, a git repository or npm. */
export const PluginInstallSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("path"),
    path: TrimmedNonEmptyString,
    /** Loads the folder where it is instead of copying it; removing the plugin only unlinks it. */
    link: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("git"),
    url: TrimmedNonEmptyString,
    ref: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("npm"),
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(214)),
    version: Schema.optionalKey(TrimmedNonEmptyString),
  }),
]);
export type PluginInstallSource = typeof PluginInstallSource.Type;

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
  /** Changes each time the plugin starts, so clients can reload its web half after a restart. */
  revision: Schema.optionalKey(Schema.Number),
  /**
   * Names the contents of its web bundle while it runs. Sent as the bundle URL's `v`, which the
   * server then lets browsers cache for good.
   */
  webRevision: Schema.optionalKey(Schema.String),
  /**
   * The `.css` files in its `styles` folder while it runs, in the order clients apply them. Each
   * `revision` names the file's contents and is sent as its URL's `v`, like `webRevision`.
   */
  styles: Schema.optionalKey(
    Schema.Array(Schema.Struct({ file: Schema.String, revision: Schema.String })),
  ),
  /** The folder a `dev` plugin loads from, where an agent or plugins.json linked it. */
  linkedFolder: Schema.optionalKey(Schema.String),
  /** Where it was installed from, when installed through `plugins.install`; updates reuse it. */
  installSource: Schema.optionalKey(PluginInstallSource),
  /** A newer npm version or git commit at its install source, found by the last update check. */
  availableUpdate: Schema.optionalKey(Schema.Struct({ version: Schema.String })),
  /** The version its last update replaced, which `plugins.rollback` puts back. */
  rollbackVersion: Schema.optionalKey(Schema.String),
  hasServer: Schema.Boolean,
  hasWeb: Schema.Boolean,
  /** Has a `skills` folder, whose skills agents on this environment get while it runs. */
  hasSkills: Schema.optionalKey(Schema.Boolean),
  /** Why its web half failed in a client since it last started, as that client reported it. */
  webFailure: Schema.optionalKey(Schema.String),
  /** Why its server code failed outside a call since it last started, such as in a timer. */
  serverFailure: Schema.optionalKey(Schema.String),
  settingsSchema: Schema.optionalKey(Schema.JsonObject),
});
export type PluginState = typeof PluginState.Type;

/** Name of a method or channel a plugin registered for `plugins.invoke` and `plugins.subscribe`. */
export const PluginRpcName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9._-]*$/),
);
export type PluginRpcName = typeof PluginRpcName.Type;

export const PluginListInput = Schema.Struct({});
export type PluginListInput = typeof PluginListInput.Type;

export const PluginListResult = Schema.Struct({
  plugins: ForwardCompatibleArray(PluginState),
  /** Whether agents get the `t3_plugins_*` tools. Older servers leave it out. */
  agentTools: Schema.optionalKey(Schema.Boolean),
});
export type PluginListResult = typeof PluginListResult.Type;

/**
 * `plugins.subscribeStates`: the whole list first, then only the rows that differ from the event
 * before, by position, so a change to one plugin does not resend every settings schema.
 */
export const PluginStatesEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    plugins: Schema.Array(PluginState),
    agentTools: Schema.Boolean,
  }),
  Schema.TaggedStruct("changed", {
    /** How many plugins the list has now; rows past it are gone. */
    length: Schema.Number,
    rows: Schema.Array(Schema.Struct({ index: Schema.Number, plugin: PluginState })),
    agentTools: Schema.Boolean,
  }),
]);
export type PluginStatesEvent = typeof PluginStatesEvent.Type;

/** The list after `event`, from the list before it. Rows the event leaves out keep their value. */
export const applyPluginStatesEvent = (
  current: PluginListResult,
  event: PluginStatesEvent,
): PluginListResult => {
  if (event._tag === "snapshot") return { plugins: event.plugins, agentTools: event.agentTools };
  const plugins = current.plugins.slice(0, event.length);
  for (const { index, plugin } of event.rows) plugins[index] = plugin;
  return { plugins, agentTools: event.agentTools };
};

export const PluginSetAgentToolsInput = Schema.Struct({ enabled: Schema.Boolean });
export type PluginSetAgentToolsInput = typeof PluginSetAgentToolsInput.Type;

export const PluginSetAgentToolsResult = Schema.Struct({ agentTools: Schema.Boolean });
export type PluginSetAgentToolsResult = typeof PluginSetAgentToolsResult.Type;

export const PluginSetEnabledInput = Schema.Struct({
  pluginId: PluginId,
  enabled: Schema.Boolean,
});
export type PluginSetEnabledInput = typeof PluginSetEnabledInput.Type;

export const PluginReloadInput = Schema.Struct({
  pluginId: PluginId,
});
export type PluginReloadInput = typeof PluginReloadInput.Type;

export const PluginInstallInput = Schema.Struct({ source: PluginInstallSource });
export type PluginInstallInput = typeof PluginInstallInput.Type;

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

export const PluginUpdateInput = Schema.Struct({ pluginId: PluginId });
export type PluginUpdateInput = typeof PluginUpdateInput.Type;

export const PluginRollbackInput = Schema.Struct({ pluginId: PluginId });
export type PluginRollbackInput = typeof PluginRollbackInput.Type;

export const PluginCheckUpdatesInput = Schema.Struct({});
export type PluginCheckUpdatesInput = typeof PluginCheckUpdatesInput.Type;

/**
 * A client's report that a plugin's web half failed. `revision` is the start the client loaded,
 * so a report about an earlier start is ignored.
 */
export const PluginReportWebFailureInput = Schema.Struct({
  pluginId: PluginId,
  revision: Schema.Number,
  message: Schema.String,
});
export type PluginReportWebFailureInput = typeof PluginReportWebFailureInput.Type;

export const PluginUninstallInput = Schema.Struct({
  pluginId: PluginId,
  /** Also delete the plugin's settings, secrets and storage. */
  removeData: Schema.optionalKey(Schema.Boolean),
  /**
   * A `dev` row's `linkedFolder`: unlinks exactly that folder, even when another copy with the
   * same id is in use. Unlinking a copy that is not in use keeps the id's data.
   */
  linkedFolder: Schema.optionalKey(Schema.String),
});
export type PluginUninstallInput = typeof PluginUninstallInput.Type;

export const PluginUninstallResult = Schema.Struct({ pluginId: PluginId });
export type PluginUninstallResult = typeof PluginUninstallResult.Type;

/** Data a plugin that is no longer installed left behind, because it was removed without it. */
export const PluginLeftoverData = Schema.Struct({
  pluginId: PluginId,
  /** Has saved settings, which come with its secrets. */
  settings: Schema.Boolean,
  /** How many keys it has in plugin storage. */
  storageKeys: Schema.Number,
});
export type PluginLeftoverData = typeof PluginLeftoverData.Type;

export const PluginListLeftoverDataInput = Schema.Struct({});
export type PluginListLeftoverDataInput = typeof PluginListLeftoverDataInput.Type;

/** Deletes the settings, secrets and storage of a plugin that is no longer installed. */
export const PluginDeleteLeftoverDataInput = Schema.Struct({ pluginId: PluginId });
export type PluginDeleteLeftoverDataInput = typeof PluginDeleteLeftoverDataInput.Type;

/** Result of `plugins.listLeftoverData` and of `plugins.deleteLeftoverData`, which lists the rest. */
export const PluginLeftoverDataResult = Schema.Struct({
  leftovers: Schema.Array(PluginLeftoverData),
});
export type PluginLeftoverDataResult = typeof PluginLeftoverDataResult.Type;

/**
 * Result of `plugins.setEnabled`, `plugins.reload`, `plugins.install`, `plugins.update` and
 * `plugins.rollback`.
 */
export const PluginMutationResult = Schema.Struct({
  plugin: PluginState,
});
export type PluginMutationResult = typeof PluginMutationResult.Type;

export const PluginSettingsGetInput = Schema.Struct({
  pluginId: PluginId,
});
export type PluginSettingsGetInput = typeof PluginSettingsGetInput.Type;

export const PluginSettingsUpdateInput = Schema.Struct({
  pluginId: PluginId,
  patch: Schema.JsonObject,
});
export type PluginSettingsUpdateInput = typeof PluginSettingsUpdateInput.Type;

/** Secret fields read back as the server's redaction marker, never their value. */
export const PluginSettingsResult = Schema.Struct({
  pluginId: PluginId,
  settings: Schema.JsonObject,
});
export type PluginSettingsResult = typeof PluginSettingsResult.Type;

export const PluginInvokeInput = Schema.Struct({
  pluginId: PluginId,
  method: PluginRpcName,
  input: Schema.optionalKey(Schema.Json),
});
export type PluginInvokeInput = typeof PluginInvokeInput.Type;

export const PluginInvokeResult = Schema.Struct({
  output: Schema.Json,
});
export type PluginInvokeResult = typeof PluginInvokeResult.Type;

export const PluginSubscribeInput = Schema.Struct({
  pluginId: PluginId,
  channel: PluginRpcName,
});
export type PluginSubscribeInput = typeof PluginSubscribeInput.Type;

export const PluginSubscriptionEvent = Schema.Struct({
  value: Schema.Json,
});
export type PluginSubscriptionEvent = typeof PluginSubscriptionEvent.Type;

export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  message: Schema.String,
  pluginId: Schema.optionalKey(PluginId),
}) {}
