import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import type { PluginApi } from "@t3tools/plugin-sdk/server";
import type { PluginAcpAgent, PluginProviderRuntime } from "@t3tools/plugin-sdk/server/providers";
import type {
  AnyProviderDriver,
  ProviderDriver,
  ProviderDriverMetadata,
  ProviderInstance,
} from "@t3tools/provider-core/server/driver";
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
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { capabilityModelOption } from "../../mcp/OrchestratorMcpService.ts";
import type { BuiltInDriversEnv } from "../../provider/builtInDrivers.ts";
import type * as ProviderDriverRegistration from "../../provider/ProviderDriverRegistration.ts";
import type * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { makeAcpAgentDriver } from "../acpAgentDriver.ts";
import { type FacadeContext, refused } from "./facade.ts";

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
  Crypto: Crypto.Crypto,
};

const isDriverKind = Schema.is(ProviderDriverKind);
type ProviderClient = NonNullable<ProviderDriverMetadata["client"]>;

/**
 * The agent's client description as clients accept it, or why it is refused. A snapshot with an
 * icon outside the contract would be dropped from every client's provider list.
 */
const checkClient = (
  settingsSchema: Schema.JsonObject,
  iconUrl: PluginAcpAgent["iconUrl"],
): ProviderClient | string => {
  if (
    iconUrl !== undefined &&
    (typeof iconUrl !== "string" ||
      iconUrl.length > 2_048 ||
      iconUrl.trim() !== iconUrl ||
      !/^(https:\/\/|data:image\/)/.test(iconUrl))
  ) {
    return "iconUrl must be an https or data:image URL of at most 2,048 characters.";
  }
  return { settingsSchema, ...(iconUrl === undefined ? {} : { iconUrl }) };
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
    readonly providers: ProviderRegistry.ProviderRegistry["Service"];
    readonly providerDrivers: ProviderDriverRegistration.ProviderDriverRegistration["Service"];
  },
): PluginApi["providers"] => {
  const { activation, pluginId } = facade;
  // Resolves once the driver's instances are built; it leaves again when the plugin turns off.
  const register = (driver: AnyProviderDriver<BuiltInDriversEnv>) => {
    if (activation.controller.signal.aborted) {
      return refused(new Error("This plugin activation has ended."));
    }
    return facade.call(
      services.providerDrivers.add(driver).pipe(
        Effect.flatMap((remove) =>
          Effect.sync(() => {
            const removeNow = () =>
              facade.fork(
                remove.pipe(
                  Effect.tap(() => Effect.logInfo("plugin provider driver removed", { pluginId })),
                ),
              );
            // Registered while the plugin was being turned off: take it out again at once.
            if (activation.controller.signal.aborted) return removeNow();
            activation.controller.signal.addEventListener("abort", removeNow, { once: true });
          }),
        ),
      ),
    );
  };
  return {
    runtime: PROVIDER_RUNTIME,
    list: () =>
      facade.call(
        services.providers.getProviders.pipe(
          Effect.map((providers) =>
            providers.map((provider) => ({
              instanceId: provider.instanceId,
              driver: provider.driver,
              displayName: provider.displayName ?? null,
              enabled: provider.enabled,
              status: provider.status,
              models: provider.models.map((model) => ({
                id: model.slug,
                name: model.name,
                options: (model.capabilities?.optionDescriptors ?? []).map(capabilityModelOption),
              })),
            })),
          ),
        ),
      ),
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
        return refused(
          new TypeError(
            "An ACP agent needs a kind, a label and a command, with string arguments, environment and models.",
          ),
        );
      }
      const client = checkClient(acpAgentSettingsSchema(agent.command), agent.iconUrl);
      if (typeof client === "string") return refused(new TypeError(client));
      return register(withClientDriver(makeAcpAgentDriver({ ...agent, kind }), client));
    },
  };
};
