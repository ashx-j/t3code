import { PluginActionButtons, PluginThreadBadges } from "./PluginActions";
import { PluginCodeBlock } from "./PluginCodeBlock";
import { PluginPanelLauncherItems, PluginPanelMenuItems } from "./PluginPanelMenuItems";
import {
  pluginBannersAtom,
  pluginCommandLabel,
  pluginCommandsAtom,
  pluginMentionAnswerText,
  pluginMentionContextRecords,
  pluginMentionItemAtom,
  pluginMentionItemsAtom,
  pluginSlashCommandsAtom,
  runPluginThreadMenuItem,
  withPluginThreadMenuItems,
} from "./pluginRegistry";
import { PluginReplaceable } from "./PluginReplaceable";
import { PluginSidebarSections } from "./PluginSidebarSections";
import { toPluginTimelineItem } from "./pluginTimelineItem";
import { PluginToolBody } from "./PluginToolBody";

/** What app code reaches through `pluginUiAtom` once the plugin loader publishes it. */
export const pluginUi = {
  PluginActionButtons,
  PluginCodeBlock,
  PluginPanelLauncherItems,
  PluginPanelMenuItems,
  PluginReplaceable,
  PluginSidebarSections,
  PluginThreadBadges,
  PluginToolBody,
  pluginBannersAtom,
  pluginCommandLabel,
  pluginCommandsAtom,
  pluginMentionAnswerText,
  pluginMentionContextRecords,
  pluginMentionItemAtom,
  pluginMentionItemsAtom,
  pluginSlashCommandsAtom,
  runPluginThreadMenuItem,
  toPluginTimelineItem,
  withPluginThreadMenuItems,
};

export type PluginUi = typeof pluginUi;
