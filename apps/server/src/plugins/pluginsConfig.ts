// @effect-diagnostics nodeBuiltinImport:off - a crash is saved while the process exits, which
// needs synchronous writes the FileSystem service does not offer.
import * as NodeFS from "node:fs";

import type { PluginId } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

export class PluginConfigError extends Schema.TaggedError<PluginConfigError>()(
  "PluginConfigError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not update ${this.path}. If it was edited by hand, fix or delete it.`;
  }
}

// Unknown keys survive a rewrite, so a newer build's additions outlive a toggle by an older one.
const PluginsConfigFile = Schema.StructWithRest(
  Schema.Struct({
    enabled: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
    devPaths: Schema.optionalKey(Schema.Array(Schema.String)),
    /** Why each plugin stopped the server, kept until the user turns it on again or reloads it. */
    crashed: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type PluginsConfigFile = typeof PluginsConfigFile.Type;
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginsConfigFile));
const encodeConfig = Schema.encodeEffect(fromJsonStringPretty(PluginsConfigFile));
const decodeConfigSync = Schema.decodeUnknownSync(Schema.fromJsonString(PluginsConfigFile));
const encodeConfigSync = Schema.encodeSync(fromJsonStringPretty(PluginsConfigFile));

export const withoutCrash = (current: PluginsConfigFile, pluginId: PluginId): PluginsConfigFile => {
  if (current.crashed?.[pluginId] === undefined) return current;
  const { [pluginId]: _cleared, ...crashed } = current.crashed;
  return { ...current, crashed };
};

/** Builds the host's copy of `<stateDir>/plugins.json`, which it reads and writes through this. */
export const makePluginsConfig = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(config.stateDir, "plugins.json");
  const current = yield* Ref.make<PluginsConfigFile>({});

  const read = Effect.gen(function* () {
    const exists = yield* fs.exists(configPath);
    if (!exists) {
      const emptyConfig: PluginsConfigFile = {};
      return emptyConfig;
    }
    const raw = yield* fs.readFileString(configPath);
    return yield* decodeConfig(raw);
  }).pipe(Effect.mapError((cause) => new PluginConfigError({ path: configPath, cause })));

  const write = Effect.fn("PluginHost.writeConfig")(function* (
    update: (current: PluginsConfigFile) => PluginsConfigFile,
  ) {
    const next = update(yield* read);
    const contents = yield* encodeConfig(next).pipe(
      Effect.mapError((cause) => new PluginConfigError({ path: configPath, cause })),
    );
    yield* writeFileStringAtomically({ filePath: configPath, contents: `${contents}\n` }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new PluginConfigError({ path: configPath, cause })),
    );
    yield* Ref.set(current, next);
  });

  const emptyConfig: PluginsConfigFile = {};
  return {
    /** plugins.json as last read or written. */
    current: Ref.get(current),
    /** Reads the file again and keeps it. Startup tolerates an unreadable file; a reload reports it. */
    reread: (lenient: boolean) =>
      (lenient
        ? read.pipe(
            Effect.catchTags({
              PluginConfigError: (error) =>
                Effect.logWarning("ignoring unreadable plugins.json", { path: error.path }).pipe(
                  Effect.as(emptyConfig),
                ),
            }),
          )
        : read
      ).pipe(Effect.tap((next) => Ref.set(current, next))),
    write,
    /** Also forgets that the plugin crashed the server: the user chose what happens next. */
    writeEnabled: (pluginId: PluginId, enabled: boolean) =>
      write((current) => ({
        ...withoutCrash(current, pluginId),
        enabled: { ...current.enabled, [pluginId]: enabled },
      })),
    /** Forgets that the plugin crashed the server, writing only if it had. */
    clearCrash: (pluginId: PluginId) =>
      read.pipe(
        Effect.flatMap((latest) =>
          latest.crashed?.[pluginId] === undefined
            ? Effect.void
            : write((last) => withoutCrash(last, pluginId)),
        ),
      ),
    /**
     * Saves that the plugin crashed the server, so the next start lists it as failed and leaves it
     * off. Synchronous, because Node exits right after; it throws if the write fails.
     */
    recordCrash: (pluginId: PluginId, message: string) => {
      // From disk, like `write`, unless it can't be read.
      let last = Ref.getUnsafe(current);
      try {
        last = decodeConfigSync(NodeFS.readFileSync(configPath, "utf8"));
      } catch {
        // Such as a file edited by hand into invalid JSON.
      }
      const next = { ...last, crashed: { ...last.crashed, [pluginId]: message } };
      const temporary = `${configPath}.crash-${process.pid}.tmp`;
      NodeFS.writeFileSync(temporary, `${encodeConfigSync(next)}\n`);
      NodeFS.renameSync(temporary, configPath);
    },
  };
});
