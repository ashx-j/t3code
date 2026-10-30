import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Plugin management and calls into plugins. Nothing here runs until something reads it. */
export function createPluginEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
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
    reloadPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:reload",
      tag: WS_METHODS.pluginsReload,
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
    }),
  };
}
