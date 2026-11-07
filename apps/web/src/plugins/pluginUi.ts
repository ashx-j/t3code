import type {
  ContextMenuItem,
  EnvironmentId,
  LocalApi,
  UnknownContextRecord,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import type { PluginUi } from "./pluginUiParts";

/**
 * The plugin UI code, which the plugin loader publishes once a plugin with a web part is active.
 * App code reaches plugin contributions only through this, so until then it downloads none of
 * that code and reads no plugin registry.
 */
export const pluginUiAtom = Atom.make<PluginUi | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-plugin-ui"),
);

const loadedPluginUi = () => appAtomRegistry.get(pluginUiAtom);

const NONE: ReadonlyArray<never> = [];

// Each atom below reads its namesake in `pluginRegistry` once plugin UI has loaded.
const fromPluginUi = <A>(pick: (ui: PluginUi) => Atom.Atom<A>, none: A) =>
  Atom.make((get) => {
    const ui = get(pluginUiAtom);
    return ui === null ? none : get(pick(ui));
  });

export const pluginSlashCommandsAtom = Atom.family((environmentId: string) =>
  fromPluginUi((ui) => ui.pluginSlashCommandsAtom(environmentId), NONE),
);

export const pluginMentionItemsAtom = Atom.family((environmentId: string) =>
  fromPluginUi((ui) => ui.pluginMentionItemsAtom(environmentId), NONE),
);

export const pluginMentionItemAtom = Atom.family((contextId: string) =>
  fromPluginUi((ui) => ui.pluginMentionItemAtom(contextId), undefined),
);

export const pluginBannersAtom = Atom.family((environmentId: string) =>
  fromPluginUi((ui) => ui.pluginBannersAtom(environmentId), NONE),
);

export const pluginCommandsAtom = Atom.family((environmentId: string) =>
  fromPluginUi((ui) => ui.pluginCommandsAtom(environmentId), NONE),
);

/** The context kind of a plugin `@` item's chip. Clients without plugins treat it as unknown. */
export const PLUGIN_CONTEXT_KIND = "plugin";

/** Records for the plugin chips in a message; see `pluginRegistry`. */
export const pluginMentionContextRecords = (prompt: string): UnknownContextRecord[] =>
  loadedPluginUi()?.pluginMentionContextRecords(prompt) ?? [];

/** A plugin chip as text for an answer to an agent's question; undefined once its item is gone. */
export const pluginMentionAnswerText = (contextId: string, label: string) =>
  loadedPluginUi()?.pluginMentionAnswerText(contextId, label);

/** A loaded plugin command's name for people, such as in Keybindings settings. */
export const pluginCommandLabel = (command: string) =>
  loadedPluginUi()?.pluginCommandLabel(command);

/** `api.contextMenu.show` for a thread menu, with the environment's plugin items after T3's own. */
export function showThreadMenu<Id extends string>(
  api: Pick<LocalApi, "contextMenu">,
  items: ReadonlyArray<ContextMenuItem<Id>>,
  position: { readonly x: number; readonly y: number } | undefined,
  environmentId: EnvironmentId,
) {
  const withPlugins: ReadonlyArray<ContextMenuItem<Id | `plugin:${string}`>> =
    loadedPluginUi()?.withPluginThreadMenuItems(items, environmentId) ?? items;
  return api.contextMenu.show(withPlugins, position);
}

/** Runs the plugin item a thread menu returned; false when `menuId` is not a plugin item. */
export function runPluginThreadMenuItem(
  menuId: string,
  environmentId: EnvironmentId,
  threadId: string,
): boolean {
  if (!menuId.startsWith("plugin:")) return false;
  loadedPluginUi()?.runPluginThreadMenuItem(menuId, environmentId, threadId);
  return true;
}
