import type { PluginApi } from "@t3tools/plugin-sdk/server";
import { providerAuth } from "@t3tools/source-control-core/server/discovery";
import { UNKNOWN_SOURCE_CONTROL_CLIENT } from "@t3tools/source-control-core/shared/definition";
import * as Effect from "effect/Effect";

import * as BuiltInDrivers from "../../sourceControl/builtInDrivers.ts";
import type { FacadeContext } from "./facade.ts";

export const makeSourceControlApi = (
  facade: FacadeContext,
  services: {
    readonly sourceControlDrivers: BuiltInDrivers.SourceControlPluginDrivers["Service"];
  },
): PluginApi["sourceControl"] => ({
  runtime: { unknownDefinition: UNKNOWN_SOURCE_CONTROL_CLIENT, providerAuth },
  registerDriver: (driver) => {
    const { activation, pluginId } = facade;
    if (activation.controller.signal.aborted) {
      return Promise.reject(new Error("This plugin activation has ended."));
    }
    if (
      !BuiltInDrivers.isSourceControlProviderKind(driver.kind) ||
      driver.kind === UNKNOWN_SOURCE_CONTROL_CLIENT.kind ||
      typeof driver.definition !== "object" ||
      driver.definition === null ||
      driver.definition.kind !== driver.kind ||
      typeof driver.definition.recognizeRemote !== "function" ||
      !Effect.isEffect(driver.make)
    ) {
      return Promise.reject(
        new TypeError(
          "A source control driver needs a kind, a definition of the same kind with recognizeRemote, and make built with runtime.Effect.",
        ),
      );
    }
    return facade.call(services.sourceControlDrivers.add(driver)).then((remove) => {
      const removeNow = () =>
        facade.fork(
          remove.pipe(
            Effect.tap(() =>
              Effect.logInfo("plugin source control host removed", { pluginId, kind: driver.kind }),
            ),
          ),
        );
      if (activation.controller.signal.aborted) return removeNow();
      activation.controller.signal.addEventListener("abort", removeNow, { once: true });
    });
  },
});
