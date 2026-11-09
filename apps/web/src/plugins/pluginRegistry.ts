import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { ComponentType } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";

export interface PluginRightPanelEntry {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly name: string;
  readonly title: string;
  readonly component: ComponentType<{ readonly threadId: string }>;
  readonly owner: PluginOwner;
}

// Plain maps with one list-level version: readers re-render on the version alone, so a plugin never
// adds a subscription per panel. App code outside the plugin runtime and lazy routes reads them
// through `pluginUi.ts`, so this stays out of startup.
const rightPanels = new Map<string, PluginRightPanelEntry>();
const webFailures = new Map<string, string>();
const webLoaded = new Set<string>();

// Reads go through atoms derived from the version, so React Compiler cannot cache a stale lookup.
const versionAtom = Atom.make(0).pipe(Atom.keepAlive);

const bump = () => appAtomRegistry.set(versionAtom, appAtomRegistry.get(versionAtom) + 1);

/**
 * Hands back the previous list while it holds the same entries, so a registry change that
 * doesn't touch a reader's list doesn't re-render the component that reads it.
 */
const stableList = <Entry>() => {
  let previous: ReadonlyArray<Entry> = [];
  return (next: ReadonlyArray<Entry>) => {
    if (next.length === previous.length && next.every((entry, i) => entry === previous[i])) {
      return previous;
    }
    previous = next;
    return next;
  };
};

export const pluginContributionKey = (environmentId: EnvironmentId, pluginId: string) =>
  `${environmentId}\u0000${pluginId}`;
export const pluginRightPanelKey = (environmentId: EnvironmentId, pluginId: string, name: string) =>
  `${pluginContributionKey(environmentId, pluginId)}\u0000${name}`;

/** Adds a plugin right panel; returns the function that removes it. */
export function registerPluginRightPanel(entry: PluginRightPanelEntry): () => void {
  const key = pluginRightPanelKey(entry.environmentId, entry.pluginId, entry.name);
  if (rightPanels.has(key)) {
    throw new Error(`Right panel "${entry.name}" is already registered.`);
  }
  rightPanels.set(key, entry);
  bump();
  return () => {
    if (rightPanels.get(key) !== entry) return;
    rightPanels.delete(key);
    bump();
  };
}

export const pluginRightPanelAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    get(versionAtom);
    return rightPanels.get(key);
  }),
);

export const pluginRightPanelsAtom = Atom.family((environmentId: string) => {
  const stable = stableList<PluginRightPanelEntry>();
  return Atom.make((get) => {
    get(versionAtom);
    return stable(
      [...rightPanels.values()].filter((entry) => entry.environmentId === environmentId),
    );
  });
});

/** Records why a plugin's web bundle did not load; `undefined` clears it. */
export function setPluginWebFailure(
  environmentId: EnvironmentId,
  pluginId: string,
  message: string | undefined,
) {
  const key = pluginContributionKey(environmentId, pluginId);
  if (webFailures.get(key) === message) return;
  if (message === undefined) webFailures.delete(key);
  else webFailures.set(key, message);
  bump();
}

/** Why the plugin's web part failed, by environment, for its row in Settings. */
export const pluginWebFailuresAtom = Atom.family((pluginId: string) =>
  Atom.make((get): ReadonlyMap<string, string> => {
    get(versionAtom);
    const suffix = `\u0000${pluginId}`;
    return new Map(
      [...webFailures].flatMap(([key, message]) =>
        key.endsWith(suffix) ? [[key.slice(0, -suffix.length), message] as const] : [],
      ),
    );
  }),
);

/** Records that a plugin's web part finished `activate`; returns the function that clears it. */
export function markPluginWebLoaded(environmentId: EnvironmentId, pluginId: string): () => void {
  const key = pluginContributionKey(environmentId, pluginId);
  webLoaded.add(key);
  bump();
  return () => {
    if (webLoaded.delete(key)) bump();
  };
}

/** Whether the plugin's web part has loaded, by `pluginContributionKey`. */
export const pluginWebLoadedAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    get(versionAtom);
    return webLoaded.has(key);
  }),
);

/** The plugin that registered a contribution, so its failures show on that plugin's row. */
export interface PluginOwner {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly pluginName: string;
}
