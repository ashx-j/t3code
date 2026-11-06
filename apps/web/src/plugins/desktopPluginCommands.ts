import { DesktopPluginCommandSchema, type DesktopPluginCommand } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { registerMenuAction } from "../shortcuts/dispatcher";

export const isDesktopPluginCommand = Schema.is(DesktopPluginCommandSchema);

const commands = new Map<string, DesktopPluginCommand>();
let syncQueued = false;

// One IPC call per burst of changes, such as a plugin registering several commands at once.
const queueSync = () => {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    // In a fixed order, so the menu doesn't reshuffle as plugins load in parallel, and a reload
    // sends the same list.
    const sent = [...commands.values()].toSorted((left, right) =>
      left.command.localeCompare(right.command),
    );
    void window.desktopBridge?.setPluginCommands(sent).catch(() => undefined);
  });
};

/**
 * Lists a plugin command in the desktop app's Plugins menu, and returns the function that removes
 * it. Outside the desktop app it does nothing.
 */
export function registerDesktopPluginCommand(
  entry: DesktopPluginCommand,
  run: () => void,
): () => void {
  if (window.desktopBridge === undefined) return () => undefined;
  commands.set(entry.command, entry);
  const removeAction = registerMenuAction(entry.command, run);
  queueSync();
  return () => {
    removeAction();
    if (commands.get(entry.command) !== entry) return;
    commands.delete(entry.command);
    queueSync();
  };
}
