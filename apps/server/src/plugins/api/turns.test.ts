import { assert, it } from "@effect/vitest";
import { PluginId, ThreadId } from "@t3tools/contracts";
import type { PluginApi, PluginStoredEvent } from "@t3tools/plugin-sdk/server";
import type { JsonValue } from "@t3tools/plugin-sdk/shared";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";

import { makePluginActivation, type PluginPublication } from "../PluginApi.ts";
import * as PluginHooks from "../PluginHooks.ts";
import { makeFacadeContext } from "./facade.ts";
import { makeTurnsApi } from "./turns.ts";

const unusedEvents: PluginApi["events"] = {
  stored: () => {
    throw new Error("events are not used here");
  },
};
const unusedStorage = {} as PluginApi["storage"];

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
      { events: unusedEvents, storage: unusedStorage },
    );
    turns.beforeDispatch(() => ({ appendText: "first" }));
    turns.beforeDispatch(() => {
      throw new Error("broken hook");
    });
    turns.beforeDispatch(() => new Promise(() => undefined));
    turns.beforeDispatch(async () => ({ appendText: "last" }));

    const sending = yield* hooks
      .beforeDispatch({
        threadId: ThreadId.make("thread:hooks"),
        messageId: "message:hooks",
        text: "Go",
        createdBy: "user",
        attachments: [],
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("2 seconds");

    assert.strictEqual(yield* Fiber.join(sending), "Go\n\nfirst\n\nlast");
  }).pipe(Effect.provide(PluginHooks.layer)),
);

it.effect("delivers each ended run once and resumes after the last one it handled", () =>
  Effect.gen(function* () {
    const saved = new Map<string, JsonValue>();
    const requests: Array<number | undefined> = [];
    const runUpdate = (sequence: number, status: string): PluginStoredEvent => ({
      sequence,
      type: "run.updated",
      event: { type: "run.updated", payload: { id: `run:${sequence}`, threadId: "t", status } },
    });
    // Activates a plugin over `stored` and resolves once it saved its position after `lastSequence`.
    const activate = (stored: ReadonlyArray<PluginStoredEvent>, lastSequence: number) =>
      Effect.gen(function* () {
        const hooks = yield* PluginHooks.PluginHooks;
        const activation = makePluginActivation(yield* PubSub.sliding<PluginPublication>(1));
        const facade = makeFacadeContext({
          pluginId: PluginId.make("runs"),
          activation,
          context: yield* Effect.context<never>(),
        });
        const caughtUp = Promise.withResolvers<void>();
        const storage = {
          get: async (key: string) => saved.get(key),
          set: async (key: string, value: JsonValue) => {
            saved.set(key, value);
            if (value === lastSequence) caughtUp.resolve();
          },
        } as PluginApi["storage"];
        const events: PluginApi["events"] = {
          stored: (options) => {
            requests.push(options.afterSequence);
            return (async function* () {
              yield* stored;
            })();
          },
        };
        const seen: Array<string> = [];
        makeTurnsApi(facade, { hooks }, { events, storage }).afterRunCompleted((run) => {
          seen.push(`${run.runId}:${run.status}`);
        });
        yield* Effect.promise(() => caughtUp.promise);
        return seen;
      });

    assert.deepStrictEqual(
      yield* activate(
        [runUpdate(10, "completed"), runUpdate(11, "running"), runUpdate(12, "failed")],
        12,
      ),
      ["run:10:completed", "run:12:failed"],
    );
    assert.deepStrictEqual(yield* activate([runUpdate(13, "interrupted")], 13), [
      "run:13:interrupted",
    ]);
    assert.deepStrictEqual(requests, [undefined, 12]);
  }).pipe(Effect.provide(PluginHooks.layer)),
);
