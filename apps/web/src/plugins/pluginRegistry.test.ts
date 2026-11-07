import { EnvironmentId } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  capPluginMentionText,
  pluginMentionContextId,
  pluginMentionContextRecords,
  pluginActionAtoms,
  pluginMentionItemsAtom,
  pluginPageAtom,
  pluginSlashCommandsAtom,
  pluginPageKey,
  pluginThreadBadgesAtom,
  registerPluginAction,
  registerPluginBanner,
  registerPluginPage,
  setPluginMentionItems,
  runPluginThreadMenuItem,
  setPluginThreadBadge,
  withPluginThreadMenuItems,
} from "./pluginRegistry";
import { PLUGIN_CONTEXT_KIND } from "./pluginUi";

const environmentId = EnvironmentId.make("environment:plugin-menu");
const otherEnvironmentId = EnvironmentId.make("environment:other");
const owner = { environmentId, pluginId: "notes", pluginName: "Notes" };

describe("plugin thread menu items", () => {
  it("adds only the thread environment's items after a separator and runs the one picked", () => {
    const ran: Array<string> = [];
    const messageActions = appAtomRegistry.get(pluginActionAtoms.message(environmentId));
    using _item = {
      [Symbol.dispose]: registerPluginAction("threadMenu", {
        key: "plugin:flags:clear",
        environmentId,
        title: "Clear flag",
        icon: undefined,
        owner,
        run: (thread) => ran.push(thread.threadId),
      }),
    };
    const builtIn = [{ id: "rename" as const, label: "Rename thread" }];

    expect(withPluginThreadMenuItems(builtIn, environmentId)).toEqual([
      ...builtIn,
      { id: "plugin:flags:clear", label: "Clear flag", separatorBefore: true },
    ]);
    expect(withPluginThreadMenuItems(builtIn, otherEnvironmentId)).toBe(builtIn);
    expect(runPluginThreadMenuItem("plugin:flags:clear", environmentId, "thread-1")).toBe(true);
    expect(runPluginThreadMenuItem("rename", environmentId, "thread-1")).toBe(false);
    expect(ran).toEqual(["thread-1"]);
    // Every timeline row reads message actions, so a thread menu item must not hand them a new list.
    expect(appAtomRegistry.get(pluginActionAtoms.message(environmentId))).toBe(messageActions);
  });
});

describe("plugin thread badges", () => {
  it("keeps a thread's badge list when another thread's badges change", () => {
    setPluginThreadBadge("thread-a", "flags", { label: "Review", tone: "warning" });
    const before = appAtomRegistry.get(pluginThreadBadgesAtom("thread-a"));
    setPluginThreadBadge("thread-b", "flags", { label: "Done", tone: "success" });

    // Same array, so thread-a's sidebar row does not re-render.
    expect(appAtomRegistry.get(pluginThreadBadgesAtom("thread-a"))).toBe(before);
    expect(appAtomRegistry.get(pluginThreadBadgesAtom("thread-b"))).toEqual([
      { pluginId: "flags", label: "Done", tone: "success" },
    ]);
    // A changed badge keeps its place beside another plugin's.
    setPluginThreadBadge("thread-a", "ci", { label: "Passing", tone: "success" });
    setPluginThreadBadge("thread-a", "flags", { label: "Approved", tone: "success" });
    expect(
      appAtomRegistry.get(pluginThreadBadgesAtom("thread-a")).map((badge) => badge.pluginId),
    ).toEqual(["flags", "ci"]);
    setPluginThreadBadge("thread-a", "ci", null);
    setPluginThreadBadge("thread-a", "flags", null);
    setPluginThreadBadge("thread-b", "flags", null);
    expect(appAtomRegistry.get(pluginThreadBadgesAtom("thread-a"))).toEqual([]);
  });
});

describe("plugin pages", () => {
  it("keeps a page while the same plugin from another environment still has it", () => {
    const key = pluginPageKey("notes", "all");
    const local = { title: "Notes (local)", component: () => null, owner };
    const remote = { title: "Notes (remote)", component: () => null, owner };
    const unregisterLocal = registerPluginPage(key, local);
    using _remote = { [Symbol.dispose]: registerPluginPage(key, remote) };

    expect(appAtomRegistry.get(pluginPageAtom(key))).toBe(remote);
    unregisterLocal();
    expect(appAtomRegistry.get(pluginPageAtom(key))).toBe(remote);
  });
});

describe("plugin @ items", () => {
  it("updates the environment's items without touching other plugin lists", () => {
    const slashCommands = appAtomRegistry.get(pluginSlashCommandsAtom(environmentId));
    const item = {
      key: "plugin-mention:notes:1",
      contextId: pluginMentionContextId(environmentId, "notes", "1"),
      pluginName: "Notes",
      label: "First note",
      description: "",
      text: "(Note: first)",
    };
    setPluginMentionItems(environmentId, "notes", [item]);
    setPluginMentionItems(environmentId, "notes", [
      item,
      {
        ...item,
        key: "plugin-mention:notes:2",
        contextId: pluginMentionContextId(environmentId, "notes", "2"),
      },
    ]);

    // The composer reads slash commands too; @ item updates must not hand it a new list, and
    // neither must another registry change, such as a banner.
    expect(appAtomRegistry.get(pluginSlashCommandsAtom(environmentId))).toBe(slashCommands);
    const hideBanner = registerPluginBanner({
      key: "notes:1",
      environmentId,
      pluginId: "notes",
      variant: "info",
      title: "Saved",
      dismiss: () => undefined,
    });
    expect(appAtomRegistry.get(pluginSlashCommandsAtom(environmentId))).toBe(slashCommands);
    hideBanner();
    const mentions = appAtomRegistry.get(pluginMentionItemsAtom(environmentId));
    expect(mentions).toHaveLength(2);
    setPluginMentionItems(otherEnvironmentId, "notes", [item]);
    expect(appAtomRegistry.get(pluginMentionItemsAtom(environmentId))).toBe(mentions);
    setPluginMentionItems(otherEnvironmentId, "notes", []);
    expect(appAtomRegistry.get(pluginMentionItemsAtom(otherEnvironmentId))).toEqual([]);
    setPluginMentionItems(environmentId, "notes", []);
    expect(appAtomRegistry.get(pluginMentionItemsAtom(environmentId))).toEqual([]);
  });

  it("sends each chip with its item's current text and leaves out chips whose item is gone", () => {
    const contextId = pluginMentionContextId(environmentId, "notes", "1");
    const chip = formatComposerContextReference({
      kind: PLUGIN_CONTEXT_KIND,
      contextId,
      label: "First note",
    });
    const goneChip = formatComposerContextReference({
      kind: PLUGIN_CONTEXT_KIND,
      contextId: pluginMentionContextId(environmentId, "notes", "gone"),
      label: "Gone",
    });
    const item = {
      key: "plugin-mention:notes:1",
      contextId,
      pluginName: "Notes",
      label: "First note",
      description: "",
      text: "old text",
    };
    setPluginMentionItems(environmentId, "notes", [item]);
    setPluginMentionItems(environmentId, "notes", [{ ...item, text: "new text" }]);

    expect(pluginMentionContextRecords(`see ${chip} and ${chip}, ${goneChip}`)).toEqual([
      {
        version: 1,
        kind: PLUGIN_CONTEXT_KIND,
        contextId,
        label: "First note",
        payload: { plugin: "Notes", text: "new text" },
      },
    ]);
    setPluginMentionItems(environmentId, "notes", []);
    expect(pluginMentionContextRecords(chip)).toEqual([]);
    // Control characters grow sixfold as JSON, so text within the character cap can overflow it.
    const codes = capPluginMentionText("\u0001".repeat(30_000));
    expect(JSON.stringify({ plugin: "Notes", text: codes }).length).toBeLessThanOrEqual(64_000);
  });
});
