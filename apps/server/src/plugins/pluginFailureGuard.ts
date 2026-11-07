// @effect-diagnostics globalConsole:off - The guard runs in Node's process callbacks, outside an Effect runtime, and prints T3's own crashes the way Node does.
import type { PluginId } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

import { PluginApiCallError, pluginCodeScope } from "./api/facade.ts";

/**
 * Keeps plugin code that fails outside a call, such as in a timer, from stopping the server. Other
 * failures go to the listeners it holds, or stop the server as Node would. It holds every other
 * listener, including ones added after it, because the Cursor SDK guard exits only while it
 * listens alone. One per process.
 */
export const makePluginFailureGuard = (
  onPluginFailure: (pluginId: PluginId, error: unknown) => void,
) => {
  // Node keeps loaded plugin code and its timers until exit, so a root is never dropped.
  const roots = new Map<string, PluginId>();
  let held:
    | {
        readonly rejections: Array<NodeJS.UnhandledRejectionListener>;
        readonly exceptions: Array<NodeJS.UncaughtExceptionListener>;
      }
    | undefined;

  // The plugin whose scope the failure ran in, else one whose files its stack names.
  const pluginOf = (error: unknown): PluginId | undefined => {
    const running = pluginCodeScope.getStore();
    if (running !== undefined) return running;
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
    // Node calls resuming after an uncaught exception unsafe; accepted for trusted plugin code.
    if (pluginId !== undefined) return onPluginFailure(pluginId, error);
    if (held !== undefined && held.exceptions.length > 0) {
      for (const listener of held.exceptions) listener(error, origin);
      return;
    }
    console.error(error);
    process.exit(1);
  };

  const holdOthers = () => {
    if (held === undefined) return;
    for (const listener of process.listeners("unhandledRejection")) {
      if (listener === onRejection) continue;
      process.off("unhandledRejection", listener);
      held.rejections.push(listener);
    }
    for (const listener of process.listeners("uncaughtException")) {
      if (listener === onException) continue;
      process.off("uncaughtException", listener);
      held.exceptions.push(listener);
    }
  };
  // Node adds a listener after announcing it, so it is held once it is in.
  const onNewListener = (event: string | symbol) => {
    if (event === "unhandledRejection" || event === "uncaughtException") {
      queueMicrotask(holdOthers);
    }
  };

  return {
    /** Ties failures whose stack names a file under `root` to the plugin; the first call installs. */
    watch: (root: string, pluginId: PluginId) => {
      roots.set(root, pluginId);
      if (held !== undefined) return;
      held = { rejections: [], exceptions: [] };
      holdOthers();
      process.on("unhandledRejection", onRejection);
      process.on("uncaughtException", onException);
      process.on("newListener", onNewListener);
    },
    /** Puts back the listeners the guard held. */
    uninstall: () => {
      if (held === undefined) return;
      holdOthers();
      process.off("newListener", onNewListener);
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onException);
      for (const listener of held.rejections) process.on("unhandledRejection", listener);
      for (const listener of held.exceptions) process.on("uncaughtException", listener);
      held = undefined;
    },
  };
};
