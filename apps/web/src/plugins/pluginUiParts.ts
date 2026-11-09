import { PluginPanelLauncherItems, PluginPanelMenuItems } from "./PluginPanelMenuItems";
import {
  pluginCommandLabel,
  pluginCommandsAtom,
  pluginComposerCollapseOnScrollAtom,
  pluginPartReplacedAtoms,
} from "./pluginRegistry";
import { PluginReplaceable } from "./PluginReplaceable";

/** What app code reaches through `pluginUiAtom` once the plugin loader publishes it. */
export const pluginUi = {
  PluginPanelLauncherItems,
  PluginPanelMenuItems,
  pluginCommandLabel,
  pluginCommandsAtom,
  pluginComposerCollapseOnScrollAtom,
  pluginPartReplacedAtoms,
  PluginReplaceable,
};

export type PluginUi = typeof pluginUi;
