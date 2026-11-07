import type { EnvironmentId, PluginState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { pluginEnvironment } from "../state/plugins";

/** Whether this plugin has stylesheets for the page now. */
export const hasLoadableStyles = (plugin: PluginState) =>
  plugin.styles !== undefined &&
  plugin.styles.length > 0 &&
  plugin.enabled &&
  plugin.status === "active";

/**
 * Calls `onFound` once the environment has a plugin that `wanted` accepts; returns the function
 * that stops watching. The styles runtime follows the same atom, so it opens no second stream.
 */
export function watchForPlugins(
  environmentId: EnvironmentId,
  wanted: (plugin: PluginState) => boolean,
  onFound: () => void,
): () => void {
  let found = false;
  return appAtomRegistry.subscribe(
    pluginEnvironment.pluginsLive({ environmentId, input: {} }),
    (result) => {
      if (found || !AsyncResult.isSuccess(result)) return;
      if (!result.value.plugins.some(wanted)) return;
      found = true;
      onFound();
    },
    { immediate: true },
  );
}
