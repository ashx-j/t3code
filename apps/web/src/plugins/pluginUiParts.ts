import { PluginPanelLauncherItems, PluginPanelMenuItems } from "./PluginPanelMenuItems";
import { pluginCommandLabel, pluginCommandsAtom } from "./pluginRegistry";
import { PluginSidebarSections } from "./PluginSidebarSections";

/** What app code reaches through `pluginUiAtom` once the plugin loader publishes it. */
export const pluginUi = {
  PluginPanelLauncherItems,
  PluginPanelMenuItems,
  PluginSidebarSections,
  pluginCommandLabel,
  pluginCommandsAtom,
};

export type PluginUi = typeof pluginUi;
