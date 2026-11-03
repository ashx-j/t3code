import { DesktopPluginCommandSchema } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopAssets from "../../app/DesktopAssets.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopApplicationMenu from "../../window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_PLUGIN_COMMANDS_CHANNEL } from "../channels.ts";

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
  const runFork = Effect.runForkWith(yield* Effect.context<DesktopWindow.DesktopWindow>());
  const runCommand = (command: string) =>
    runFork(
      Effect.flatMap(DesktopWindow.DesktopWindow, (desktopWindow) =>
        desktopWindow.dispatchMenuAction(command, { reveal: true }),
      ).pipe(Effect.ignore),
    );
  let tray: Electron.Tray | null = null;
  const destroyTray = () => {
    tray?.destroy();
    tray = null;
  };
  let registered: Array<string> = [];
  // Each window load sends an empty list first, so an unchanged list skips the menu rebuild.
  let current: ReadonlyArray<typeof DesktopPluginCommandSchema.Type> = [];
  const unregisterAll = () => {
    for (const accelerator of registered) Electron.globalShortcut.unregister(accelerator);
    registered = [];
  };

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_PLUGIN_COMMANDS_CHANNEL,
      payload: Schema.Array(DesktopPluginCommandSchema).check(Schema.isMaxLength(500)),
      result: Schema.Array(Schema.String),
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
        if (Equal.equals(commands, current)) return [];
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
              // The app icon is 1024px; the macOS menu bar wants about 18pt.
              tray = new Electron.Tray(
                platform === "darwin" ? image.resize({ width: 18, height: 18 }) : image,
              );
              tray.setToolTip(Electron.app.getName());
            } else {
              yield* Effect.logWarning("No icon for the plugin tray icon; skipping it");
            }
          }
          tray?.setContextMenu(
            Electron.Menu.buildFromTemplate([
              ...trayCommands.map((entry) => ({
                label: entry.title,
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
        const refused: Array<string> = [];
        for (const { command, globalShortcut } of commands) {
          if (globalShortcut === undefined) continue;
          const run = () => runCommand(command);
          // Throws on an accelerator Electron can't parse; returns false when another app holds it.
          const added = yield* Effect.try(() =>
            Electron.globalShortcut.register(globalShortcut, run),
          ).pipe(Effect.orElseSucceed(() => false));
          if (added) registered.push(globalShortcut);
          else {
            refused.push(command);
            yield* Effect.logWarning("Could not register a plugin's global shortcut", {
              command,
              globalShortcut,
            });
          }
        }
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
