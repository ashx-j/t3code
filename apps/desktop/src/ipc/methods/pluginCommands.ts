import { DesktopPluginCommandSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopApplicationMenu from "../../window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_PLUGIN_COMMANDS_CHANNEL } from "../channels.ts";

/**
 * Takes the main window's plugin commands: menu items go to the Plugins menu, and global
 * shortcuts are registered with the OS. Each call replaces the previous set.
 */
export const installPluginCommands = Effect.fn("desktop.ipc.installPluginCommands")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
  const runFork = Effect.runForkWith(yield* Effect.context<DesktopWindow.DesktopWindow>());
  let registered: Array<string> = [];
  const unregisterAll = () => {
    for (const accelerator of registered) Electron.globalShortcut.unregister(accelerator);
    registered = [];
  };

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_PLUGIN_COMMANDS_CHANNEL,
      payload: Schema.Array(DesktopPluginCommandSchema).check(Schema.isMaxLength(500)),
      result: Schema.Void,
      handler: Effect.fn("desktop.ipc.setPluginCommands")(function* (commands, event) {
        const electronWindow = yield* ElectronWindow.ElectronWindow;
        const window = yield* electronWindow.main;
        if (
          event === undefined ||
          Option.isNone(window) ||
          window.value.webContents.id !== event.sender.id
        ) {
          return;
        }
        yield* menu.setPluginCommands(commands);
        unregisterAll();
        for (const { command, globalShortcut } of commands) {
          if (globalShortcut === undefined) continue;
          const run = () =>
            runFork(
              Effect.flatMap(DesktopWindow.DesktopWindow, (desktopWindow) =>
                desktopWindow.dispatchMenuAction(command, { reveal: true }),
              ).pipe(Effect.ignore),
            );
          // Throws on an accelerator Electron can't parse; returns false when another app holds it.
          const added = yield* Effect.try(() =>
            Electron.globalShortcut.register(globalShortcut, run),
          ).pipe(Effect.orElseSucceed(() => false));
          if (added) registered.push(globalShortcut);
          else
            yield* Effect.logWarning("Could not register a plugin's global shortcut", {
              command,
              globalShortcut,
            });
        }
      }),
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(unregisterAll));
});
