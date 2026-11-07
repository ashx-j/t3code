import { assert, it, vi } from "@effect/vitest";
import { PluginId } from "@t3tools/contracts";

import { pluginCodeScope } from "./api/facade.ts";
import { makePluginFailureGuard } from "./pluginFailureGuard.ts";

const leaky = PluginId.make("leaky");

/** Takes the runner's crash listeners off, which would report the fake crashes below as real. */
const withoutRunnerListeners = () => {
  const exceptions = process.listeners("uncaughtException");
  const rejections = process.listeners("unhandledRejection");
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
  return {
    [Symbol.dispose]: () => {
      process.removeAllListeners("uncaughtException");
      process.removeAllListeners("unhandledRejection");
      for (const listener of exceptions) process.on("uncaughtException", listener);
      for (const listener of rejections) process.on("unhandledRejection", listener);
    },
  };
};

/** A guard watching the `leaky` plugin, with exits and their printed errors caught. */
const watchLeaky = () => {
  const recorded: Array<string> = [];
  const guard = makePluginFailureGuard((pluginId) => recorded.push(pluginId));
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const printed = vi.spyOn(console, "error").mockImplementation(() => undefined);
  guard.watch("/plugins/leaky/", leaky);
  return {
    recorded,
    exits: () => exit.mock.calls.length,
    [Symbol.dispose]: () => {
      guard.uninstall();
      exit.mockRestore();
      printed.mockRestore();
    },
    uninstall: guard.uninstall,
  };
};

// As Node reports a crash.
const crash = (error: Error) => process.emit("uncaughtException", error);

it("hands T3's own crashes to a listener added after it, and only those", async () => {
  using _runner = withoutRunnerListeners();
  using guard = watchLeaky();
  const seen: Array<string> = [];
  // Such as the Cursor SDK's guard, when its layer builds after a plugin started.
  const late = (error: Error) => seen.push(error.message);
  process.on("uncaughtException", late);
  await Promise.resolve();

  const pluginError = new Error("thrown in a timer");
  pluginError.stack = "Error: thrown in a timer\n    at /plugins/leaky/server.cjs:1:1";
  crash(pluginError);
  crash(new Error("T3 crashed"));

  assert.deepStrictEqual(guard.recorded, ["leaky"]);
  assert.deepStrictEqual(seen, ["T3 crashed"]);
  assert.strictEqual(guard.exits(), 0);
  // It listens alone, so a guard that exits only then still stops the server.
  assert.strictEqual(process.listenerCount("uncaughtException"), 1);
  guard.uninstall();
  assert.deepStrictEqual(process.listeners("uncaughtException"), [late]);
});

it("calls a listener added with once for one crash", () => {
  using _runner = withoutRunnerListeners();
  const seen: Array<string> = [];
  process.once("uncaughtException", (error) => seen.push(error.message));
  using guard = watchLeaky();

  crash(new Error("first"));
  crash(new Error("second"));

  assert.deepStrictEqual(seen, ["first"]);
  // With nothing else listening, the second stops the server as Node would.
  assert.strictEqual(guard.exits(), 1);
});

it("stops calling a listener its owner removes", () => {
  using _runner = withoutRunnerListeners();
  const seen: Array<string> = [];
  const listener = (error: Error) => seen.push(error.message);
  process.on("uncaughtException", listener);
  using guard = watchLeaky();

  process.off("uncaughtException", listener);
  crash(new Error("T3 crashed"));

  assert.deepStrictEqual(seen, []);
  assert.strictEqual(guard.exits(), 1);
});

it("stops calling a plugin's own listener once the plugin removes it on disable", async () => {
  using _runner = withoutRunnerListeners();
  using guard = watchLeaky();
  const seen: Array<string> = [];
  const listener = (error: Error) => seen.push(error.message);
  // As the plugin's `activate`, then its `onDeactivate`.
  pluginCodeScope.run(leaky, () => process.on("uncaughtException", listener));
  await Promise.resolve();
  process.off("uncaughtException", listener);

  crash(new Error("T3 crashed"));

  assert.deepStrictEqual(seen, []);
  assert.strictEqual(guard.exits(), 1);
});
