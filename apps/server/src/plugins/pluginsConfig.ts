import type { PluginId } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

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
    /** Whether agents get the `t3_plugins_*` tools; off until the user turns them on. */
    agentTools: Schema.optionalKey(Schema.Boolean),
    devPaths: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type PluginsConfigFile = typeof PluginsConfigFile.Type;
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginsConfigFile));
const encodeConfig = Schema.encodeEffect(fromJsonStringPretty(PluginsConfigFile));

/** Builds the host's copy of `<stateDir>/plugins.json`, which it reads and writes through this. */
export const makePluginsConfig = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(config.stateDir, "plugins.json");
  const current = yield* Ref.make<PluginsConfigFile>({});
  // `setAgentTools` writes plugins.json outside the lifecycle lock, so every read that is written
  // back, or kept as the current config, holds this one.
  const lock = yield* Semaphore.make(1);

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
  }, lock.withPermits(1));

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
      ).pipe(
        Effect.tap((next) => Ref.set(current, next)),
        lock.withPermits(1),
      ),
    write,
    writeEnabled: (pluginId: PluginId, enabled: boolean) =>
      write((current) => ({
        ...current,
        enabled: { ...current.enabled, [pluginId]: enabled },
      })),
  };
});
