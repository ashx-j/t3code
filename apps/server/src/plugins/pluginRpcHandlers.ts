import {
  type AuthEnvironmentScope,
  PluginError,
  type PluginId,
  type PluginListInput,
  type PluginReloadInput,
  type PluginRescanInput,
  type PluginSetEnabledInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as PluginHost from "./PluginHost.ts";

const toRpcError = (pluginId: PluginId) => (error: { readonly message: string }) =>
  new PluginError({ message: error.message, pluginId });

/** The `plugins.*` WebSocket handlers. `scopes` are the connected session's. */
export const makePluginRpcHandlers = (
  pluginHost: PluginHost.PluginHost["Service"],
  scopes: ReadonlyArray<AuthEnvironmentScope>,
) => ({
  [WS_METHODS.pluginsList]: (_input: PluginListInput) => pluginHost.listForClient(scopes),
  [WS_METHODS.pluginsSubscribeStates]: (_input: PluginListInput) =>
    pluginHost.streamForClient(scopes),
  [WS_METHODS.pluginsSetEnabled]: (input: PluginSetEnabledInput) =>
    pluginHost.setEnabled(input.pluginId, input.enabled).pipe(
      Effect.map((plugin) => ({ plugin })),
      Effect.mapError(toRpcError(input.pluginId)),
    ),
  [WS_METHODS.pluginsReload]: (input: PluginReloadInput) =>
    pluginHost.reload(input.pluginId).pipe(
      Effect.map((plugin) => ({ plugin })),
      Effect.mapError(toRpcError(input.pluginId)),
    ),
  [WS_METHODS.pluginsRescan]: (_input: PluginRescanInput) =>
    pluginHost.rescan.pipe(Effect.mapError((error) => new PluginError({ message: error.message }))),
});
