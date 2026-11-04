import {
  DesktopPluginCommandSchema,
  DesktopPluginShortcutRefusalSchema,
  type DesktopPluginShortcutRefusal,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopAssets from "../../app/DesktopAssets.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { isWaylandSession } from "../../snapShot/snapShot.ts";
import * as DesktopApplicationMenu from "../../window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_PLUGIN_COMMANDS_CHANNEL } from "../channels.ts";

type RefusalReason = DesktopPluginShortcutRefusal["reason"];

// Shift and AltGr are left out: with a letter they type one.
const TYPING_SAFE_MODIFIERS = new Set([
  "command",
  "cmd",
  "control",
  "ctrl",
  "commandorcontrol",
  "cmdorctrl",
  "alt",
  "option",
  "super",
  "meta",
]);

/**
 * Whether a global shortcut leaves every app's typing alone: it holds a modifier such as Ctrl or
 * Alt, or its key types nothing, such as F13 to F24 or a media key.
 */
function leavesTypingAlone(accelerator: string): boolean {
  const parts = accelerator.toLowerCase().split("+");
  const key = parts.at(-1) ?? "";
  return (
    parts.slice(0, -1).some((part) => TYPING_SAFE_MODIFIERS.has(part)) ||
    /^f(1[3-9]|2[0-4])$/.test(key) ||
    /^(media|volume)/.test(key)
  );
}

/**
 * Takes the main window's plugin commands: menu items go to the Plugins menu, tray items to a
 * tray icon that exists only while some command asks for it, and global shortcuts are
 * registered with the OS. Each call replaces the previous set.
 */
export const installPluginCommands = Effect.fn("desktop.ipc.installPluginCommands")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
  const assets = yield* DesktopAssets.DesktopAssets;
  const platform = yield* HostProcess.Platform;
  const runFork = Effect.runForkWith(
    yield* Effect.context<DesktopWindow.DesktopWindow | ElectronWindow.ElectronWindow>(),
  );
  const runCommand = (command: string) =>
    runFork(
      Effect.flatMap(DesktopWindow.DesktopWindow, (desktopWindow) =>
        desktopWindow.dispatchMenuAction(command, { reveal: true }),
      ).pipe(Effect.ignore),
    );
  // A shortcut leaves the user in the app they are in. Only a page can run the command, so it
  // opens T3 Code when no window exists.
  const runShortcut = (command: string) =>
    runFork(
      Effect.gen(function* () {
        const main = yield* (yield* ElectronWindow.ElectronWindow).main;
        yield* (yield* DesktopWindow.DesktopWindow).dispatchMenuAction(command, {
          reveal: Option.isNone(main),
        });
      }).pipe(Effect.ignore),
    );
  let tray: Electron.Tray | null = null;
  const destroyTray = () => {
    tray?.destroy();
    tray = null;
  };
  let registered: Array<string> = [];
  // A reload sends the same list again, so an unchanged list skips the menu rebuild.
  let current: ReadonlyArray<typeof DesktopPluginCommandSchema.Type> = [];
  let refused: ReadonlyArray<DesktopPluginShortcutRefusal> = [];
  let wayland: boolean | undefined;
  const unregisterAll = () => {
    for (const accelerator of registered) Electron.globalShortcut.unregister(accelerator);
    registered = [];
  };
  // Runs before any plugin shortcut is registered, when the only one this app holds is SnapShot's.
  const checkShortcut = (accelerator: string): RefusalReason | undefined => {
    // Electron's shortcuts need the desktop portal on Wayland, which this app doesn't enable.
    wayland ??= isWaylandSession(platform, process.env);
    if (wayland) return "unsupported";
    try {
      if (Electron.globalShortcut.isRegistered(accelerator)) return "snap-shot";
    } catch {
      return "invalid";
    }
    return leavesTypingAlone(accelerator) ? undefined : "no-modifier";
  };
  const bindShortcut = (command: string, accelerator: string): RefusalReason | undefined => {
    try {
      // False when another app, or an earlier plugin command, holds it.
      if (!Electron.globalShortcut.register(accelerator, () => runShortcut(command))) {
        return "taken";
      }
    } catch {
      return "invalid";
    }
    registered.push(accelerator);
    return undefined;
  };

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_PLUGIN_COMMANDS_CHANNEL,
      payload: Schema.Array(DesktopPluginCommandSchema).check(Schema.isMaxLength(500)),
      result: Schema.Array(DesktopPluginShortcutRefusalSchema),
      handler: Effect.fn("desktop.ipc.setPluginCommands")(function* (commands, event) {
        const electronWindow = yield* ElectronWindow.ElectronWindow;
        const window = yield* electronWindow.main;
        if (
          event === undefined ||
          Option.isNone(window) ||
          window.value.webContents.id !== event.sender.id
        ) {
          return [];
        }
        if (Equal.equals(commands, current)) {
          // Another app may have let go of a shortcut since; take it now.
          refused = refused.flatMap((refusal) => {
            if (refusal.reason !== "taken" && refusal.reason !== "snap-shot") return [refusal];
            const globalShortcut = commands.find(
              (entry) => entry.command === refusal.command,
            )?.globalShortcut;
            if (globalShortcut === undefined) return [refusal];
            // Plugin shortcuts are bound now, so only a SnapShot refusal asks whether it's held.
            const reason =
              (refusal.reason === "snap-shot"
                ? // Another plugin command may have bound it once SnapShot let go.
                  registered.includes(globalShortcut)
                  ? "taken"
                  : checkShortcut(globalShortcut)
                : undefined) ?? bindShortcut(refusal.command, globalShortcut);
            return reason === undefined ? [] : [{ command: refusal.command, reason }];
          });
          return refused;
        }
        current = commands;
        yield* menu.setPluginCommands(commands);
        const trayCommands = commands.filter((entry) => entry.tray === true);
        if (trayCommands.length === 0) {
          destroyTray();
        } else {
          if (tray === null) {
            const iconPaths = yield* assets.iconPaths;
            const icon = platform === "win32" ? iconPaths.ico : iconPaths.png;
            if (Option.isSome(icon)) {
              const image = Electron.nativeImage.createFromPath(icon.value);
              tray = new Electron.Tray(platform === "darwin" ? menuBarImage(image) : image);
              tray.setToolTip(Electron.app.getName());
            } else {
              yield* Effect.logWarning("No icon for the plugin tray icon; skipping it");
            }
          }
          tray?.setContextMenu(
            Electron.Menu.buildFromTemplate([
              ...trayCommands.map((entry) => ({
                // The plugin's name only where 2 plugins' items share a title.
                label: trayCommands.some((other) => other !== entry && other.title === entry.title)
                  ? `${entry.pluginName}: ${entry.title}`
                  : entry.title,
                click: () => runCommand(entry.command),
              })),
              { type: "separator" },
              {
                label: `Show ${Electron.app.getName()}`,
                click: () =>
                  runFork(
                    Effect.flatMap(
                      DesktopWindow.DesktopWindow,
                      (desktopWindow) => desktopWindow.revealOrCreateMain,
                    ).pipe(Effect.ignore),
                  ),
              },
            ]),
          );
        }
        unregisterAll();
        const checked = commands.flatMap(({ command, globalShortcut }) =>
          globalShortcut === undefined
            ? []
            : [{ command, globalShortcut, reason: checkShortcut(globalShortcut) }],
        );
        const nextRefused: Array<DesktopPluginShortcutRefusal> = [];
        for (const { command, globalShortcut, reason: early } of checked) {
          const reason = early ?? bindShortcut(command, globalShortcut);
          if (reason === undefined) continue;
          nextRefused.push({ command, reason });
          yield* Effect.logWarning("Could not register a plugin's global shortcut", {
            command,
            globalShortcut,
            reason,
          });
        }
        refused = nextRefused;
        return refused;
      }),
    }),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unregisterAll();
      destroyTray();
    }),
  );
});

/** The 1024px app icon at the menu bar's 18pt, with a 2x copy for Retina screens. */
function menuBarImage(image: Electron.NativeImage): Electron.NativeImage {
  const sized = Electron.nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    const side = 18 * scaleFactor;
    sized.addRepresentation({
      scaleFactor,
      buffer: image.resize({ width: side, height: side }).toPNG(),
    });
  }
  return sized;
}
