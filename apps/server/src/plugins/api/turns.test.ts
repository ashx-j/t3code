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

const unusedStorage = {} as PluginApi["storage"];
const unusedRunEvents = () => {
  throw new Error("run events are not used here");
};

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
      { storage: unusedStorage, runEvents: unusedRunEvents },
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
    const runUpdateOf = (sequence: number, runId: string, status: string): PluginStoredEvent => ({
      sequence,
      type: "run.updated",
      event: { type: "run.updated", payload: { id: runId, threadId: "t", status } },
    });
    // Activates a plugin over `stored` and resolves once it has handled every event.
    const activate = (stored: ReadonlyArray<PluginStoredEvent>) =>
      Effect.gen(function* () {
        const hooks = yield* PluginHooks.PluginHooks;
        const activation = makePluginActivation(yield* PubSub.sliding<PluginPublication>(1));
        const facade = makeFacadeContext({
          pluginId: PluginId.make("runs"),
          activation,
          context: yield* Effect.context<never>(),
        });
        const drained = Promise.withResolvers<void>();
        const storage = {
          get: async (key: string) => saved.get(key),
          set: async (key: string, value: JsonValue) => {
            saved.set(key, value);
          },
        } as PluginApi["storage"];
        const runEvents = (afterSequence: number | undefined) => {
          requests.push(afterSequence);
          return (async function* () {
            try {
              yield* stored;
            } finally {
              drained.resolve();
            }
          })();
        };
        const seen: Array<string> = [];
        makeTurnsApi(facade, { hooks }, { storage, runEvents }).afterRunCompleted((run) => {
          seen.push(`${run.runId}:${run.status}`);
        });
        yield* Effect.promise(() => drained.promise);
        return seen;
      });

    assert.deepStrictEqual(
      yield* activate([
        runUpdate(10, "completed"),
        runUpdate(11, "running"),
        runUpdate(12, "failed"),
      ]),
      ["run:10:completed", "run:12:failed"],
    );
    // A checkpoint landing on an ended run updates it again, after a restart too.
    assert.deepStrictEqual(
      yield* activate([runUpdate(13, "interrupted"), runUpdateOf(14, "run:13", "interrupted")]),
      ["run:13:interrupted"],
    );
    assert.deepStrictEqual(yield* activate([runUpdateOf(15, "run:12", "failed")]), []);
    assert.deepStrictEqual(requests, [undefined, 12, 13]);
  }).pipe(Effect.provide(PluginHooks.layer)),
);
