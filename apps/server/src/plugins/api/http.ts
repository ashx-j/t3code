import type { PluginApi } from "@t3tools/plugin-sdk/server";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as PluginHttpRoutes from "../PluginHttpRoutes.ts";
import type { FacadeContext } from "./facade.ts";

export const makeHttpApi = (
  facade: FacadeContext,
  services: { readonly httpRoutes: PluginHttpRoutes.PluginHttpRoutes["Service"] },
): PluginApi["http"] => {
  const { activation, pluginId } = facade;
  const deactivated = activation.controller.signal;
  let unregistersOnAbort = false;
  return {
    route: (method, path, handler) => {
      if (deactivated.aborted) throw new Error("This plugin activation has ended.");
      const registered = Effect.runSyncExitWith(facade.context)(
        services.httpRoutes.register({
          pluginId,
          method,
          path,
          handler: (request, signal) =>
            Promise.resolve().then(() =>
              handler(request, { signal: AbortSignal.any([signal, deactivated]) }),
            ),
        }),
      );
      if (Exit.isFailure(registered)) {
        const error = Cause.squash(registered.cause);
        throw PluginHttpRoutes.isPluginHttpRouteInvalidError(error)
          ? new TypeError(`"${method} ${path}" is not a valid route. ${error.message}`)
          : error;
      }
      // Abort comes before any cleanup on deactivate, so a cleanup that hangs cannot keep routes live.
      if (!unregistersOnAbort) {
        unregistersOnAbort = true;
        deactivated.addEventListener(
          "abort",
          () => facade.fork(services.httpRoutes.unregisterPlugin(pluginId)),
          { once: true },
        );
      }
    },
  };
};
