import {
  applyPluginStatesEvent,
  type EnvironmentId,
  type PluginListResult,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Atom, AtomRegistry } from "effect/reactivity";

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

const NO_PLUGINS: PluginListResult = { plugins: [] };

/** Plugin management. Nothing here runs until something reads it. */
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
    // The server sends the list once, then the rows that change; readers get the whole list.
    pluginsLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:plugins:live",
      tag: WS_METHODS.pluginsSubscribeStates,
      // `scan` emits its seed first; skipping it keeps the list loading until the first event.
      transform: (events) =>
        events.pipe(
          Stream.scan(() => NO_PLUGINS, applyPluginStatesEvent),
          Stream.filter((list) => list !== NO_PLUGINS),
        ),
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
    reloadPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:reload",
      tag: WS_METHODS.pluginsReload,
    }),
    installPluginFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:install-files",
      tag: WS_METHODS.pluginsInstallFiles,
    }),
    rescanPlugins: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:rescan",
      tag: WS_METHODS.pluginsRescan,
    }),
    uninstallPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:uninstall",
      tag: WS_METHODS.pluginsUninstall,
      // Removing without the data adds to what is left.
      onSuccess: refreshLeftovers,
    }),
    updatePluginSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:update-settings",
      tag: WS_METHODS.pluginsSettingsUpdate,
    }),
    // Plugin stylesheets are plain GETs; over T3 Connect each needs its own DPoP proof.
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
