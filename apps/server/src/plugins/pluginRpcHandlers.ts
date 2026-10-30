import {
  type AuthEnvironmentScope,
  PluginError,
  type PluginId,
  type PluginInvokeInput,
  type PluginListInput,
  type PluginReloadInput,
  type PluginSetEnabledInput,
  type PluginSettingsGetInput,
  type PluginSettingsUpdateInput,
  type PluginSubscribeInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { rpcAuthorizationError } from "../auth/RpcAuthorization.ts";
import * as PluginHost from "./PluginHost.ts";

const toRpcError = (pluginId: PluginId) => (error: { readonly message: string }) =>
  PluginHost.isPluginAccessDeniedError(error)
    ? rpcAuthorizationError(error.requiredScope)
    : new PluginError({ message: error.message, pluginId });

/** The `plugins.*` WebSocket handlers. `scopes` are the connected session's. */
export const makePluginRpcHandlers = (
  pluginHost: PluginHost.PluginHost["Service"],
  scopes: ReadonlyArray<AuthEnvironmentScope>,
) => ({
  [WS_METHODS.pluginsList]: (_input: PluginListInput) =>
    pluginHost.list.pipe(Effect.map((plugins) => ({ plugins }))),
  [WS_METHODS.pluginsSubscribeStates]: (_input: PluginListInput) =>
    pluginHost.streamStates.pipe(Stream.map((plugins) => ({ plugins }))),
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
  [WS_METHODS.pluginsSettingsGet]: (input: PluginSettingsGetInput) =>
    pluginHost.getSettings(input.pluginId).pipe(
      Effect.map((settings) => ({ pluginId: input.pluginId, settings })),
      Effect.mapError(toRpcError(input.pluginId)),
    ),
  [WS_METHODS.pluginsSettingsUpdate]: (input: PluginSettingsUpdateInput) =>
    pluginHost.updateSettings(input.pluginId, input.patch).pipe(
      Effect.map((settings) => ({ pluginId: input.pluginId, settings })),
      Effect.mapError(toRpcError(input.pluginId)),
    ),
  [WS_METHODS.pluginsInvoke]: (input: PluginInvokeInput) =>
    pluginHost
      .invoke({ pluginId: input.pluginId, method: input.method, input: input.input, scopes })
      .pipe(
        Effect.map((output) => ({ output })),
        Effect.mapError(toRpcError(input.pluginId)),
      ),
  [WS_METHODS.pluginsSubscribe]: (input: PluginSubscribeInput) =>
    pluginHost.subscribe(input).pipe(
      Stream.map((value) => ({ value })),
      Stream.mapError(toRpcError(input.pluginId)),
    ),
});
