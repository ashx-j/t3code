import type {
  ComposerContextId,
  ContextMenuItem,
  EnvironmentId,
  PLUGIN_COMMAND_PATTERN,
  UnknownContextRecord,
} from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import type { WebPluginParts } from "@t3tools/plugin-sdk/web";
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

// Plugin contribution keys; the composer folds on scroll while any plugin asks for it.
const collapseOnScrollRequests = new Set<string>();

/** Turns one plugin's request to fold the composer when the timeline scrolls up on or off. */
export function setPluginComposerCollapseOnScroll(key: string, enabled: boolean) {
  if (collapseOnScrollRequests.has(key) === enabled) return;
  if (enabled) collapseOnScrollRequests.add(key);
  else collapseOnScrollRequests.delete(key);
  bump();
}

export const pluginComposerCollapseOnScrollAtom = Atom.make((get) => {
  get(versionAtom);
  return collapseOnScrollRequests.size > 0;
});

/**
 * The `plg_<pluginId>_<tool>` name inside a reported tool name: Codex reports it bare, Claude as
 * `mcp__<server>__plg_…` and ACP agents as `<server>.plg_…`. Undefined for other tools.
 */
export const pluginToolNameOf = (toolName: string | null | undefined) =>
  toolName?.match(/(?:^|__|\.)(plg_[a-z][a-z0-9-]*_[A-Za-z0-9_-]+)$/)?.[1];

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

export type PluginPartName = keyof WebPluginParts;

/** A replaceable part's pieces. `original` is T3's own drawing, also drawn when the plugin's throws. */
export type PluginPartProps<Part extends PluginPartName> = WebPluginParts[Part];

/** The plugin that registered a contribution, so its failures show on that plugin's row. */
export interface PluginOwner {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
}

export interface PluginReplacementEntry<Part extends PluginPartName> extends PluginOwner {
  readonly component: ComponentType<PluginPartProps<Part>>;
}

// Each part keeps every replacement, so unloading the newest brings back the one before it.
const replacements: { [Part in PluginPartName]: Array<PluginReplacementEntry<Part>> } = {
  "composer.controls": [],
  "message.assistant": [],
  "message.user": [],
  "timeline.item": [],
  "diff.view": [],
  "app.pageFrame": [],
  "app.sidebar": [],
};

// Its own version: replaceable parts sit on hot paths, so other plugin changes must not
// re-render them.
const replacementsVersionAtom = Atom.make(0).pipe(Atom.keepAlive);

const replacementAtom = <Part extends PluginPartName>(part: Part) =>
  Atom.make((get) => {
    get(replacementsVersionAtom);
    return replacements[part].at(-1);
  });

export const pluginReplacementAtoms: {
  readonly [Part in PluginPartName]: Atom.Atom<PluginReplacementEntry<Part> | undefined>;
} = {
  "composer.controls": replacementAtom("composer.controls"),
  "message.assistant": replacementAtom("message.assistant"),
  "message.user": replacementAtom("message.user"),
  "timeline.item": replacementAtom("timeline.item"),
  "diff.view": replacementAtom("diff.view"),
  "app.pageFrame": replacementAtom("app.pageFrame"),
  "app.sidebar": replacementAtom("app.sidebar"),
};

/** Draws `part` with a plugin's component; returns the function that removes it. */
export function registerPluginReplacement<Part extends PluginPartName>(
  part: Part,
  component: ComponentType<PluginPartProps<Part>>,
  owner: PluginOwner,
): () => void {
  if (!Object.hasOwn(replacements, part)) {
    throw new TypeError(`"${part}" is not a part plugins can replace.`);
  }
  const list = replacements[part];
  const entry = { component, ...owner };
  list.push(entry);
  appAtomRegistry.set(replacementsVersionAtom, appAtomRegistry.get(replacementsVersionAtom) + 1);
  return () => {
    const index = list.indexOf(entry);
    if (index === -1) return;
    list.splice(index, 1);
    appAtomRegistry.set(replacementsVersionAtom, appAtomRegistry.get(replacementsVersionAtom) + 1);
  };
}

/** Where a plugin action shows, and what its `run` receives there. */
export interface PluginActionContexts {
  readonly threadMenu: { readonly threadId: string };
  readonly threadHeader: { readonly threadId: string };
  readonly message: {
    readonly threadId: string;
    readonly messageId: string;
    readonly role: "user" | "assistant";
    readonly text: string;
  };
  readonly composer: { readonly threadId: string | null };
}

export type PluginActionPlace = keyof PluginActionContexts;

export interface PluginActionEntry<Place extends PluginActionPlace> {
  /** Unique per environment and place. */
  readonly key: `plugin:${string}`;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly icon: ComponentType | undefined;
  readonly run: (context: PluginActionContexts[Place]) => void;
}

const actions: { [Place in PluginActionPlace]: Map<string, PluginActionEntry<Place>> } = {
  threadMenu: new Map(),
  threadHeader: new Map(),
  message: new Map(),
  composer: new Map(),
};

// Message actions render in every timeline row, so actions keep their own version.
const actionsVersionAtom = Atom.make(0).pipe(Atom.keepAlive);
const bumpActions = () =>
  appAtomRegistry.set(actionsVersionAtom, appAtomRegistry.get(actionsVersionAtom) + 1);

/** Adds a plugin button or menu item; returns the function that removes it. */
export function registerPluginAction<Place extends PluginActionPlace>(
  place: Place,
  entry: PluginActionEntry<Place>,
): () => void {
  const list = actions[place];
  const key = `${entry.environmentId}\u0000${entry.key}`;
  if (list.has(key)) throw new Error(`"${entry.key}" is already registered.`);
  list.set(key, entry);
  bumpActions();
  return () => {
    if (list.get(key) !== entry) return;
    list.delete(key);
    bumpActions();
  };
}

/** The environment's plugin actions for `place`, for code that runs outside render. */
const readPluginActions = <Place extends PluginActionPlace>(
  place: Place,
  environmentId: EnvironmentId,
): ReadonlyArray<PluginActionEntry<Place>> =>
  [...actions[place].values()].filter((entry) => entry.environmentId === environmentId);

const actionsAtom = <Place extends PluginActionPlace>(place: Place) =>
  Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      get(actionsVersionAtom);
      return readPluginActions(place, environmentId);
    }),
  );

export const pluginActionAtoms: {
  readonly [Place in PluginActionPlace]: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<PluginActionEntry<Place>>>;
} = {
  threadMenu: actionsAtom("threadMenu"),
  threadHeader: actionsAtom("threadHeader"),
  message: actionsAtom("message"),
  composer: actionsAtom("composer"),
};

/** Appends the environment's plugin items to a thread menu, after a separator. */
export function withPluginThreadMenuItems<Id extends string>(
  items: ReadonlyArray<ContextMenuItem<Id>>,
  environmentId: EnvironmentId,
): ReadonlyArray<ContextMenuItem<Id | `plugin:${string}`>> {
  const pluginItems = readPluginActions("threadMenu", environmentId);
  if (pluginItems.length === 0) return items;
  return [
    ...items,
    ...pluginItems.map((entry, index) => ({
      id: entry.key,
      label: entry.title,
      separatorBefore: index === 0,
    })),
  ];
}

/** Runs the plugin item a thread menu returned; false when `menuId` is not a plugin item. */
export function runPluginThreadMenuItem(
  menuId: string,
  environmentId: EnvironmentId,
  threadId: string,
): boolean {
  if (!menuId.startsWith("plugin:")) return false;
  actions.threadMenu.get(`${environmentId}\u0000${menuId}`)?.run({ threadId });
  return true;
}

export interface PluginThreadBadge {
  readonly pluginId: string;
  readonly label: string;
  readonly tone: "info" | "success" | "warning" | "error";
}

const EMPTY_BADGES: ReadonlyArray<PluginThreadBadge> = [];
// Keyed by scoped thread key. A thread's array is replaced only when its own badges change, so
// sidebar rows of other threads keep the same value and do not re-render.
const threadBadges = new Map<string, ReadonlyArray<PluginThreadBadge>>();
const threadBadgesVersionAtom = Atom.make(0).pipe(Atom.keepAlive);

/** Sets or, with `null`, removes a plugin's badge on a thread. */
export function setPluginThreadBadge(
  threadKey: string,
  pluginId: string,
  badge: Omit<PluginThreadBadge, "pluginId"> | null,
) {
  const current = threadBadges.get(threadKey) ?? EMPTY_BADGES;
  const others = current.filter((entry) => entry.pluginId !== pluginId);
  const next = badge === null ? others : [...others, { pluginId, ...badge }];
  if (next.length === 0) threadBadges.delete(threadKey);
  else threadBadges.set(threadKey, next);
  appAtomRegistry.set(threadBadgesVersionAtom, appAtomRegistry.get(threadBadgesVersionAtom) + 1);
}

export const pluginThreadBadgesAtom = Atom.family((threadKey: string) =>
  Atom.make((get) => {
    get(threadBadgesVersionAtom);
    return threadBadges.get(threadKey) ?? EMPTY_BADGES;
  }),
);

export interface PluginPageEntry {
  readonly title: string;
  readonly component: ComponentType;
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

export const pluginSidebarSectionsAtom = Atom.make((get) => {
  get(versionAtom);
  return [...sidebarSections.values()];
});

export interface PluginMentionItem {
  readonly key: string;
  /** Picking the item inserts a chip that refers to it by this id. */
  readonly contextId: ComposerContextId;
  readonly pluginName: string;
  readonly label: string;
  readonly description: string;
  readonly text: string;
}

// Keyed by environment and plugin; each plugin replaces its whole list at once. The list has its
// own version, since plugins update it often and the composer reads it.
const mentionItems = new Map<string, ReadonlyArray<PluginMentionItem>>();
const mentionItemsVersionAtom = Atom.make(0).pipe(Atom.keepAlive);

/** Replaces a plugin's items in the composer's `@` menu; an empty list removes them. */
export function setPluginMentionItems(
  environmentId: EnvironmentId,
  pluginId: string,
  items: ReadonlyArray<PluginMentionItem>,
) {
  const key = pluginContributionKey(environmentId, pluginId);
  if (items.length === 0) {
    if (!mentionItems.delete(key)) return;
  } else {
    mentionItems.set(key, items);
  }
  appAtomRegistry.set(mentionItemsVersionAtom, appAtomRegistry.get(mentionItemsVersionAtom) + 1);
}

export const pluginMentionItemsAtom = Atom.family((environmentId: string) =>
  Atom.make((get) => {
    get(mentionItemsVersionAtom);
    return [...mentionItems.entries()]
      .filter(([key]) => key.startsWith(`${environmentId}\u0000`))
      .flatMap(([, items]) => items);
  }),
);

/** The context kind of a plugin `@` item's chip. Clients without plugins treat it as unknown. */
export const PLUGIN_CONTEXT_KIND = "plugin";

export const pluginMentionContextId = (
  environmentId: EnvironmentId,
  pluginId: string,
  itemId: string,
): ComposerContextId =>
  toKindScopedComposerContextId(PLUGIN_CONTEXT_KIND, `${environmentId}:${pluginId}:${itemId}`);

function findPluginMentionItem(contextId: string): PluginMentionItem | undefined {
  for (const items of mentionItems.values()) {
    const item = items.find((candidate) => candidate.contextId === contextId);
    if (item !== undefined) return item;
  }
  return undefined;
}

/** The item a chip refers to, or undefined once its plugin removed it or unloaded. */
export const pluginMentionItemAtom = Atom.family((contextId: string) =>
  Atom.make((get) => {
    get(mentionItemsVersionAtom);
    return findPluginMentionItem(contextId);
  }),
);

/**
 * Records for the plugin chips in a message, read when it is sent so the agent gets each item's
 * current text. A chip whose item is gone has no record and reaches the agent as unavailable.
 */
export function pluginMentionContextRecords(prompt: string): UnknownContextRecord[] {
  if (mentionItems.size === 0) return [];
  const records = new Map<string, UnknownContextRecord>();
  for (const reference of collectComposerContextReferences(prompt)) {
    if (reference.kind !== PLUGIN_CONTEXT_KIND || records.has(reference.contextId)) continue;
    const item = findPluginMentionItem(reference.contextId);
    if (item === undefined) continue;
    records.set(reference.contextId, {
      version: 1,
      kind: PLUGIN_CONTEXT_KIND,
      contextId: item.contextId,
      label: reference.label,
      payload: { plugin: item.pluginName, text: item.text },
    });
  }
  return [...records.values()];
}
