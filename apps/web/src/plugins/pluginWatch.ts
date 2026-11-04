import type { EnvironmentId, PluginState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { pluginEnvironment } from "../state/plugins";

/** Whether the web runtime should run this plugin's web part. */
export const isLoadableWebPlugin = (plugin: PluginState) =>
  plugin.hasWeb && plugin.enabled && plugin.status === "active";

/**
 * Calls `onFound` once the environment has an active plugin with a web part, and `onNone` once a
 * list has none and none still starting; returns the function that stops watching. The runtime
 * follows the same atom, so it opens no second stream.
 */
export function watchForWebPlugins(
  environmentId: EnvironmentId,
  onFound: () => void,
  onNone: () => void,
): () => void {
  let found = false;
  let decided = false;
  return appAtomRegistry.subscribe(
    pluginEnvironment.pluginsLive({ environmentId, input: {} }),
    (result) => {
      if (found || !AsyncResult.isSuccess(result)) return;
      const { plugins } = result.value;
      if (plugins.some(isLoadableWebPlugin)) {
        found = true;
        onFound();
        return;
      }
      // A server still starting its plugins lists them as loading; that isn't none yet.
      const starting = plugins.some(
        (plugin) => plugin.hasWeb && plugin.enabled && plugin.status === "loading",
      );
      if (decided || starting) return;
      decided = true;
      onNone();
    },
    { immediate: true },
  );
}
