// @effect-diagnostics globalConsole:off - The guard runs in Node's process callbacks, outside an Effect runtime, and prints T3's own crashes the way Node does.
import type { PluginId } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

import { PluginApiCallError } from "./api/facade.ts";

/**
 * Keeps plugin code that fails outside a call, such as in a timer, from stopping the server. Other
 * failures go to the listeners it found, which it holds because the Cursor SDK guard exits only
 * while it listens alone, or stop the server as Node would. One per process.
 */
export const makePluginFailureGuard = (
  onPluginFailure: (pluginId: PluginId, error: unknown) => void,
) => {
  // Node keeps loaded plugin code and its timers until exit, so a root is never dropped.
  const roots = new Map<string, PluginId>();
  let held:
    | {
        readonly rejections: ReadonlyArray<NodeJS.UnhandledRejectionListener>;
        readonly exceptions: ReadonlyArray<NodeJS.UncaughtExceptionListener>;
      }
    | undefined;

  const pluginOf = (error: unknown): PluginId | undefined => {
    if (error instanceof PluginApiCallError) return error.pluginId;
    let stack: unknown;
    try {
      stack = Predicate.isObject(error) ? error.stack : undefined;
    } catch {
      // A plugin can throw an object whose `stack` getter throws.
      return undefined;
    }
    if (typeof stack !== "string") return undefined;
    for (const [root, pluginId] of roots) if (stack.includes(root)) return pluginId;
    return undefined;
  };

  const onRejection: NodeJS.UnhandledRejectionListener = (reason, promise) => {
    const pluginId = pluginOf(reason);
    if (pluginId !== undefined) return onPluginFailure(pluginId, reason);
    if (held === undefined || held.rejections.length === 0) throw reason;
    for (const listener of held.rejections) listener(reason, promise);
  };

  const onException: NodeJS.UncaughtExceptionListener = (error, origin) => {
    const pluginId = pluginOf(error);
    if (pluginId !== undefined) return onPluginFailure(pluginId, error);
    if (held !== undefined && held.exceptions.length > 0) {
      for (const listener of held.exceptions) listener(error, origin);
      return;
    }
    console.error(error);
    process.exit(1);
  };

  return {
    /** Ties failures whose stack names a file under `root` to the plugin; the first call installs. */
    watch: (root: string, pluginId: PluginId) => {
      roots.set(root, pluginId);
      if (held !== undefined) return;
      held = {
        rejections: process.listeners("unhandledRejection"),
        exceptions: process.listeners("uncaughtException"),
      };
      for (const listener of held.rejections) process.off("unhandledRejection", listener);
      for (const listener of held.exceptions) process.off("uncaughtException", listener);
      process.on("unhandledRejection", onRejection);
      process.on("uncaughtException", onException);
    },
    /** Puts back the listeners the guard held. */
    uninstall: () => {
      if (held === undefined) return;
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onException);
      for (const listener of held.rejections) process.on("unhandledRejection", listener);
      for (const listener of held.exceptions) process.on("uncaughtException", listener);
      held = undefined;
    },
  };
};
