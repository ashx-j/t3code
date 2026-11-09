import type { EnvironmentId, PluginState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { pluginEnvironment } from "../state/plugins";
import { fetchPluginFile, withDownloadRetries } from "./pluginFiles";
import { setPluginWebFailure } from "./pluginRegistry";
import { hasLoadableStyles } from "./pluginWatch";

// Names every file and its contents, so a restart with the same files downloads nothing.
const stylesKey = (plugin: PluginState) =>
  (plugin.styles ?? []).map(({ file, revision }) => `${file}@${revision}`).join(",");

/**
 * Adds the stylesheets of the environment's active plugins to the end of the page's head, after
 * T3's own CSS and the theme, and follows plugin state until stopped. Changed files replace a
 * plugin's old ones once all of them have downloaded.
 */
export function startPluginStyles(environmentId: EnvironmentId): () => void {
  const applied = new Map<
    PluginState["id"],
    { readonly key: string; readonly sheets: Element[] }
  >();
  // The download each plugin waits for; one that a newer change replaced is dropped.
  const pending = new Map<PluginState["id"], string>();
  // Plugins whose row shows a styles failure, which only this module clears: the web loader
  // keeps its own failures on the same row.
  const failed = new Set<PluginState["id"]>();
  let stopped = false;

  const remove = (pluginId: PluginState["id"]) => {
    for (const sheet of applied.get(pluginId)?.sheets ?? []) sheet.remove();
    applied.delete(pluginId);
  };
  const clearFailure = (pluginId: PluginState["id"]) => {
    if (failed.delete(pluginId)) setPluginWebFailure(environmentId, pluginId, undefined);
  };

  const apply = async (plugin: PluginState, key: string) => {
    pending.set(plugin.id, key);
    const current = () => !stopped && pending.get(plugin.id) === key;
    try {
      const texts = await Promise.all(
        (plugin.styles ?? []).map(({ file, revision }) =>
          withDownloadRetries(
            () =>
              fetchPluginFile(
                environmentId,
                plugin,
                `/styles/${encodeURIComponent(file)}`,
                revision,
              ).then((response) => response.text()),
            () => !current(),
          ),
        ),
      );
      if (!current()) return;
      pending.delete(plugin.id);
      remove(plugin.id);
      const sheets = texts.map((css) => {
        const sheet = document.createElement("style");
        sheet.dataset.plugin = plugin.id;
        sheet.textContent = css ?? "";
        return sheet;
      });
      document.head.append(...sheets);
      applied.set(plugin.id, { key, sheets });
      clearFailure(plugin.id);
    } catch (error) {
      if (!current()) return;
      // Tried again on the next plugin update, like a web bundle that fails to download.
      pending.delete(plugin.id);
      failed.add(plugin.id);
      setPluginWebFailure(
        environmentId,
        plugin.id,
        error instanceof Error ? error.message : "The plugin's styles failed to load.",
      );
    }
  };

  const reconcile = (plugins: ReadonlyArray<PluginState>) => {
    const wanted = new Map(
      plugins.filter(hasLoadableStyles).map((plugin) => [plugin.id, plugin] as const),
    );
    for (const pluginId of new Set([...applied.keys(), ...pending.keys(), ...failed])) {
      if (wanted.has(pluginId)) continue;
      pending.delete(pluginId);
      remove(pluginId);
      clearFailure(pluginId);
    }
    for (const plugin of wanted.values()) {
      const key = stylesKey(plugin);
      if (applied.get(plugin.id)?.key !== key && pending.get(plugin.id) !== key) {
        void apply(plugin, key);
      }
    }
  };

  const stopFollowing = appAtomRegistry.subscribe(
    pluginEnvironment.pluginsLive({ environmentId, input: {} }),
    (result) => {
      if (!stopped && AsyncResult.isSuccess(result)) reconcile(result.value.plugins);
    },
    { immediate: true },
  );

  return () => {
    stopped = true;
    stopFollowing();
    pending.clear();
    // Deleting the entry a Map or Set iteration is on is safe.
    for (const pluginId of applied.keys()) remove(pluginId);
    for (const pluginId of failed) clearFailure(pluginId);
  };
}
