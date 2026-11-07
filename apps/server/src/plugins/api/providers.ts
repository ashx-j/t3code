import type { PluginApi } from "@t3tools/plugin-sdk/server";
import * as Effect from "effect/Effect";

import { capabilityModelOption } from "../../mcp/OrchestratorMcpService.ts";
import type * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import type { FacadeContext } from "./facade.ts";

export const makeProvidersApi = (
  facade: FacadeContext,
  services: {
    readonly providers: ProviderRegistry.ProviderRegistry["Service"];
  },
): PluginApi["providers"] => ({
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
});
