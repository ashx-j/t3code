import type { DesktopPluginCommand, DesktopPluginShortcutRefusal } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

const toast = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../components/ui/toast", () => ({ toastManager: toast }));
vi.mock("../shortcuts/dispatcher", () => ({ registerMenuAction: () => () => undefined }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  toast.add.mockReset();
});

const toggle: DesktopPluginCommand = {
  command: "plugin.timer.toggle",
  title: "Toggle timer",
  pluginName: "Timer",
  menu: false,
  globalShortcut: "Alt+T",
};

/** A page load: a fresh module whose sync resolves with `refused`, over the same storage. */
async function loadPage(
  storage: Map<string, string>,
  refused: ReadonlyArray<DesktopPluginShortcutRefusal>,
) {
  const setPluginCommands = vi.fn(() => Promise.resolve(refused));
  vi.stubGlobal("window", {
    desktopBridge: { setPluginCommands },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  vi.resetModules();
  const { registerDesktopPluginCommand } = await import("./desktopPluginCommands");
  registerDesktopPluginCommand(toggle, () => undefined);
  await vi.waitFor(() => expect(setPluginCommands).toHaveBeenCalledOnce());
  // The module's own handler was attached first, so it has run once this resolves.
  await setPluginCommands.mock.results[0]!.value;
}

it("shows a shortcut refusal once across page loads until the shortcut binds", async () => {
  const storage = new Map<string, string>();
  const taken = [{ command: toggle.command, reason: "snap-shot" }] as const;

  await loadPage(storage, taken);
  expect(toast.add).toHaveBeenCalledOnce();
  expect(toast.add.mock.calls[0]![0]).toMatchObject({
    description:
      'Your SnapShot shortcut uses it, so Timer\'s "Toggle timer" has no global shortcut.',
  });

  await loadPage(storage, taken);
  expect(toast.add).toHaveBeenCalledOnce();

  await loadPage(storage, []);
  await loadPage(storage, taken);
  expect(toast.add).toHaveBeenCalledTimes(2);
});
