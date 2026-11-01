import { ProviderDriverKind, type ServerProvider, TextGenerationError } from "@t3tools/contracts";
import type { PluginApi } from "@t3tools/plugin-sdk/server";
import type {
  PluginProviderDriver,
  PluginProviderDriverEnv,
  PluginProviderRuntime,
} from "@t3tools/plugin-sdk/server/providers";
import {
  type AnyProviderDriver,
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderDriverMetadata,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { BuiltInDriversEnv } from "../../provider/builtInDrivers.ts";
import type * as ProviderDriverRegistration from "../../provider/ProviderDriverRegistration.ts";
import { makeAcpAgentDriver } from "../acpAgentDriver.ts";
import type { FacadeContext } from "./facade.ts";

// Modules the server already uses, so handing them over grows nothing.
const PROVIDER_RUNTIME: PluginProviderRuntime = {
  Effect,
  Stream,
  Schema,
  Scope,
  Context,
  Layer,
  Ref,
  PubSub,
  Queue,
  Deferred,
  Option,
  Exit,
  Cause,
  Duration,
  DateTime,
  Fiber,
  FileSystem: FileSystem.FileSystem,
  Path: Path.Path,
  Crypto: Crypto.Crypto,
  ChildProcessSpawner: ChildProcessSpawner.ChildProcessSpawner,
  ProviderHost: ProviderHost.ProviderHost,
  ProviderAdapterV2: ProviderAdapter.ProviderAdapterV2,
  ProviderDriverError,
  TextGenerationError,
  defaultProviderContinuationIdentity,
  buildServerProvider,
  withInstanceIdentity,
  makeManagedServerProvider,
  makeManualOnlyProviderMaintenanceCapabilities,
};

const isDriverKind = Schema.is(ProviderDriverKind);

const errorText = (error: unknown) => {
  try {
    return (error instanceof Error ? error.message : String(error)).slice(0, 500);
  } catch {
    return "Unknown error";
  }
};

const isJsonObject = Schema.is(Schema.JsonObject);

type ProviderClient = NonNullable<ProviderDriverMetadata["client"]>;

/**
 * The driver's client description as clients accept it, or why it is refused. A snapshot with an
 * icon outside the contract would be dropped from every client's provider list.
 */
const checkClient = (client: PluginProviderDriver["client"]): ProviderClient | string => {
  const settingsSchema = client?.settingsSchema;
  const iconUrl = client?.iconUrl;
  if (settingsSchema !== undefined && !isJsonObject(settingsSchema)) {
    return "client.settingsSchema must be a JSON Schema object.";
  }
  // The form saves into the instance's config, which every connected client receives.
  if (settingsSchema !== undefined && JSON.stringify(settingsSchema).includes('"t3-secret"')) {
    return "client.settingsSchema cannot have t3-secret fields; put secrets in the instance's environment variables.";
  }
  if (
    iconUrl !== undefined &&
    (typeof iconUrl !== "string" ||
      iconUrl.length > 2_048 ||
      iconUrl.trim() !== iconUrl ||
      !/^(https:\/\/|data:image\/)/.test(iconUrl))
  ) {
    return "client.iconUrl must be an https or data:image URL of at most 2,048 characters.";
  }
  return {
    ...(settingsSchema === undefined ? {} : { settingsSchema }),
    ...(iconUrl === undefined ? {} : { iconUrl }),
  };
};

/** Stamps the driver's client description onto every snapshot its instance reports. */
const withClient = (instance: ProviderInstance, client: ProviderClient): ProviderInstance => {
  const { settingsSchema, iconUrl } = client;
  if (settingsSchema === undefined && iconUrl === undefined) return instance;
  const stamp = (snapshot: ServerProvider): ServerProvider => ({
    ...snapshot,
    ...(settingsSchema === undefined ? {} : { settingsSchema }),
    ...(iconUrl === undefined || snapshot.iconUrl !== undefined ? {} : { iconUrl }),
  });
  return {
    ...instance,
    snapshot: {
      ...instance.snapshot,
      getSnapshot: instance.snapshot.getSnapshot.pipe(Effect.map(stamp)),
      refresh: instance.snapshot.refresh.pipe(Effect.map(stamp)),
      streamChanges: instance.snapshot.streamChanges.pipe(Stream.map(stamp)),
    },
  };
};

/**
 * The plugin's driver with every failure of its own code turned into a driver error: the
 * registry reports those as an unavailable instance, while a defect would stop a reconcile.
 */
const guardedDriver = <Config>(
  driver: PluginProviderDriver<Config>,
  client: ProviderClient,
): AnyProviderDriver<PluginProviderDriverEnv> => ({
  driverKind: driver.driverKind,
  metadata: { ...driver.metadata, client },
  configSchema: driver.configSchema,
  defaultConfig: () => driver.defaultConfig(),
  create: (input) =>
    Effect.suspend(() => {
      const created = driver.create(input);
      return Effect.isEffect(created)
        ? created.pipe(Effect.map((instance) => withClient(instance, client)))
        : Effect.fail(
            new ProviderDriverError({
              driver: driver.driverKind,
              instanceId: input.instanceId,
              detail: "The plugin's create did not return an Effect from runtime.Effect.",
            }),
          );
    }).pipe(
      Effect.catchDefect((defect) =>
        Effect.fail(
          new ProviderDriverError({
            driver: driver.driverKind,
            instanceId: input.instanceId,
            detail: `The plugin's driver failed: ${errorText(defect)}`,
            cause: defect,
          }),
        ),
      ),
    ),
});

const isStringList = Schema.is(Schema.Array(Schema.String));
const isStringRecord = Schema.is(Schema.Record(Schema.String, Schema.String));
const isModelList = Schema.is(
  Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
);

/** The instance settings an ACP agent offers, as the generic provider form draws them. */
const acpAgentSettingsSchema = (command: string): Schema.JsonObject => ({
  type: "object",
  properties: {
    command: {
      type: "string",
      title: "Command",
      description: `Leave empty to run ${command}.`,
    },
    args: {
      type: "array",
      items: { type: "string" },
      title: "Arguments",
      description: "Leave empty for the plugin's arguments.",
    },
  },
});

/** Stamps the client description onto every instance the driver creates. */
const withClientDriver = <Config, R>(
  driver: AnyProviderDriver<R> & ProviderDriver<Config, R>,
  client: ProviderClient,
): ProviderDriver<Config, R> => ({
  ...driver,
  metadata: { ...driver.metadata, client },
  create: (input) =>
    driver.create(input).pipe(Effect.map((instance) => withClient(instance, client))),
});

export const makeProvidersApi = (
  facade: FacadeContext,
  services: {
    readonly providerDrivers: ProviderDriverRegistration.ProviderDriverRegistration["Service"];
  },
): PluginApi["providers"] => {
  const { activation, pluginId } = facade;
  // Resolves once the driver's instances are built; it leaves again when the plugin turns off.
  const register = (driver: AnyProviderDriver<BuiltInDriversEnv>) => {
    if (activation.controller.signal.aborted) {
      return Promise.reject(new Error("This plugin activation has ended."));
    }
    return facade.call(services.providerDrivers.add(driver)).then((remove) => {
      const removeNow = () =>
        facade.fork(
          remove.pipe(
            Effect.tap(() => Effect.logInfo("plugin provider driver removed", { pluginId })),
          ),
        );
      // Registered while the plugin was being turned off: take it out again at once.
      if (activation.controller.signal.aborted) return removeNow();
      activation.controller.signal.addEventListener("abort", removeNow, { once: true });
    });
  };
  return {
    runtime: PROVIDER_RUNTIME,
    registerDriver: (driver) => {
      if (
        !isDriverKind(driver.driverKind) ||
        typeof driver.metadata?.displayName !== "string" ||
        !Schema.isSchema(driver.configSchema) ||
        typeof driver.defaultConfig !== "function" ||
        typeof driver.create !== "function"
      ) {
        return Promise.reject(
          new TypeError(
            "A provider driver needs a driverKind, metadata.displayName, a configSchema from runtime.Schema, defaultConfig and create.",
          ),
        );
      }
      const client = checkClient(driver.client);
      if (typeof client === "string") return Promise.reject(new TypeError(client));
      return register(guardedDriver(driver, client));
    },
    registerAcpAgent: (agent) => {
      const kind = agent.kind;
      if (
        !isDriverKind(kind) ||
        typeof agent.label !== "string" ||
        typeof agent.command !== "string" ||
        agent.command.trim() === "" ||
        (agent.args !== undefined && !isStringList(agent.args)) ||
        (agent.env !== undefined && !isStringRecord(agent.env)) ||
        (agent.models !== undefined && !isModelList(agent.models))
      ) {
        return Promise.reject(
          new TypeError(
            "An ACP agent needs a kind, a label and a command, with string arguments, environment and models.",
          ),
        );
      }
      const client = checkClient({
        settingsSchema: acpAgentSettingsSchema(agent.command),
        ...(agent.iconUrl === undefined ? {} : { iconUrl: agent.iconUrl }),
      });
      if (typeof client === "string") return Promise.reject(new TypeError(client));
      return register(withClientDriver(makeAcpAgentDriver({ ...agent, kind }), client));
    },
  };
};
