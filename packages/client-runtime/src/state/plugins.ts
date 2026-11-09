import { applyPluginStatesEvent, type PluginListResult, WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

const NO_PLUGINS: PluginListResult = { plugins: [] };

/** Plugin management. Nothing here runs until something reads it. */
export function createPluginEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
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
    setPluginEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:set-enabled",
      tag: WS_METHODS.pluginsSetEnabled,
    }),
    reloadPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:reload",
      tag: WS_METHODS.pluginsReload,
    }),
    rescanPlugins: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:rescan",
      tag: WS_METHODS.pluginsRescan,
    }),
  };
}
