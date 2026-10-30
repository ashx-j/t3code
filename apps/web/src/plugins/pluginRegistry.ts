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

export interface PluginSlashCommandEntry {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly name: string;
  readonly description: string;
  readonly run: (context: { readonly threadId: string }) => void;
}

export interface PluginBannerEntry {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly variant: "info" | "success" | "warning" | "error";
  readonly title: string;
  readonly description?: string;
  readonly dismiss: () => void;
}

export interface PluginToolRendererEntry {
  readonly environmentId: EnvironmentId;
  /** The MCP tool name agents see: `plg_<pluginId>_<tool>`. */
  readonly toolName: string;
  readonly component: ComponentType<PluginToolRendererProps>;
}

export interface PluginToolRendererProps {
  readonly input: unknown;
  readonly output: string | null;
  readonly status: string;
}

// Plain maps with one list-level version: chat code reads them on render and re-renders on the
// version alone, so a plugin never adds a subscription per row or per panel.
const rightPanels = new Map<string, PluginRightPanelEntry>();
const settingsPanels = new Map<string, ComponentType>();
const webFailures = new Map<string, string>();
const commands = new Map<string, PluginCommandEntry>();
const slashCommands = new Map<string, PluginSlashCommandEntry>();
const banners = new Map<string, PluginBannerEntry>();
const toolRenderers = new Map<string, PluginToolRendererEntry>();

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

export const pluginCommandsAtom = Atom.family((environmentId: string) =>
  Atom.make((get) => {
    get(versionAtom);
    return [...commands.values()].filter((entry) => entry.environmentId === environmentId);
  }),
);

/** Adds a plugin command to the composer's `/` menu; returns the function that removes it. */
export function registerPluginSlashCommand(entry: PluginSlashCommandEntry): () => void {
  const key = `${entry.environmentId}\u0000${entry.name}`;
  if (slashCommands.has(key)) {
    throw new Error(`Slash command "/${entry.name}" is already registered.`);
  }
  slashCommands.set(key, entry);
  bump();
  return () => {
    if (slashCommands.get(key) !== entry) return;
    slashCommands.delete(key);
    bump();
  };
}

export const pluginSlashCommandsAtom = Atom.family((environmentId: string) =>
  Atom.make((get) => {
    get(versionAtom);
    return [...slashCommands.values()].filter((entry) => entry.environmentId === environmentId);
  }),
);

/** Shows a banner above the composer; returns the function that removes it. */
export function registerPluginBanner(entry: PluginBannerEntry): () => void {
  const key = `${entry.environmentId}\u0000${entry.key}`;
  banners.set(key, entry);
  bump();
  return () => {
    if (banners.get(key) !== entry) return;
    banners.delete(key);
    bump();
  };
}

export const pluginBannersAtom = Atom.family((environmentId: string) =>
  Atom.make((get) => {
    get(versionAtom);
    return [...banners.values()].filter((entry) => entry.environmentId === environmentId);
  }),
);

export const pluginToolRendererKey = (environmentId: EnvironmentId, toolName: string) =>
  `${environmentId}\u0000${toolName}`;

/** Draws a plugin MCP tool's calls in the timeline; returns the function that removes it. */
export function registerPluginToolRenderer(entry: PluginToolRendererEntry): () => void {
  const key = pluginToolRendererKey(entry.environmentId, entry.toolName);
  if (toolRenderers.has(key)) {
    throw new Error(`A renderer for "${entry.toolName}" is already registered.`);
  }
  toolRenderers.set(key, entry);
  bump();
  return () => {
    if (toolRenderers.get(key) !== entry) return;
    toolRenderers.delete(key);
    bump();
  };
}

export const pluginToolRendererAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    get(versionAtom);
    return toolRenderers.get(key);
  }),
);

export type PluginCodeBlockComponent = ComponentType<{ readonly code: string }>;

// Its own atom rather than the shared version: every chat code block reads it, so it changes only
// when a code block renderer does.
export const pluginCodeBlockRenderersAtom = Atom.make<
  ReadonlyMap<string, PluginCodeBlockComponent>
>(new Map()).pipe(Atom.keepAlive);

/** Draws fenced code of `language` in chat messages; returns the function that removes it. */
export function registerPluginCodeBlock(
  language: string,
  component: PluginCodeBlockComponent,
): () => void {
  const current = appAtomRegistry.get(pluginCodeBlockRenderersAtom);
  if (current.has(language)) {
    throw new Error(`A renderer for \`${language}\` code blocks is already registered.`);
  }
  appAtomRegistry.set(pluginCodeBlockRenderersAtom, new Map(current).set(language, component));
  return () => {
    const latest = appAtomRegistry.get(pluginCodeBlockRenderersAtom);
    if (latest.get(language) !== component) return;
    const next = new Map(latest);
    next.delete(language);
    appAtomRegistry.set(pluginCodeBlockRenderersAtom, next);
  };
}
