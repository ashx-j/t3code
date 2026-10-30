import { PluginId } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as JsonSchema from "effect/JsonSchema";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";

// The Settings page shows the summary, so it stays readable when a patch breaks many fields.
const MAX_VALIDATION_SUMMARY_LENGTH = 1000;

const persistenceOperations = {
  read: "read the settings",
  write: "save the settings",
  readSecret: "read a secret setting",
  writeSecret: "save a secret setting",
} as const;

export class PluginSettingsPersistenceError extends Schema.TaggedError<PluginSettingsPersistenceError>()(
  "PluginSettingsPersistenceError",
  {
    pluginId: PluginId,
    operation: Schema.Literals(["read", "write", "readSecret", "writeSecret"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${persistenceOperations[this.operation]} of plugin ${this.pluginId}.`;
  }
}

export class PluginSettingsSchemaError extends Schema.TaggedError<PluginSettingsSchemaError>()(
  "PluginSettingsSchemaError",
  {
    pluginId: PluginId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} has a settings schema T3 Code cannot validate.`;
  }
}

export class PluginSettingsValidationError extends Schema.TaggedError<PluginSettingsValidationError>()(
  "PluginSettingsValidationError",
  {
    pluginId: PluginId,
    summary: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid settings for plugin ${this.pluginId}: ${this.summary}`;
  }
}

export class PluginSettingsStore extends Context.Service<
  PluginSettingsStore,
  {
    /** Stored settings with secret values, for the plugin. JSON Schema defaults are not applied. */
    readonly get: (
      pluginId: PluginId,
      settingsSchema: Schema.JsonObject | undefined,
    ) => Effect.Effect<Schema.JsonObject, PluginSettingsPersistenceError>;
    /** Stored settings for clients. A secret that has a value reads as `SECRET_REDACTED`. */
    readonly getForClient: (
      pluginId: PluginId,
      settingsSchema: Schema.JsonObject | undefined,
    ) => Effect.Effect<Schema.JsonObject, PluginSettingsPersistenceError>;
    /**
     * Merges `patch` over the stored settings at the top level, where `null` removes a key and
     * `SECRET_REDACTED` keeps a secret, validates the result, saves it and returns the client view.
     */
    readonly update: (
      pluginId: PluginId,
      settingsSchema: Schema.JsonObject | undefined,
      patch: Schema.JsonObject,
    ) => Effect.Effect<
      Schema.JsonObject,
      PluginSettingsPersistenceError | PluginSettingsSchemaError | PluginSettingsValidationError
    >;
    /** The plugin view after each successful `update` of that plugin. */
    readonly changes: (pluginId: PluginId) => Stream.Stream<Schema.JsonObject>;
    /** Deletes the plugin's settings file and the secrets its schema declares. */
    readonly clear: (
      pluginId: PluginId,
      settingsSchema: Schema.JsonObject | undefined,
    ) => Effect.Effect<void, PluginSettingsPersistenceError>;
  }
>()("t3/plugins/PluginSettingsStore") {}

interface StoredSettings {
  readonly values: Schema.JsonObject;
  readonly secrets: Readonly<Record<string, string>>;
}

interface SettingsChange {
  readonly pluginId: PluginId;
  readonly settings: Schema.JsonObject;
}

const SettingsJson = fromJsonStringPretty(Schema.JsonObject);
const decodeSettingsJson = Schema.decodeUnknownEffect(SettingsJson);
const encodeSettingsJson = Schema.encodeEffect(SettingsJson);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Top-level string fields with `format: "t3-secret"` live in ServerSecretStore, never settings.json.
const secretFields = (settingsSchema: Schema.JsonObject | undefined): ReadonlySet<string> => {
  const properties = settingsSchema?.properties;
  if (!Predicate.isObject(properties)) return new Set();
  return new Set(
    Object.entries(properties).flatMap(([field, property]) =>
      Predicate.isObject(property) && property.type === "string" && property.format === "t3-secret"
        ? [field]
        : [],
    ),
  );
};

// Secret names become file names, so the field is base64url encoded.
const secretName = (pluginId: PluginId, field: string) =>
  `plugin-${pluginId}-${Buffer.from(field, "utf8").toString("base64url")}`;

const formatPathSegment = (segment: PropertyKey | { readonly key: PropertyKey }) => {
  const key = Predicate.isObject(segment) ? segment.key : segment;
  return typeof key === "number" ? `[${key}]` : `["${String(key)}"]`;
};

// Issues never carry input values because decoding does not set `reportInput`.
const summarizeIssue = (issue: SchemaIssue.Issue) => {
  const summary = SchemaIssue.makeFormatterStandardSchemaV1()(issue)
    .issues.map(({ path, message }) =>
      path === undefined || path.length === 0
        ? message
        : `at ${path.map(formatPathSegment).join("")}: ${message}`,
    )
    .join("; ");
  return summary.length > MAX_VALIDATION_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_VALIDATION_SUMMARY_LENGTH - 1)}…`
    : summary;
};

const compileSettingsSchema = (settingsSchema: Schema.JsonObject) =>
  Result.try(() =>
    Schema.decodeUnknownResult(
      // Imported JSON Schemas need no decoding services, which `Schema.Top` cannot express.
      Schema.make<Schema.Decoder<unknown>>(
        SchemaRepresentation.fromJsonSchemaDocument(
          JsonSchema.fromSchemaDraft2020_12(settingsSchema),
          // Plugins are trusted code, so their patterns are applied rather than rejected.
          { patterns: "apply" },
        ).ast,
      ),
      { onExcessProperty: "error", errors: "all" },
    ),
  );

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const writeSemaphore = yield* Semaphore.make(1);
  // Sliding, so a subscriber that stops pulling drops old changes instead of blocking `update`.
  const changesPubSub = yield* PubSub.sliding<SettingsChange>(64);
  // Keyed by schema identity: a reloaded plugin brings a new manifest object.
  const validators = new WeakMap<Schema.JsonObject, ReturnType<typeof compileSettingsSchema>>();

  const settingsPath = (pluginId: PluginId) =>
    path.join(stateDir, "plugin-data", pluginId, "settings.json");

  const validatorFor = (pluginId: PluginId, settingsSchema: Schema.JsonObject) => {
    let validator = validators.get(settingsSchema);
    if (validator === undefined) {
      validator = compileSettingsSchema(settingsSchema);
      validators.set(settingsSchema, validator);
    }
    return Result.isSuccess(validator)
      ? Effect.succeed(validator.success)
      : Effect.fail(new PluginSettingsSchemaError({ pluginId, cause: validator.failure }));
  };

  // Shares the span of the public operation that reads.
  const load = Effect.fnUntraced(
    function* (pluginId: PluginId, fields: ReadonlySet<string>) {
      const raw = yield* fileSystem.readFileString(settingsPath(pluginId)).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeedNone,
        ),
      );
      const stored = Option.isSome(raw) ? yield* decodeSettingsJson(raw.value) : {};
      const values = Object.fromEntries(Object.entries(stored).filter(([key]) => !fields.has(key)));
      const secrets = yield* Effect.forEach(
        fields,
        (field) =>
          secretStore.get(secretName(pluginId, field)).pipe(
            Effect.mapError(
              (cause) =>
                new PluginSettingsPersistenceError({ pluginId, operation: "readSecret", cause }),
            ),
            Effect.map(Option.map((bytes) => [field, textDecoder.decode(bytes)] as const)),
          ),
        { concurrency: "unbounded" },
      );
      return {
        values,
        secrets: Object.fromEntries(secrets.flatMap((secret) => Option.toArray(secret))),
      } satisfies StoredSettings;
    },
    (effect, pluginId) =>
      effect.pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            Effect.fail(new PluginSettingsPersistenceError({ pluginId, operation: "read", cause })),
          SchemaError: (cause) =>
            Effect.fail(new PluginSettingsPersistenceError({ pluginId, operation: "read", cause })),
        }),
      ),
  );

  const clientView = ({ values, secrets }: StoredSettings): Schema.JsonObject => ({
    ...values,
    ...Object.fromEntries(Object.keys(secrets).map((field) => [field, SECRET_REDACTED])),
  });

  const get = Effect.fn("PluginSettingsStore.get")(function* (
    pluginId: PluginId,
    settingsSchema: Schema.JsonObject | undefined,
  ) {
    const { values, secrets } = yield* load(pluginId, secretFields(settingsSchema));
    return { ...values, ...secrets } satisfies Schema.JsonObject;
  });

  const getForClient = Effect.fn("PluginSettingsStore.getForClient")(function* (
    pluginId: PluginId,
    settingsSchema: Schema.JsonObject | undefined,
  ) {
    return clientView(yield* load(pluginId, secretFields(settingsSchema)));
  });

  const update = Effect.fn("PluginSettingsStore.update")(function* (
    pluginId: PluginId,
    settingsSchema: Schema.JsonObject | undefined,
    patch: Schema.JsonObject,
  ) {
    const fields = secretFields(settingsSchema);
    const validate =
      settingsSchema === undefined ? undefined : yield* validatorFor(pluginId, settingsSchema);
    return yield* writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* load(pluginId, fields);
        const merged: Record<string, Schema.Json> = { ...current.values, ...current.secrets };
        for (const [key, value] of Object.entries(patch)) {
          if (fields.has(key) && value === SECRET_REDACTED) continue;
          if (value === null) delete merged[key];
          else merged[key] = value;
        }

        // Secrets are validated with their real values so `required` and type checks hold.
        const validation = validate?.(merged);
        if (validation !== undefined && Result.isFailure(validation)) {
          return yield* new PluginSettingsValidationError({
            pluginId,
            summary: summarizeIssue(validation.failure.issue),
          });
        }

        const next: StoredSettings = {
          values: Object.fromEntries(Object.entries(merged).filter(([key]) => !fields.has(key))),
          secrets: Object.fromEntries(
            Object.entries(merged).filter(
              (entry): entry is [string, string] =>
                fields.has(entry[0]) && typeof entry[1] === "string",
            ),
          ),
        };
        yield* Effect.forEach(
          fields,
          (field) => {
            const value = next.secrets[field];
            if (value === current.secrets[field]) return Effect.void;
            const name = secretName(pluginId, field);
            return (
              value === undefined
                ? secretStore.remove(name)
                : secretStore.set(name, textEncoder.encode(value))
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new PluginSettingsPersistenceError({ pluginId, operation: "writeSecret", cause }),
              ),
            );
          },
          { discard: true },
        );
        yield* encodeSettingsJson(next.values).pipe(
          Effect.flatMap((contents) =>
            writeFileStringAtomically({ filePath: settingsPath(pluginId), contents }),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) => new PluginSettingsPersistenceError({ pluginId, operation: "write", cause }),
          ),
        );

        yield* PubSub.publish(changesPubSub, {
          pluginId,
          settings: { ...next.values, ...next.secrets },
        });
        return clientView(next);
      }),
    );
  });

  const changes = (pluginId: PluginId) =>
    Stream.fromPubSub(changesPubSub).pipe(
      Stream.filter((change) => change.pluginId === pluginId),
      Stream.map((change) => change.settings),
    );

  const clear: PluginSettingsStore["Service"]["clear"] = Effect.fn("PluginSettingsStore.clear")(
    function* (pluginId, settingsSchema) {
      for (const field of secretFields(settingsSchema)) {
        yield* secretStore
          .remove(secretName(pluginId, field))
          .pipe(
            Effect.mapError(
              (cause) =>
                new PluginSettingsPersistenceError({ pluginId, operation: "writeSecret", cause }),
            ),
          );
      }
      yield* fileSystem
        .remove(path.dirname(settingsPath(pluginId)), { recursive: true, force: true })
        .pipe(
          Effect.mapError(
            (cause) => new PluginSettingsPersistenceError({ pluginId, operation: "write", cause }),
          ),
        );
    },
  );

  return PluginSettingsStore.of({ get, getForClient, update, changes, clear });
});

export const layer = Layer.effect(PluginSettingsStore, make);
