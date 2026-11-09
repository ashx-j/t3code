import { PluginPanelLauncherItems, PluginPanelMenuItems } from "./PluginPanelMenuItems";

/** What app code reaches through `pluginUiAtom` once the plugin loader publishes it. */
export const pluginUi = {
  PluginPanelLauncherItems,
  PluginPanelMenuItems,
};

export type PluginUi = typeof pluginUi;
