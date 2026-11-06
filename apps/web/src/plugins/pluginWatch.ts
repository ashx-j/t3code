import type { EnvironmentId, PluginState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { pluginEnvironment } from "../state/plugins";

/** Whether the web runtime should run this plugin's web part. */
export const isLoadableWebPlugin = (plugin: PluginState) =>
  plugin.hasWeb && plugin.enabled && plugin.status === "active";

/**
 * Calls `onFound` once the environment has an active plugin with a web part; returns the function
 * that stops watching. The runtime follows the same atom, so it opens no second stream.
 */
export function watchForWebPlugins(environmentId: EnvironmentId, onFound: () => void): () => void {
  let found = false;
  return appAtomRegistry.subscribe(
    pluginEnvironment.pluginsLive({ environmentId, input: {} }),
    (result) => {
      if (found || !AsyncResult.isSuccess(result)) return;
      if (!result.value.plugins.some(isLoadableWebPlugin)) return;
      found = true;
      onFound();
    },
    { immediate: true },
  );
}
