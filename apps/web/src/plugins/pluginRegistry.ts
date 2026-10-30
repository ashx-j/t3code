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
}

// Plain maps with one list-level version: chat code reads them on render and re-renders on the
// version alone, so a plugin never adds a subscription per row or per panel.
const rightPanels = new Map<string, PluginRightPanelEntry>();
const settingsPanels = new Map<string, ComponentType>();
const webFailures = new Map<string, string>();

// Reads go through atoms derived from the version, so React Compiler cannot cache a stale lookup.
const versionAtom = Atom.make(0).pipe(Atom.keepAlive);

const bump = () => appAtomRegistry.set(versionAtom, appAtomRegistry.get(versionAtom) + 1);

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

export const pluginRightPanelsAtom = Atom.family((environmentId: string) =>
  Atom.make((get) => {
    get(versionAtom);
    return [...rightPanels.values()].filter((entry) => entry.environmentId === environmentId);
  }),
);

/** Replaces a plugin's generated settings form; returns the function that removes it. */
export function registerPluginSettingsPanel(
  environmentId: EnvironmentId,
  pluginId: string,
  component: ComponentType,
): () => void {
  const key = pluginContributionKey(environmentId, pluginId);
  settingsPanels.set(key, component);
  bump();
  return () => {
    if (settingsPanels.get(key) !== component) return;
    settingsPanels.delete(key);
    bump();
  };
}

export const pluginSettingsPanelAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    get(versionAtom);
    return settingsPanels.get(key);
  }),
);

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

export const pluginWebFailureAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    get(versionAtom);
    return webFailures.get(key);
  }),
);
