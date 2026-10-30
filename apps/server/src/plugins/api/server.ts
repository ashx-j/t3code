import { ExecutionEnvironmentDescriptor, ServerSettings } from "@t3tools/contracts";
import type { PluginApi } from "@t3tools/plugin-sdk/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import type { FacadeContext } from "./facade.ts";

const encodeDescriptor = Schema.encodeUnknownEffect(
  Schema.toCodecJson(ExecutionEnvironmentDescriptor),
);
const encodeSettings = Schema.encodeUnknownEffect(Schema.toCodecJson(ServerSettings));
const isJsonObject = Schema.is(Schema.JsonObject);
const asJsonObject = (value: unknown): Schema.JsonObject => (isJsonObject(value) ? value : {});

export const makeServerApi = (
  facade: FacadeContext,
  services: {
    readonly version: string;
    readonly environment: ServerEnvironment.ServerEnvironment["Service"];
    readonly settings: ServerSettingsModule.ServerSettingsService["Service"];
  },
): PluginApi["server"] => ({
  version: services.version,
  environment: () =>
    facade.call(
      services.environment.getDescriptor.pipe(
        Effect.flatMap(encodeDescriptor),
        Effect.map(asJsonObject),
      ),
    ),
  settings: () =>
    facade.call(
      services.settings.getSettings.pipe(
        Effect.map(ServerSettingsModule.redactServerSettingsForClient),
        Effect.flatMap(encodeSettings),
        Effect.map(asJsonObject),
      ),
    ),
});
