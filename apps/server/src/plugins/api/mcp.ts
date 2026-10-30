import type { PluginApi } from "@t3tools/plugin-sdk/server";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import * as PluginMcpTools from "../PluginMcpTools.ts";
import type { FacadeContext } from "./facade.ts";

const isAccess = Schema.is(Schema.Literals(["read", "write"]));
const isJsonObject = Schema.is(Schema.JsonObject);

export const makeMcpApi = (
  facade: FacadeContext,
  services: { readonly mcpTools: PluginMcpTools.PluginMcpTools["Service"] },
): PluginApi["mcp"] => {
  const { activation, pluginId } = facade;
  const deactivated = activation.controller.signal;
  let unregistersOnAbort = false;
  return {
    registerTool: (tool, handler) => {
      if (deactivated.aborted) throw new Error("This plugin activation has ended.");
      // Plugins are untyped JavaScript, and a misspelled access level must not open a write.
      if (!isAccess(tool.access)) {
        throw new TypeError(`Tool "${tool.name}" needs access "read" or "write".`);
      }
      if (typeof tool.description !== "string" || !isJsonObject(tool.inputSchema)) {
        throw new TypeError(`Tool "${tool.name}" needs a description and a JSON Schema object.`);
      }
      const registered = Effect.runSyncExitWith(facade.context)(
        services.mcpTools.register({
          pluginId,
          tool,
          handler: (input, signal) =>
            Promise.resolve().then(() =>
              handler(input, { signal: AbortSignal.any([signal, deactivated]) }),
            ),
        }),
      );
      if (Exit.isFailure(registered)) {
        const error = Cause.squash(registered.cause);
        throw PluginMcpTools.isPluginMcpToolNameError(error)
          ? new TypeError(`"${tool.name}" is not a valid tool name. ${error.message}`)
          : error;
      }
      // Abort comes before any cleanup on deactivate, so a cleanup that hangs cannot keep tools live.
      if (!unregistersOnAbort) {
        unregistersOnAbort = true;
        deactivated.addEventListener(
          "abort",
          () => facade.fork(services.mcpTools.unregisterPlugin(pluginId)),
          { once: true },
        );
      }
    },
  };
};
