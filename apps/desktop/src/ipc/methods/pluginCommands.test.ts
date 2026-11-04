import { assert, it } from "@effect/vitest";
import type { DesktopPluginCommand } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  // Accelerators other apps hold, and the one SnapShot registered.
  takenElsewhere: new Set<string>(),
  heldBySnapShot: new Set<string>(),
  shortcuts: new Map<string, () => void>(),
}));
vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  globalShortcut: {
    register: (accelerator: string, callback: () => void) => {
      if (accelerator.includes("Bogus")) throw new TypeError("conversion failure");
      if (native.takenElsewhere.has(accelerator) || native.shortcuts.has(accelerator)) {
        return false;
      }
      native.shortcuts.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator: string) => native.shortcuts.delete(accelerator),
    isRegistered: (accelerator: string) => {
      if (accelerator.includes("Bogus")) throw new TypeError("conversion failure");
      return native.heldBySnapShot.has(accelerator) || native.shortcuts.has(accelerator);
    },
  },
}));

import * as DesktopAssets from "../../app/DesktopAssets.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopApplicationMenu from "../../window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_PLUGIN_COMMANDS_CHANNEL } from "../channels.ts";
import { installPluginCommands } from "./pluginCommands.ts";

const shortcut = (id: string, globalShortcut: string): DesktopPluginCommand => ({
  command: `plugin.timer.${id}`,
  title: id,
  pluginName: "Timer",
  menu: false,
  globalShortcut,
});

const withPluginCommands = <A, E>(
  platform: NodeJS.Platform,
  test: (input: {
    readonly send: (commands: ReadonlyArray<DesktopPluginCommand>) => Promise<unknown>;
    readonly closeWindow: () => void;
    readonly reveals: Queue.Queue<boolean | undefined>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    native.takenElsewhere.clear();
    native.heldBySnapShot.clear();
    native.shortcuts.clear();
    const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    const window = { webContents: { id: 1 } } as Electron.BrowserWindow;
    let main = Option.some(window);
    const reveals = yield* Queue.unbounded<boolean | undefined>();
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* installPluginCommands();
        const handler = handlers.get(SET_PLUGIN_COMMANDS_CHANNEL)!;
        return yield* test({
          send: (commands) => Promise.resolve(handler({ sender: { id: 1 } }, commands)),
          closeWindow: () => {
            main = Option.none();
          },
          reveals,
        });
      }),
    ).pipe(
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provide([
        DesktopIpc.layer({
          handle: (channel, handler) => {
            handlers.set(channel, handler);
          },
          removeHandler: (channel) => {
            handlers.delete(channel);
          },
          on: vi.fn(),
          removeAllListeners: vi.fn(),
        }),
        Layer.mock(DesktopApplicationMenu.DesktopApplicationMenu)({
          setPluginCommands: () => Effect.void,
        }),
        Layer.mock(DesktopAssets.DesktopAssets)({
          iconPaths: Effect.succeed({
            ico: Option.none(),
            icns: Option.none(),
            png: Option.none(),
          }),
        }),
        Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.sync(() => main) }),
        Layer.mock(DesktopWindow.DesktopWindow)({
          dispatchMenuAction: (_action, options) =>
            Queue.offer(reveals, options?.reveal).pipe(Effect.asVoid),
        }),
      ]),
    );
  });

it.effect("runs plugin shortcuts in the background and says why it refuses one", () =>
  withPluginCommands("darwin", ({ send, closeWindow, reveals }) =>
    Effect.gen(function* () {
      native.heldBySnapShot.add("Alt+S");
      native.takenElsewhere.add("Control+Shift+Q");
      const commands = [
        shortcut("toggle", "CommandOrControl+Shift+Y"),
        shortcut("media", "MediaPlayPause"),
        shortcut("f13", "F13"),
        shortcut("plain", "F"),
        shortcut("shifted", "Shift+A"),
        shortcut("snap", "Alt+S"),
        shortcut("taken", "Control+Shift+Q"),
        shortcut("duplicate", "CommandOrControl+Shift+Y"),
        shortcut("bogus", "Control+Bogus"),
      ];
      const expected = [
        { command: "plugin.timer.plain", reason: "no-modifier" },
        { command: "plugin.timer.shifted", reason: "no-modifier" },
        { command: "plugin.timer.snap", reason: "snap-shot" },
        { command: "plugin.timer.taken", reason: "taken" },
        { command: "plugin.timer.duplicate", reason: "taken" },
        { command: "plugin.timer.bogus", reason: "invalid" },
      ];
      assert.deepEqual(yield* Effect.promise(() => send(commands)), expected);
      assert.deepEqual(
        [...native.shortcuts.keys()],
        ["CommandOrControl+Shift+Y", "MediaPlayPause", "F13"],
      );
      // A reloaded page that sends the same list still learns what was refused.
      assert.deepEqual(yield* Effect.promise(() => send(commands)), expected);
      // Once another app or SnapShot lets go of a shortcut, the same list takes it.
      native.takenElsewhere.delete("Control+Shift+Q");
      native.heldBySnapShot.delete("Alt+S");
      assert.deepEqual(
        yield* Effect.promise(() => send(commands)),
        expected.filter(
          ({ command }) => command !== "plugin.timer.taken" && command !== "plugin.timer.snap",
        ),
      );
      assert.isTrue(native.shortcuts.has("Control+Shift+Q"));
      assert.isTrue(native.shortcuts.has("Alt+S"));

      native.shortcuts.get("CommandOrControl+Shift+Y")!();
      assert.isFalse(yield* Queue.take(reveals));
      // Only a page can run the command, so with no window the shortcut opens one.
      closeWindow();
      native.shortcuts.get("CommandOrControl+Shift+Y")!();
      assert.isTrue(yield* Queue.take(reveals));
    }),
  ),
);

it.effect("refuses plugin shortcuts on Wayland", () =>
  withPluginCommands("linux", ({ send }) =>
    Effect.gen(function* () {
      vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
      const refused = yield* Effect.promise(() =>
        send([shortcut("toggle", "CommandOrControl+Shift+Y")]),
      );
      vi.unstubAllEnvs();
      assert.deepEqual(refused, [{ command: "plugin.timer.toggle", reason: "unsupported" }]);
      assert.equal(native.shortcuts.size, 0);
    }),
  ),
);
