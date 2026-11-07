import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { PreparedHttpAuthorization } from "../connection/model.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { buildEnvironmentAuthHeaders } from "./environmentHttpAuth.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createRuntimeCommand,
} from "./runtime.ts";

/** Plugin management and calls into plugins. Nothing here runs until something reads it. */
export function createPluginEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Plugins removed without their data, and what each left.
  const leftoverPluginData = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:plugins:leftover-data",
    tag: WS_METHODS.pluginsListLeftoverData,
    idleTtlMs: 0,
  });
  const refreshLeftovers = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.refresh(leftoverPluginData({ environmentId, input: {} })));
  return {
    leftoverPluginData,
    deleteLeftoverPluginData: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:delete-leftover-data",
      tag: WS_METHODS.pluginsDeleteLeftoverData,
      onSuccess: refreshLeftovers,
    }),
    pluginsLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:plugins:live",
      tag: WS_METHODS.pluginsSubscribeStates,
    }),
    pluginSettings: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:plugins:settings",
      tag: WS_METHODS.pluginsSettingsGet,
      // Dropped when the editor closes, so reopening it shows the saved values.
      idleTtlMs: 0,
    }),
    setPluginEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:set-enabled",
      tag: WS_METHODS.pluginsSetEnabled,
    }),
    setAgentTools: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:set-agent-tools",
      tag: WS_METHODS.pluginsSetAgentTools,
    }),
    reloadPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:reload",
      tag: WS_METHODS.pluginsReload,
    }),
    installPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:install",
      tag: WS_METHODS.pluginsInstall,
    }),
    installPluginFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:install-files",
      tag: WS_METHODS.pluginsInstallFiles,
    }),
    rescanPlugins: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:rescan",
      tag: WS_METHODS.pluginsRescan,
    }),
    updatePlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:update",
      tag: WS_METHODS.pluginsUpdate,
    }),
    rollbackPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:rollback",
      tag: WS_METHODS.pluginsRollback,
    }),
    checkPluginUpdates: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:check-updates",
      tag: WS_METHODS.pluginsCheckUpdates,
    }),
    uninstallPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:uninstall",
      tag: WS_METHODS.pluginsUninstall,
      // Removing without the data adds to what is left.
      onSuccess: refreshLeftovers,
    }),
    // The web loader reports why a plugin's web half failed, so agents can read it.
    reportPluginWebFailure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:report-web-failure",
      tag: WS_METHODS.pluginsReportWebFailure,
    }),
    updatePluginSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:update-settings",
      tag: WS_METHODS.pluginsSettingsUpdate,
    }),
    // Web plugins call their own server half through these.
    invokePlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:invoke",
      tag: WS_METHODS.pluginsInvoke,
    }),
    pluginChannel: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:plugins:channel",
      tag: WS_METHODS.pluginsSubscribe,
      // A restart ends the server's stream, so the reloaded web half needs a new one, not this one.
      idleTtlMs: 0,
    }),
    // Plugin bundles and assets are plain GETs; over T3 Connect each needs its own DPoP proof.
    pluginFileHeaders: createRuntimeCommand(runtime, {
      label: "environment-data:plugins:file-headers",
      execute: (input: {
        readonly authorization: PreparedHttpAuthorization;
        readonly url: string;
      }) =>
        Effect.flatMap(Effect.serviceOption(ManagedRelayDpopSigner), (signer) =>
          buildEnvironmentAuthHeaders(input.authorization, "GET", input.url, signer),
        ).pipe(Effect.map((headers): Readonly<Record<string, string>> => ({ ...headers }))),
    }),
  };
}
