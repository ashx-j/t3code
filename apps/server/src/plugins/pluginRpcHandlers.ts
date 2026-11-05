import {
  type AuthEnvironmentScope,
  type PluginCheckUpdatesInput,
  PluginError,
  type PluginId,
  type PluginInstallFilesInput,
  type PluginInstallInput,
  type PluginInvokeInput,
  type PluginListInput,
  type PluginReloadInput,
  type PluginReportWebFailureInput,
  type PluginRescanInput,
  type PluginSetAgentToolsInput,
  type PluginSetEnabledInput,
  type PluginSettingsGetInput,
  type PluginSettingsUpdateInput,
  type PluginSubscribeInput,
  type PluginUninstallInput,
  type PluginUpdateInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
    Effect.all({
      plugins: pluginHost.list,
      agentTools: pluginHost.agentTools.pipe(
        Stream.runHead,
        Effect.map(Option.getOrElse(() => false)),
      ),
    }),
  [WS_METHODS.pluginsSubscribeStates]: (_input: PluginListInput) =>
    Stream.zipLatest(pluginHost.streamStates, pluginHost.agentTools).pipe(
      Stream.map(([plugins, agentTools]) => ({ plugins, agentTools })),
    ),
  [WS_METHODS.pluginsSetAgentTools]: (input: PluginSetAgentToolsInput) =>
    pluginHost.setAgentTools(input.enabled).pipe(
      Effect.map((agentTools) => ({ agentTools })),
      Effect.mapError((error) => new PluginError({ message: error.message })),
    ),
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
  [WS_METHODS.pluginsInstall]: (input: PluginInstallInput) =>
    pluginHost.install(input.source).pipe(
      Effect.map((plugin) => ({ plugin })),
      Effect.mapError((error) => new PluginError({ message: error.message })),
    ),
  [WS_METHODS.pluginsInstallFiles]: (input: PluginInstallFilesInput) =>
    pluginHost.installFiles(input.files).pipe(
      Effect.map((plugin) => ({ plugin })),
      Effect.mapError((error) => new PluginError({ message: error.message })),
    ),
  [WS_METHODS.pluginsRescan]: (_input: PluginRescanInput) =>
    pluginHost.rescan.pipe(Effect.mapError((error) => new PluginError({ message: error.message }))),
  [WS_METHODS.pluginsUpdate]: (input: PluginUpdateInput) =>
    pluginHost.update(input.pluginId).pipe(
      Effect.map((plugin) => ({ plugin })),
      Effect.mapError(toRpcError(input.pluginId)),
    ),
  [WS_METHODS.pluginsCheckUpdates]: (_input: PluginCheckUpdatesInput) =>
    pluginHost.checkUpdates.pipe(
      Effect.map((plugins) => ({ plugins })),
      Effect.mapError((error) => new PluginError({ message: error.message })),
    ),
  [WS_METHODS.pluginsReportWebFailure]: (input: PluginReportWebFailureInput) =>
    pluginHost.reportWebFailure(input).pipe(Effect.mapError(toRpcError(input.pluginId))),
  [WS_METHODS.pluginsUninstall]: (input: PluginUninstallInput) =>
    pluginHost
      .uninstall(input.pluginId, input.removeData === true, input.linkedFolder)
      .pipe(Effect.as({ pluginId: input.pluginId }), Effect.mapError(toRpcError(input.pluginId))),
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
