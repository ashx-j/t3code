import * as NodeServices from "@effect/platform-node/NodeServices";
import { PluginId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";

const hello = PluginId.make("hello");

const settingsSchema: Schema.JsonObject = {
  type: "object",
  properties: {
    count: { type: "integer", minimum: 0 },
    name: { type: "string" },
    token: { type: "string", format: "t3-secret" },
  },
  additionalProperties: false,
};

const layerTest = () =>
  Layer.mergeAll(PluginSettingsStore.layer, ServerSettings.layer).pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3code-plugin-settings-test-" }),
      ),
    ),
  );

const readSettingsFile = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(
    path.join(stateDir, "plugin-data", hello, "settings.json"),
  );
});

it.layer(NodeServices.layer)("PluginSettingsStore", (it) => {
  it.effect("rejects values outside the schema without writing them", () =>
    Effect.gen(function* () {
      const store = yield* PluginSettingsStore.PluginSettingsStore;
      yield* store.update(hello, settingsSchema, { count: 1 });

      const error = yield* Effect.flip(
        store.update(hello, settingsSchema, { count: -1, extra: true }),
      );
      assert.strictEqual(error._tag, "PluginSettingsValidationError");
      assert.include(error.message, 'at ["count"]: Expected a value greater than or equal to 0');
      assert.include(error.message, 'at ["extra"]: Expected no excess property');
      assert.deepStrictEqual(yield* store.get(hello, settingsSchema), { count: 1 });
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("keeps secrets out of settings.json and redacts them for clients", () =>
    Effect.gen(function* () {
      const store = yield* PluginSettingsStore.PluginSettingsStore;
      const { secretsDir } = yield* ServerConfig.ServerConfig;

      assert.deepStrictEqual(
        yield* store.update(hello, settingsSchema, { name: "a", token: "s3cret" }),
        { name: "a", token: SECRET_REDACTED },
      );
      assert.deepStrictEqual(yield* store.get(hello, settingsSchema), {
        name: "a",
        token: "s3cret",
      });
      assert.deepStrictEqual(JSON.parse(yield* readSettingsFile), { name: "a" });

      yield* store.update(hello, settingsSchema, { name: "b", token: SECRET_REDACTED });
      assert.deepStrictEqual(yield* store.get(hello, settingsSchema), {
        name: "b",
        token: "s3cret",
      });

      yield* store.update(hello, settingsSchema, { token: null });
      assert.deepStrictEqual(yield* store.getForClient(hello, settingsSchema), { name: "b" });
      const secretNames = yield* FileSystem.FileSystem.use((fileSystem) =>
        fileSystem.readDirectory(secretsDir),
      );
      assert.isFalse(secretNames.some((name) => name.startsWith(`plugin-${hello}-`)));
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("keeps plugin settings when the server saves its own settings", () =>
    Effect.gen(function* () {
      const store = yield* PluginSettingsStore.PluginSettingsStore;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      yield* store.update(hello, settingsSchema, { count: 2, token: "s3cret" });

      yield* serverSettings.updateSettings({ addProjectBaseDirectory: "~/next" });

      assert.deepStrictEqual(yield* store.get(hello, settingsSchema), {
        count: 2,
        token: "s3cret",
      });
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("emits the plugin view after an update of that plugin", () =>
    Effect.gen(function* () {
      const store = yield* PluginSettingsStore.PluginSettingsStore;
      const next = yield* store
        .changes(hello)
        .pipe(Stream.runHead, Effect.forkChild({ startImmediately: true }));

      yield* store.update(PluginId.make("other"), undefined, { count: 9 });
      yield* store.update(hello, settingsSchema, { count: 3, token: "s3cret" });

      assert.deepStrictEqual(yield* Fiber.join(next), Option.some({ count: 3, token: "s3cret" }));
    }).pipe(Effect.provide(layerTest())),
  );
});
