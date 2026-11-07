import type { EnvironmentId, PLUGIN_COMMAND_PATTERN } from "@t3tools/contracts";
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

export interface PluginCommandEntry {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly command: typeof PLUGIN_COMMAND_PATTERN.Type;
  readonly title: string;
  readonly keywords: ReadonlyArray<string>;
  readonly run: () => void;
}

// Plain maps with one list-level version: chat code reads them on render and re-renders on the
// version alone, so a plugin never adds a subscription per row or per panel. App code outside the
// plugin runtime and lazy routes reads them through `pluginUi.ts`, so this stays out of startup.
const rightPanels = new Map<string, PluginRightPanelEntry>();
const settingsPanels = new Map<string, PluginSettingsPanelEntry>();
const webFailures = new Map<string, string>();
const commands = new Map<string, PluginCommandEntry>();

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

export interface PluginSettingsPanelEntry {
  readonly component: ComponentType;
  readonly owner: PluginOwner;
}

/** Replaces a plugin's generated settings form; returns the function that removes it. */
export function registerPluginSettingsPanel(entry: PluginSettingsPanelEntry): () => void {
  const key = pluginContributionKey(entry.owner.environmentId, entry.owner.pluginId);
  settingsPanels.set(key, entry);
  bump();
  return () => {
    if (settingsPanels.get(key) !== entry) return;
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

/** Adds a plugin command to the command palette; returns the function that removes it. */
export function registerPluginCommand(entry: PluginCommandEntry): () => void {
  const key = `${entry.environmentId}\u0000${entry.command}`;
  if (commands.has(key)) {
    throw new Error(`Command "${entry.command}" is already registered.`);
  }
  commands.set(key, entry);
  bump();
  return () => {
    if (commands.get(key) !== entry) return;
    commands.delete(key);
    bump();
  };
}

/** A loaded plugin command's name for people, such as in Keybindings settings. */
export function pluginCommandLabel(command: string): string | undefined {
  for (const entry of commands.values()) {
    if (entry.command === command) return `${entry.pluginName}: ${entry.title}`;
  }
  return undefined;
}

export const pluginCommandsAtom = Atom.family((environmentId: string) => {
  const stable = stableList<PluginCommandEntry>();
  return Atom.make((get) => {
    get(versionAtom);
    return stable([...commands.values()].filter((entry) => entry.environmentId === environmentId));
  });
});

/** The plugin that registered a contribution, so its failures show on that plugin's row. */
export interface PluginOwner {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly pluginName: string;
}

export interface PluginPageEntry {
  readonly title: string;
  readonly component: ComponentType;
  readonly owner: PluginOwner;
}

// Keyed by plugin id and page name; a stack, so the same plugin loaded from two environments
// keeps a page when one of them unloads.
const pages = new Map<string, Array<PluginPageEntry>>();

export const pluginPageKey = (pluginId: string, name: string) => `${pluginId}\u0000${name}`;

/** Adds a plugin page; returns the function that removes it. */
export function registerPluginPage(key: string, entry: PluginPageEntry): () => void {
  const list = pages.get(key) ?? [];
  list.push(entry);
  pages.set(key, list);
  bump();
  return () => {
    const index = list.indexOf(entry);
    if (index === -1) return;
    list.splice(index, 1);
    if (list.length === 0) pages.delete(key);
    bump();
  };
}

export const pluginPageAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    get(versionAtom);
    return pages.get(key)?.at(-1);
  }),
);

export interface PluginSidebarSectionEntry {
  readonly key: string;
  readonly title: string;
  readonly component: ComponentType;
  readonly owner: PluginOwner;
}

const sidebarSections = new Map<string, PluginSidebarSectionEntry>();

/** Adds a sidebar section; returns the function that removes it. */
export function registerPluginSidebarSection(entry: PluginSidebarSectionEntry): () => void {
  if (sidebarSections.has(entry.key)) {
    throw new Error(`Sidebar section "${entry.key}" is already registered.`);
  }
  sidebarSections.set(entry.key, entry);
  bump();
  return () => {
    if (sidebarSections.get(entry.key) !== entry) return;
    sidebarSections.delete(entry.key);
    bump();
  };
}

const stableSidebarSections = stableList<PluginSidebarSectionEntry>();
export const pluginSidebarSectionsAtom = Atom.make((get) => {
  get(versionAtom);
  return stableSidebarSections([...sidebarSections.values()]);
});
