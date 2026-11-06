import { DesktopPluginCommandSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopApplicationMenu from "../../window/DesktopApplicationMenu.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_PLUGIN_COMMANDS_CHANNEL } from "../channels.ts";

/**
 * Takes the main window's plugin commands for the Plugins menu. Each call replaces the previous
 * set.
 */
export const installPluginCommands = Effect.fn("desktop.ipc.installPluginCommands")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
  // A reload sends the same list again, so an unchanged list skips the menu rebuild.
  let current: ReadonlyArray<typeof DesktopPluginCommandSchema.Type> = [];

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
          window.value.webContents.id !== event.sender.id ||
          Equal.equals(commands, current)
        ) {
          return;
        }
        current = commands;
        yield* menu.setPluginCommands(commands);
      }),
    }),
  );
});
