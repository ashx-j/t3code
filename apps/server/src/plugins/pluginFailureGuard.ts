// @effect-diagnostics globalConsole:off - The guard runs in Node's process callbacks, outside an Effect runtime, and prints T3's own crashes the way Node does.
import type { PluginId } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

import { PluginApiCallError, pluginCodeScope } from "./api/facade.ts";

const CRASH_EVENTS = ["uncaughtException", "unhandledRejection"] as const;
type CrashEvent = (typeof CRASH_EVENTS)[number];
const isCrashEvent = (event: string | symbol): event is CrashEvent =>
  event === "uncaughtException" || event === "unhandledRejection";
type Listener = (...args: ReadonlyArray<unknown>) => unknown;
const isListener = (value: unknown): value is Listener => typeof value === "function";

/**
 * Keeps plugin code that fails outside a call, such as in a timer, from stopping the server. It
 * wraps every other crash listener so plugin failures skip it, and listens itself only while none
 * does, because the Cursor SDK guard exits only while it listens alone. One per process.
 */
export const makePluginFailureGuard = (
  onPluginFailure: (pluginId: PluginId, error: unknown) => void,
) => {
  // Node keeps loaded plugin code and its timers until exit, so a root is never dropped.
  const roots = new Map<string, PluginId>();
  // Each wrapper and what `process.rawListeners` held before it: the listener or its `once` wrapper.
  const wrapped = new WeakMap<Listener, Listener>();
  let installed = false;
  let syncing = false;

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

  // What Node does with no listener, for failures that aren't a plugin's.
  const alone: Record<CrashEvent, (error: unknown) => void> = {
    uncaughtException: (error) => {
      const pluginId = pluginOf(error);
      // Node calls resuming after an uncaught exception unsafe; accepted for trusted plugin code.
      if (pluginId !== undefined) return onPluginFailure(pluginId, error);
      console.error(error);
      process.exit(1);
    },
    unhandledRejection: (reason) => {
      const pluginId = pluginOf(reason);
      if (pluginId !== undefined) return onPluginFailure(pluginId, reason);
      throw reason;
    },
  };

  // Node's `off` and `listeners()` read `listener`, as on its own `once` wrappers.
  const wrap = (event: CrashEvent, raw: Listener) => {
    const listener: unknown = Reflect.get(raw, "listener");
    const original = isListener(listener) ? listener : raw;
    const gated = Object.assign(
      (error: unknown, detail: unknown) => {
        const pluginId = pluginOf(error);
        if (pluginId !== undefined) {
          // Every wrapper sees the failure; the first records it.
          const first = process
            .rawListeners(event)
            .find((other) => isListener(other) && wrapped.has(other));
          if (first === gated) onPluginFailure(pluginId, error);
          return;
        }
        if (original !== raw) process.off(event, gated);
        Reflect.apply(original, process, [error, detail]);
      },
      { listener: original },
    );
    wrapped.set(gated, raw);
    return gated;
  };

  const sync = () => {
    if (!installed || syncing) return;
    syncing = true;
    try {
      for (const event of CRASH_EVENTS) {
        const listeners = process.rawListeners(event).filter(isListener);
        const others = listeners.filter((other) => other !== alone[event]);
        if (
          others.every((other) => wrapped.has(other)) &&
          (others.length === 0) === listeners.includes(alone[event])
        ) {
          continue;
        }
        // Re-adding them all keeps their order.
        process.removeAllListeners(event);
        for (const other of others) {
          process.on(event, wrapped.has(other) ? other : wrap(event, other));
        }
        if (others.length === 0) process.on(event, alone[event]);
      }
    } finally {
      syncing = false;
    }
  };
  // Node adds a listener after announcing it, so it is wrapped once it is in.
  const onNewListener = (event: string | symbol) => {
    if (!syncing && isCrashEvent(event)) queueMicrotask(sync);
  };
  const onRemoveListener = (event: string | symbol) => {
    if (!syncing && isCrashEvent(event)) sync();
  };

  return {
    /** Ties failures whose stack names a file under `root` to the plugin; the first call installs. */
    watch: (root: string, pluginId: PluginId) => {
      roots.set(root, pluginId);
      if (installed) return;
      installed = true;
      sync();
      process.on("newListener", onNewListener);
      process.on("removeListener", onRemoveListener);
    },
    /** Puts back the listeners it wrapped. */
    uninstall: () => {
      if (!installed) return;
      installed = false;
      process.off("newListener", onNewListener);
      process.off("removeListener", onRemoveListener);
      for (const event of CRASH_EVENTS) {
        const others = process.rawListeners(event).filter(isListener);
        process.removeAllListeners(event);
        for (const other of others) {
          if (other !== alone[event]) process.on(event, wrapped.get(other) ?? other);
        }
      }
    },
  };
};
