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
import { Atom } from "effect/reactivity";
import type { ComponentType } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { PLUGIN_CONTEXT_KIND } from "./pluginUi";

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

export interface PluginSlashCommandEntry {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly name: string;
  readonly description: string;
  readonly run: (context: { readonly threadId: string | null }) => void;
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

// Plain maps with one list-level version: chat code reads them on render and re-renders on the
// version alone, so a plugin never adds a subscription per row or per panel. App code outside the
// plugin runtime and lazy routes reads them through `pluginUi.ts`, so this stays out of startup.
const rightPanels = new Map<string, PluginRightPanelEntry>();
const settingsPanels = new Map<string, PluginSettingsPanelEntry>();
const webFailures = new Map<string, string>();
const commands = new Map<string, PluginCommandEntry>();
// Each name keeps every plugin that claims it; see `firstById`.
const slashCommands = new Map<string, Array<PluginSlashCommandEntry>>();
const banners = new Map<string, PluginBannerEntry>();

// Reads go through atoms derived from the version, so React Compiler cannot cache a stale lookup.
const versionAtom = Atom.make(0).pipe(Atom.keepAlive);

const bump = () => appAtomRegistry.set(versionAtom, appAtomRegistry.get(versionAtom) + 1);

/**
 * Hands back the previous list while it holds the same entries, so a registry change that
 * doesn't touch a reader's list doesn't re-render the composer that reads it.
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

/**
 * When plugins claim the same slash command or code block language, the one whose id sorts first
 * gets it whatever order they started in; the others go without.
 */
const firstById = <Claim>(claims: ReadonlyArray<Claim>, pluginIdOf: (claim: Claim) => string) =>
  claims.reduce((first, claim) => (pluginIdOf(claim) < pluginIdOf(first) ? claim : first));

// Adds `claim` under `key`; returns the function that removes it again. One plugin claiming the
// same key twice is a mistake in that plugin, so it throws.
const addClaim = <Claim>(
  claims: Map<string, Array<Claim>>,
  key: string,
  claim: Claim,
  pluginIdOf: (claim: Claim) => string,
  claimed: string,
) => {
  const list = claims.get(key) ?? [];
  if (list.some((other) => pluginIdOf(other) === pluginIdOf(claim))) {
    throw new TypeError(`This plugin already registered ${claimed}.`);
  }
  list.push(claim);
  claims.set(key, list);
  return () => {
    const index = list.indexOf(claim);
    if (index === -1) return;
    list.splice(index, 1);
    if (list.length === 0) claims.delete(key);
  };
};

/** Adds a plugin command to the composer's `/` menu; returns the function that removes it. */
export function registerPluginSlashCommand(entry: PluginSlashCommandEntry): () => void {
  const remove = addClaim(
    slashCommands,
    `${entry.environmentId}\u0000${entry.name}`,
    entry,
    (claim) => claim.pluginId,
    `the slash command /${entry.name}`,
  );
  bump();
  return () => {
    remove();
    bump();
  };
}

export const pluginSlashCommandsAtom = Atom.family((environmentId: string) => {
  const stable = stableList<PluginSlashCommandEntry>();
  return Atom.make((get) => {
    get(versionAtom);
    return stable(
      [...slashCommands.values()]
        .map((claims) => firstById(claims, (claim) => claim.pluginId))
        .filter((entry) => entry.environmentId === environmentId),
    );
  });
});

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

export const pluginBannersAtom = Atom.family((environmentId: string) => {
  const stable = stableList<PluginBannerEntry>();
  return Atom.make((get) => {
    get(versionAtom);
    return stable([...banners.values()].filter((entry) => entry.environmentId === environmentId));
  });
});

export interface PluginCodeBlockEntry {
  readonly component: ComponentType<{ readonly code: string }>;
  readonly owner: PluginOwner;
}

// Its own atom rather than the shared version: every chat code block reads it, so it changes only
// when a code block renderer does.
export const pluginCodeBlockRenderersAtom = Atom.make<ReadonlyMap<string, PluginCodeBlockEntry>>(
  new Map(),
).pipe(Atom.keepAlive);

const codeBlockClaims = new Map<string, Array<PluginCodeBlockEntry>>();
const publishCodeBlocks = () =>
  appAtomRegistry.set(
    pluginCodeBlockRenderersAtom,
    new Map(
      Array.from(codeBlockClaims, ([language, claims]) => [
        language,
        firstById(claims, (claim) => claim.owner.pluginId),
      ]),
    ),
  );

/** Draws fenced code of `language` in chat messages; returns the function that removes it. */
export function registerPluginCodeBlock(language: string, entry: PluginCodeBlockEntry): () => void {
  const remove = addClaim(
    codeBlockClaims,
    language,
    entry,
    (claim) => claim.owner.pluginId,
    `code blocks in ${language}`,
  );
  publishCodeBlocks();
  return () => {
    remove();
    publishCodeBlocks();
  };
}

/** The plugin that registered a contribution, so its failures show on that plugin's row. */
export interface PluginOwner {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly pluginName: string;
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
  readonly owner: PluginOwner;
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
  Atom.family((environmentId: EnvironmentId) => {
    const stable = stableList<PluginActionEntry<Place>>();
    return Atom.make((get) => {
      get(actionsVersionAtom);
      return stable(readPluginActions(place, environmentId));
    });
  });

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
  const existing = current.find((entry) => entry.pluginId === pluginId);
  // A plugin that refreshes the same badge on a timer must not re-render the row each time.
  if (
    badge === null
      ? existing === undefined
      : existing?.label === badge.label && existing.tone === badge.tone
  ) {
    return;
  }
  const next =
    badge === null
      ? current.filter((entry) => entry.pluginId !== pluginId)
      : existing === undefined
        ? [...current, { pluginId, ...badge }]
        : current.map((entry) => (entry === existing ? { pluginId, ...badge } : entry));
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
    // A plugin that offers the same items again leaves the composer alone.
    const current = mentionItems.get(key);
    if (
      current?.length === items.length &&
      current.every((item, i) => {
        const next = items[i]!;
        return (
          item.key === next.key &&
          item.label === next.label &&
          item.description === next.description &&
          item.text === next.text
        );
      })
    ) {
      return;
    }
    mentionItems.set(key, items);
  }
  appAtomRegistry.set(mentionItemsVersionAtom, appAtomRegistry.get(mentionItemsVersionAtom) + 1);
}

export const pluginMentionItemsAtom = Atom.family((environmentId: string) => {
  const stable = stableList<PluginMentionItem>();
  return Atom.make((get) => {
    get(mentionItemsVersionAtom);
    return stable(
      [...mentionItems.entries()]
        .filter(([key]) => key.startsWith(`${environmentId}\u0000`))
        .flatMap(([, items]) => items),
    );
  });
});

const MENTION_TEXT_MAX_CHARS = 30_000;
// A chip's record holds at most 64,000 characters of JSON, and the rest of it is short.
const MENTION_TEXT_MAX_JSON_CHARS = 60_000;

/** Cuts an `@` item's text to fit its chip's record, where escapes such as ANSI codes grow. */
export function capPluginMentionText(text: string): string {
  let capped = text.slice(0, MENTION_TEXT_MAX_CHARS);
  // No character takes more than 6 when escaped, so most text needs no measuring.
  if (capped.length * 6 + 2 <= MENTION_TEXT_MAX_JSON_CHARS) return capped;
  for (let encoded = JSON.stringify(capped).length; encoded > MENTION_TEXT_MAX_JSON_CHARS;) {
    capped = capped.slice(
      0,
      Math.floor((capped.length * MENTION_TEXT_MAX_JSON_CHARS) / encoded) - 1,
    );
    encoded = JSON.stringify(capped).length;
  }
  return capped;
}

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
 * A plugin chip as text, for an answer to an agent's question, which carries no context records.
 * Undefined once the item is gone.
 */
export function pluginMentionAnswerText(contextId: string, label: string): string | undefined {
  const item = findPluginMentionItem(contextId);
  return item === undefined ? undefined : `${label} (from ${item.pluginName}):\n\n${item.text}\n\n`;
}

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
