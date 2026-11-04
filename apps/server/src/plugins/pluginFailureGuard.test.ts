import { assert, it, vi } from "@effect/vitest";
import { PluginId } from "@t3tools/contracts";

import { makePluginFailureGuard } from "./pluginFailureGuard.ts";

it("hands T3's own crashes to a listener added after it, and only those", async () => {
  // The runner's own listeners would report the fake crashes below as real ones.
  const runnerListeners = process.listeners("uncaughtException");
  for (const listener of runnerListeners) process.off("uncaughtException", listener);
  using exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const recorded: Array<string> = [];
  const guard = makePluginFailureGuard((pluginId) => recorded.push(pluginId));
  try {
    guard.watch("/plugins/leaky/", PluginId.make("leaky"));
    const seen: Array<string> = [];
    // Such as the Cursor SDK's guard, when its layer builds after a plugin started.
    const late = (error: Error) => seen.push(error.message);
    process.on("uncaughtException", late);
    await Promise.resolve();

    // As Node reports a crash: to each listener in turn.
    const crash = (error: Error) => {
      for (const listener of process.listeners("uncaughtException")) {
        listener(error, "uncaughtException");
      }
    };
    const pluginError = new Error("thrown in a timer");
    pluginError.stack = "Error: thrown in a timer\n    at /plugins/leaky/server.cjs:1:1";
    crash(pluginError);
    crash(new Error("T3 crashed"));

    assert.deepStrictEqual(recorded, ["leaky"]);
    assert.deepStrictEqual(seen, ["T3 crashed"]);
    assert.strictEqual(exit.mock.calls.length, 0);
    // It listens alone, so a guard that exits only then still stops the server.
    assert.strictEqual(process.listenerCount("uncaughtException"), 1);
    guard.uninstall();
    assert.deepStrictEqual(process.listeners("uncaughtException"), [late]);
    process.off("uncaughtException", late);
  } finally {
    guard.uninstall();
    for (const listener of runnerListeners) process.on("uncaughtException", listener);
  }
});
