import type { EnvironmentId, PluginState } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { pluginEnvironment } from "../state/plugins";
import { pluginUiEnvironmentsAtom } from "./pluginFollow";

const isPluginOn = (plugin: PluginState) => plugin.enabled && plugin.status === "active";

/** Whether the web runtime should run this plugin's web part. */
export const isLoadableWebPlugin = (plugin: PluginState) => plugin.hasWeb && isPluginOn(plugin);

/** Whether this plugin has stylesheets for the page now. */
export const hasLoadableStyles = (plugin: PluginState) =>
  plugin.styles !== undefined && plugin.styles.length > 0 && isPluginOn(plugin);

/**
 * Calls `onFound` once the environment has a plugin that `wanted` accepts; returns the function
 * that stops watching. The runtimes follow the same atom, so they open no second stream.
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

// App-wide contributions, such as commands and styles, have no thread to tie them to an
// environment, so a plugin on in several chosen environments takes them from the first. An
// environment whose list has not arrived claims nothing yet.
const appWideEnvironmentsAtom = Atom.make((get) => {
  const owners = new Map<PluginState["id"], EnvironmentId>();
  for (const environmentId of get(pluginUiEnvironmentsAtom)) {
    const result = get(pluginEnvironment.pluginsLive({ environmentId, input: {} }));
    if (!AsyncResult.isSuccess(result)) continue;
    for (const plugin of result.value.plugins) {
      if (isPluginOn(plugin) && !owners.has(plugin.id)) owners.set(plugin.id, environmentId);
    }
  }
  return owners;
});

/**
 * Calls `onChange` with the environment's plugins now and after each change, until stopped.
 * `appWide` says whether a plugin's app-wide contributions come from this environment.
 */
export function followPlugins(
  environmentId: EnvironmentId,
  onChange: (
    plugins: ReadonlyArray<PluginState>,
    appWide: (pluginId: PluginState["id"]) => boolean,
  ) => void,
): () => void {
  const latest = Atom.make((get) => {
    const result = get(pluginEnvironment.pluginsLive({ environmentId, input: {} }));
    return AsyncResult.isSuccess(result)
      ? { plugins: result.value.plugins, owners: get(appWideEnvironmentsAtom) }
      : undefined;
  });
  return appAtomRegistry.subscribe(
    latest,
    (value) => {
      if (value !== undefined) {
        onChange(value.plugins, (pluginId) => value.owners.get(pluginId) === environmentId);
      }
    },
    { immediate: true },
  );
}
