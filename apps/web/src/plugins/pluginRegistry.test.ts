import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  pluginPageAtom,
  pluginPageKey,
  pluginThreadBadgesAtom,
  registerPluginAction,
  registerPluginPage,
  runPluginThreadMenuItem,
  setPluginThreadBadge,
  withPluginThreadMenuItems,
} from "./pluginRegistry";

const environmentId = EnvironmentId.make("environment:plugin-menu");
const otherEnvironmentId = EnvironmentId.make("environment:other");

describe("plugin thread menu items", () => {
  it("adds only the thread environment's items after a separator and runs the one picked", () => {
    const ran: Array<string> = [];
    using _item = {
      [Symbol.dispose]: registerPluginAction("threadMenu", {
        key: "plugin:flags:clear",
        environmentId,
        title: "Clear flag",
        icon: undefined,
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
    setPluginThreadBadge("thread-a", "flags", null);
    setPluginThreadBadge("thread-b", "flags", null);
    expect(appAtomRegistry.get(pluginThreadBadgesAtom("thread-a"))).toEqual([]);
  });
});

describe("plugin pages", () => {
  it("keeps a page while the same plugin from another environment still has it", () => {
    const key = pluginPageKey("notes", "all");
    const local = { title: "Notes (local)", component: () => null };
    const remote = { title: "Notes (remote)", component: () => null };
    const unregisterLocal = registerPluginPage(key, local);
    using _remote = { [Symbol.dispose]: registerPluginPage(key, remote) };

    expect(appAtomRegistry.get(pluginPageAtom(key))).toBe(remote);
    unregisterLocal();
    expect(appAtomRegistry.get(pluginPageAtom(key))).toBe(remote);
  });
});
