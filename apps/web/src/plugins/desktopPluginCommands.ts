import {
  DesktopPluginCommandSchema,
  type DesktopPluginCommand,
  type DesktopPluginShortcutRefusal,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { toastManager } from "../components/ui/toast";
import { registerMenuAction } from "../shortcuts/dispatcher";

export const isDesktopPluginCommand = Schema.is(DesktopPluginCommandSchema);

const commands = new Map<string, DesktopPluginCommand>();
let syncQueued = false;
// The desktop keeps the last page's list until this page's first round of plugin loads ends, so
// a reload doesn't drop the tray icon and shortcuts in between.
let held = true;

// Each refusal shows once, across launches and reloads, since each one registers every shortcut
// again. Keyed by command and shortcut; a shortcut that later binds is forgotten.
const REFUSALS_SHOWN_STORAGE_KEY = "t3code:plugin-shortcut-refusals";
const decodeRefusalsShown = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

const readRefusalsShown = () => {
  try {
    return new Map(
      Object.entries(
        Option.getOrElse(
          decodeRefusalsShown(window.localStorage.getItem(REFUSALS_SHOWN_STORAGE_KEY)),
          () => ({}),
        ),
      ),
    );
  } catch {
    return new Map<string, string>();
  }
};

const writeRefusalsShown = (shown: ReadonlyMap<string, string>) => {
  try {
    if (shown.size === 0) window.localStorage.removeItem(REFUSALS_SHOWN_STORAGE_KEY);
    else
      window.localStorage.setItem(
        REFUSALS_SHOWN_STORAGE_KEY,
        JSON.stringify(Object.fromEntries(shown)),
      );
  } catch {
    // Without storage, a refusal shows again on the next launch.
  }
};

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

const refusalText = (
  reason: DesktopPluginShortcutRefusal["reason"],
  shortcut: string,
  holder: DesktopPluginCommand | undefined,
): { readonly title: string; readonly cause: string } => {
  switch (reason) {
    case "taken":
      return {
        title: `${shortcut} is taken`,
        cause:
          holder === undefined
            ? "Another app uses it"
            : `${holder.pluginName}'s "${holder.title}" uses it`,
      };
    case "snap-shot":
      return { title: `${shortcut} is taken`, cause: "Your SnapShot shortcut uses it" };
    case "invalid":
      return {
        title: `${shortcut} isn't a valid shortcut`,
        cause: "The desktop app can't bind it",
      };
    case "no-modifier":
      return {
        title: `${shortcut} needs a modifier key`,
        cause: "Without Ctrl, Alt, Command or Super it would take that key from every app",
      };
    case "unsupported":
      return {
        title: `${shortcut} doesn't work on Wayland`,
        cause: "Wayland doesn't let the desktop app bind global shortcuts",
      };
  }
};

const showRefusals = (
  sent: ReadonlyArray<DesktopPluginCommand>,
  refused: ReadonlyArray<DesktopPluginShortcutRefusal>,
) => {
  const reasons = new Map(refused.map(({ command, reason }) => [command, reason]));
  const shown = readRefusalsShown();
  let changed = false;
  for (const entry of sent) {
    const shortcut = entry.globalShortcut;
    if (shortcut === undefined) continue;
    const key = `${entry.command} ${shortcut}`;
    const reason = reasons.get(entry.command);
    if (shown.get(key) === reason) continue;
    changed = true;
    if (reason === undefined) {
      shown.delete(key);
      continue;
    }
    shown.set(key, reason);
    // Only a command whose shortcut was registered can hold it; refused ones lost to another app.
    const holder =
      reason === "taken"
        ? sent.find(
            (other) =>
              !reasons.has(other.command) &&
              other.globalShortcut !== undefined &&
              sameAccelerator(other.globalShortcut, shortcut),
          )
        : undefined;
    const { title, cause } = refusalText(reason, shortcut, holder);
    toastManager.add({
      type: "warning",
      title,
      description: `${cause}, so ${entry.pluginName}'s "${entry.title}" has no global shortcut.`,
    });
  }
  if (changed) writeRefusalsShown(shown);
};

// One IPC call per burst of changes, such as a plugin registering several commands at once.
const queueSync = () => {
  if (held || syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    const sent = [...commands.values()];
    void window.desktopBridge
      ?.setPluginCommands(sent)
      // An older desktop app resolves with nothing.
      .then((refused) => showRefusals(sent, Array.isArray(refused) ? refused : []))
      .catch(() => undefined);
  });
};

/** Sends this page's commands, even none, once its first round of plugin loads has ended. */
export function releaseDesktopPluginCommands() {
  if (!held) return;
  held = false;
  queueSync();
}

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
