import { assert, it } from "@effect/vitest";
import { PluginId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";

import { makePluginActivation, type PluginPublication } from "../PluginApi.ts";
import * as PluginHooks from "../PluginHooks.ts";
import { makeFacadeContext } from "./facade.ts";
import { makeTurnsApi } from "./turns.ts";

it.effect("skips a beforeDispatch hook that throws or misses its deadline", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.PluginHooks;
    const activation = makePluginActivation(yield* PubSub.sliding<PluginPublication>(1));
    const turns = makeTurnsApi(
      makeFacadeContext({
        pluginId: PluginId.make("hooked"),
        activation,
        context: yield* Effect.context<never>(),
      }),
      { hooks },
    );
    turns.beforeDispatch(() => ({ appendText: "first" }));
    turns.beforeDispatch(() => {
      throw new Error("broken hook");
    });
    turns.beforeDispatch(() => new Promise(() => undefined));
    turns.beforeDispatch(async () => ({ appendText: "last" }));

    const sending = yield* hooks
      .beforeDispatch({ threadId: ThreadId.make("thread:hooks"), text: "Go", createdBy: "user" })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("2 seconds");

    assert.strictEqual(yield* Fiber.join(sending), "Go\n\nfirst\n\nlast");
  }).pipe(Effect.provide(PluginHooks.layer)),
);
