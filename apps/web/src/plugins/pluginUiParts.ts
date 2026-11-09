import { PluginPanelLauncherItems, PluginPanelMenuItems } from "./PluginPanelMenuItems";
import { pluginCommandLabel, pluginCommandsAtom } from "./pluginRegistry";

export const pluginUi = {
  PluginPanelLauncherItems,
  PluginPanelMenuItems,
  pluginCommandLabel,
  pluginCommandsAtom,
};

export type PluginUi = typeof pluginUi;
