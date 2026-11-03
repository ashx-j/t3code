import {
  DesktopPluginCommandSchema,
  type DesktopPluginCommand,
  type DesktopPluginShortcutRefusal,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { toastManager } from "../components/ui/toast";
import { registerMenuAction } from "../shortcuts/dispatcher";

export const isDesktopPluginCommand = Schema.is(DesktopPluginCommandSchema);

const commands = new Map<string, DesktopPluginCommand>();
let syncQueued = false;
// Told once per command and shortcut, since every sync registers all of them again.
const refusalsShown = new Set<string>();

const ACCELERATOR_ALIASES: Readonly<Record<string, string>> = {
  cmdorctrl: "commandorcontrol",
  cmd: "command",
  ctrl: "control",
  option: "alt",
  meta: "super",
};

// Electron accepts several spellings of one shortcut, such as CmdOrCtrl and CommandOrControl.
const sameAccelerator = (a: string, b: string) => {
  const canonical = (accelerator: string) =>
    accelerator
      .toLowerCase()
      .split("+")
      .map((part) => ACCELERATOR_ALIASES[part] ?? part)
      .toSorted()
      .join("+");
  return canonical(a) === canonical(b);
};

const showRefusals = (refused: ReadonlyArray<DesktopPluginShortcutRefusal>) => {
  const refusedCommands = new Set(refused.map((refusal) => refusal.command));
  for (const { command, reason } of refused) {
    const entry = commands.get(command);
    if (entry?.globalShortcut === undefined) continue;
    const key = `${command}\u0000${entry.globalShortcut}`;
    if (refusalsShown.has(key)) continue;
    refusalsShown.add(key);
    const shortcut = entry.globalShortcut;
    // Only a command whose shortcut was registered can hold it; refused ones lost to another app.
    const holder =
      reason === "taken"
        ? [...commands.values()].find(
            (other) =>
              !refusedCommands.has(other.command) &&
              other.globalShortcut !== undefined &&
              sameAccelerator(other.globalShortcut, shortcut),
          )
        : undefined;
    toastManager.add({
      type: "warning",
      title:
        reason === "taken"
          ? `${entry.globalShortcut} is taken`
          : `${entry.globalShortcut} isn't a valid shortcut`,
      description: `${
        reason === "invalid"
          ? "The desktop app can't bind it"
          : holder === undefined
            ? "Another app uses it"
            : `${holder.pluginName}'s "${holder.title}" uses it`
      }, so ${entry.pluginName}'s "${entry.title}" has no global shortcut.`,
    });
  }
};

// One IPC call per burst of changes, such as a plugin registering several commands at once.
const queueSync = () => {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    void window.desktopBridge
      ?.setPluginCommands([...commands.values()])
      // An older desktop app resolves with nothing.
      .then((refused) => showRefusals(Array.isArray(refused) ? refused : []))
      .catch(() => undefined);
  });
};

/**
 * Lists a plugin command in the desktop app's Plugins menu or binds its global shortcut, and
 * returns the function that removes it. Outside the desktop app it does nothing.
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
