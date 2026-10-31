import { assert, it } from "@effect/vitest";
import { PluginId, ThreadId } from "@t3tools/contracts";
import type {
  PluginApi,
  PluginRuntimeRequest,
  PluginStoredEvent,
} from "@t3tools/plugin-sdk/server";
import type { JsonValue } from "@t3tools/plugin-sdk/shared";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";

import { makePluginActivation, type PluginPublication } from "../PluginApi.ts";
import * as PluginHooks from "../PluginHooks.ts";
import { makeFacadeContext } from "./facade.ts";
import type { RuntimeRequestHook } from "./runtimeRequests.ts";
import { makeSlashCommandsApi } from "./slashCommands.ts";
import { makeTextGenerationApi } from "./textGeneration.ts";
import { makeTurnsApi } from "./turns.ts";

// None of these messages replays an accepted command.
const notAccepted = Effect.succeed(false);
const unusedStorage = {} as PluginApi["storage"];
const unusedRunEvents = () => {
  throw new Error("run events are not used here");
};
const unusedRuntimeRequests = {
  add: () => {
    throw new Error("runtime requests are not used here");
  },
};

it.effect(
  "runs beforeDispatch hooks in order, skipping one that throws or misses its deadline",
  () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.PluginHooks;
      const activation = makePluginActivation(yield* PubSub.sliding<PluginPublication>(1));
      const turns = makeTurnsApi(
        makeFacadeContext({
          pluginId: PluginId.make("hooked"),
          activation,
          context: yield* Effect.context<never>(),
        }),
        { hooks, runtimeRequests: unusedRuntimeRequests },
        { storage: unusedStorage, runEvents: unusedRunEvents, pluginName: "Hooked" },
      );
      turns.beforeDispatch(() => ({ appendText: "first" }));
      turns.beforeDispatch(() => {
        throw new Error("broken hook");
      });
      turns.beforeDispatch(() => new Promise(() => undefined));
      turns.beforeDispatch((message) => ({ text: message.text.toUpperCase() }));
      turns.beforeDispatch(async () => ({ appendText: "last" }));
      turns.beforeDispatch((message) =>
        message.text.startsWith("HALT") ? { block: " " } : undefined,
      );
      const send = (text: string) =>
        hooks
          .beforeDispatch(
            {
              threadId: ThreadId.make("thread:hooks"),
              messageId: "message:hooks",
              text,
              createdBy: "user",
              attachments: [],
            },
            notAccepted,
          )
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));

      const sending = yield* send("Go");
      yield* TestClock.adjust("2 seconds");
      assert.deepStrictEqual(yield* Fiber.join(sending), Exit.succeed("GO\n\nFIRST\n\nlast"));

      const halting = yield* send("halt");
      yield* TestClock.adjust("2 seconds");
      assert.deepStrictEqual(
        yield* Fiber.join(halting),
        Exit.fail(
          new PluginHooks.PluginMessageBlockedError({
            pluginName: "Hooked",
            reason: "Blocked this message.",
          }),
        ),
      );
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
        makeTurnsApi(
          facade,
          { hooks, runtimeRequests: unusedRuntimeRequests },
          { storage, runEvents, pluginName: "Runs" },
        ).afterRunCompleted((run) => {
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

it.effect("drops what a plugin answers after it is turned off", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.PluginHooks;
    const activation = makePluginActivation(yield* PubSub.sliding<PluginPublication>(1));
    const facade = makeFacadeContext({
      pluginId: PluginId.make("late"),
      activation,
      context: yield* Effect.context<never>(),
    });
    let runtimeRequestHook: RuntimeRequestHook | undefined;
    const turns = makeTurnsApi(
      facade,
      {
        hooks,
        runtimeRequests: {
          add: (hook) => {
            runtimeRequestHook = hook;
            return () => undefined;
          },
        },
      },
      { storage: unusedStorage, runEvents: unusedRunEvents, pluginName: "Late" },
    );
    // Every handler answers only after the plugin has been turned off.
    const turnedOff = Promise.withResolvers<void>();
    let started = 0;
    const allStarted = Promise.withResolvers<void>();
    const later = <A>(answer: A) => {
      started += 1;
      if (started === 4) allStarted.resolve();
      return turnedOff.promise.then(() => answer);
    };
    turns.onRuntimeRequest(() => later({ decision: "accept" as const }));
    turns.beforeDispatch(() => later({ text: "Changed after the plugin stopped." }));
    makeSlashCommandsApi(facade, { hooks }, "Late").register({ name: "late" }, () =>
      later({ text: "Sent after the plugin stopped." }),
    );
    makeTextGenerationApi(facade, { hooks }).register("threadTitle", () =>
      later({ title: "Titled after the plugin stopped." }),
    );
    const message = (text: string) => ({
      threadId: ThreadId.make("thread:late"),
      messageId: "message:late",
      text,
      createdBy: "user" as const,
      attachments: [],
    });
    const [generate] = yield* hooks.textGenerators("threadTitle");
    const answering = yield* Effect.promise(() =>
      runtimeRequestHook!.answer({} as PluginRuntimeRequest, new AbortController().signal),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    const sending = yield* hooks
      .beforeDispatch(message("Ship it"), notAccepted)
      .pipe(Effect.forkChild({ startImmediately: true }));
    const commanding = yield* hooks
      .beforeDispatch(message("/late now"), notAccepted)
      .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
    const titling = yield* generate!({ message: "Ship it" }).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.promise(() => allStarted.promise);
    activation.controller.abort();
    turnedOff.resolve();

    assert.isUndefined(yield* Fiber.join(answering));
    assert.strictEqual(yield* Fiber.join(sending), "Ship it");
    assert.deepStrictEqual(
      yield* Fiber.join(commanding),
      Exit.fail(
        new PluginHooks.PluginMessageBlockedError({
          pluginName: "Late",
          reason: "/late stopped because the plugin was turned off.",
        }),
      ),
    );
    assert.isUndefined(yield* Fiber.join(titling));
  }).pipe(Effect.provide(PluginHooks.layer)),
);
