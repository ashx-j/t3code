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
import { makeTurnsApi } from "./turns.ts";

// None of these messages replays an accepted command.
const notAccepted = Effect.succeed(false);
const unusedStorage = {} as PluginApi["storage"];
const unusedRunEvents = () => {
  throw new Error("run events are not used here");
};
const unusedLatestSequence = () => Promise.reject(new Error("run events are not used here"));
const unusedRuntimeRequests = {
  add: () => {
    throw new Error("runtime requests are not used here");
  },
};

it.effect(
  "runs beforeDispatch hooks in order, skipping ones that throw or miss the message's deadline",
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
        {
          storage: unusedStorage,
          runEvents: unusedRunEvents,
          latestSequence: unusedLatestSequence,
          pluginName: "Hooked",
        },
      );
      const hung = () => new Promise<never>(() => undefined);
      turns.beforeDispatch(() => ({ appendText: "first" }));
      turns.beforeDispatch(() => {
        throw new Error("broken hook");
      });
      turns.beforeDispatch(hung);
      turns.beforeDispatch((message) => ({ text: message.text.toUpperCase() }));
      turns.beforeDispatch(hung);
      turns.beforeDispatch(async () => ({ appendText: "last" }));
      turns.beforeDispatch(hung);
      turns.beforeDispatch((message) =>
        message.text.startsWith("HALT") ? { block: " " } : undefined,
      );
      // The hooks share the message's 2 seconds; a hook that starts later still gets 100 ms.
      const allHung = "2200 millis";
      const send = (text: string) =>
        hooks
          .beforeDispatch(
            {
              threadId: ThreadId.make("thread:hooks"),
              messageId: "message:hooks",
              text,
              createdBy: "user",
              creationSource: "web",
              attachments: [],
            },
            notAccepted,
          )
          .pipe(Effect.forkChild({ startImmediately: true }));

      const sending = yield* send("Go");
      yield* TestClock.adjust(allHung);
      assert.deepStrictEqual(sending.pollUnsafe(), Exit.succeed("GO\n\nFIRST\n\nlast"));

      const halting = yield* send("halt");
      yield* TestClock.adjust(allHung);
      assert.deepStrictEqual(
        halting.pollUnsafe(),
        Exit.fail(
          new PluginHooks.PluginMessageBlockedError({
            pluginName: "Hooked",
            reason: "Blocked this message.",
          }),
        ),
      );

      // A queued edit knows its run's provider, so only a name in a command list is a command,
      // which skips the hooks.
      yield* hooks.setProviderSlashCommands(() => Effect.succeed(["review"]));
      const rewrite = (text: string) =>
        hooks
          .beforeRewrite(
            text,
            Effect.succeed({
              threadId: ThreadId.make("thread:hooks"),
              messageId: "message:queued",
              text: "Go",
              createdBy: "user" as const,
              creationSource: "web" as const,
              attachments: [],
              model: { instanceId: "codex", model: "gpt-5" },
            }),
            notAccepted,
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
      const notCommand = yield* rewrite("/please go");
      yield* TestClock.adjust(allHung);
      assert.deepStrictEqual(notCommand.pollUnsafe(), Exit.succeed("/PLEASE GO\n\nFIRST\n\nlast"));
      const command = yield* rewrite("/review go");
      assert.deepStrictEqual(yield* Fiber.join(command), "/review go");
    }).pipe(Effect.provide(PluginHooks.layer)),
);

const runUpdate = (sequence: number, runId: string, status: string): PluginStoredEvent => ({
  sequence,
  type: "run.updated",
  event: { type: "run.updated", payload: { id: runId, threadId: "t", status } },
});

/**
 * Activates a plugin whose `register` adds run handlers, over the `stored` run updates after each
 * handler's saved place, and resolves once `handlers` of them have read every one.
 */
const activateRuns = (input: {
  readonly saved: Map<string, JsonValue>;
  readonly stored: ReadonlyArray<PluginStoredEvent>;
  readonly register: (turns: PluginApi["turns"]) => void;
  readonly handlers?: number;
  /** The newest stored sequence, where a handler with no saved place starts. */
  readonly latest?: number;
  /** Every place a handler starts reading from. */
  readonly requests?: Array<number>;
}) =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.PluginHooks;
    const activation = makePluginActivation(yield* PubSub.sliding<PluginPublication>(1));
    const facade = makeFacadeContext({
      pluginId: PluginId.make("runs"),
      activation,
      context: yield* Effect.context<never>(),
    });
    let reading = input.handlers ?? 1;
    const drained = Promise.withResolvers<void>();
    const storage = {
      get: async (key: string) => input.saved.get(key),
      set: async (key: string, value: JsonValue) => {
        input.saved.set(key, value);
      },
    } as PluginApi["storage"];
    const runEvents = (afterSequence: number) => {
      input.requests?.push(afterSequence);
      return (async function* () {
        try {
          yield* input.stored.filter((stored) => stored.sequence > afterSequence);
        } finally {
          reading -= 1;
          if (reading === 0) drained.resolve();
        }
      })();
    };
    input.register(
      makeTurnsApi(
        facade,
        { hooks, runtimeRequests: unusedRuntimeRequests },
        {
          storage,
          runEvents,
          latestSequence: async () => input.latest ?? 9,
          pluginName: "Runs",
        },
      ),
    );
    yield* Effect.promise(() => drained.promise);
  });

it.effect("delivers each ended run once and resumes after the last one it handled", () =>
  Effect.gen(function* () {
    const saved = new Map<string, JsonValue>();
    const requests: Array<number> = [];
    const activate = (stored: ReadonlyArray<PluginStoredEvent>) =>
      Effect.gen(function* () {
        const seen: Array<string> = [];
        yield* activateRuns({
          saved,
          stored,
          requests,
          register: (turns) =>
            turns.afterRunCompleted("steps", (run) => {
              seen.push(`${run.runId}:${run.status}`);
            }),
        });
        return seen;
      });

    // Turned off before any run ended: the runs that end meanwhile still arrive on the next start.
    assert.deepStrictEqual(yield* activate([]), []);
    assert.deepStrictEqual(
      yield* activate([
        runUpdate(10, "run:10", "completed"),
        runUpdate(11, "run:11", "running"),
        runUpdate(12, "run:12", "failed"),
      ]),
      ["run:10:completed", "run:12:failed"],
    );
    // A checkpoint landing on an ended run updates it again, after a restart too.
    assert.deepStrictEqual(
      yield* activate([
        runUpdate(13, "run:13", "interrupted"),
        runUpdate(14, "run:13", "interrupted"),
      ]),
      ["run:13:interrupted"],
    );
    assert.deepStrictEqual(yield* activate([runUpdate(15, "run:12", "failed")]), []);
    // A retry starts the failed run again, and it ends a second time.
    assert.deepStrictEqual(
      yield* activate([runUpdate(16, "run:12", "preparing"), runUpdate(17, "run:12", "completed")]),
      ["run:12:completed"],
    );
    // A revert rolls back a run that already ended, which is delivered once more.
    assert.deepStrictEqual(
      yield* activate([
        runUpdate(18, "run:12", "rolled_back"),
        runUpdate(19, "run:12", "rolled_back"),
      ]),
      ["run:12:rolled_back"],
    );
    assert.deepStrictEqual(requests, [9, 9, 12, 13, 13, 17]);
  }).pipe(Effect.provide(PluginHooks.layer)),
);

it.effect("keeps each run handler's place by its name, whatever order they register in", () =>
  Effect.gen(function* () {
    const saved = new Map<string, JsonValue>();
    const seen: Array<string> = [];
    const handle = (name: string) => (run: { readonly runId: string }) => {
      seen.push(`${name}:${run.runId}`);
    };
    yield* activateRuns({
      saved,
      stored: [runUpdate(10, "run:10", "completed")],
      register: (turns) => turns.afterRunCompleted("digest", handle("digest")),
    });
    // Run 11 ends while an update that adds a handler before "digest" installs. "digest" still
    // gets it, and "review" starts from now.
    yield* activateRuns({
      saved,
      stored: [runUpdate(10, "run:10", "completed"), runUpdate(11, "run:11", "completed")],
      handlers: 2,
      latest: 11,
      register: (turns) => {
        turns.afterRunCompleted("review", handle("review"));
        turns.afterRunCompleted("digest", handle("digest"));
      },
    });
    assert.deepStrictEqual(seen, ["digest:run:10", "digest:run:11"]);

    // Two handlers of one name would share a place, so the second fails the activation.
    yield* activateRuns({
      saved,
      stored: [],
      register: (turns) => {
        turns.afterRunCompleted("digest", handle("digest"));
        assert.throws(
          () => turns.afterRunCompleted("digest", handle("digest")),
          'afterRunCompleted "digest" is already registered.',
        );
      },
    });
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
      {
        storage: unusedStorage,
        runEvents: unusedRunEvents,
        latestSequence: unusedLatestSequence,
        pluginName: "Late",
      },
    );
    // Every handler answers only after the plugin has been turned off.
    const turnedOff = Promise.withResolvers<void>();
    let started = 0;
    const allStarted = Promise.withResolvers<void>();
    const later = <A>(answer: A) => {
      started += 1;
      if (started === 3) allStarted.resolve();
      return turnedOff.promise.then(() => answer);
    };
    turns.onRuntimeRequest(() => later({ decision: "accept" as const }));
    turns.beforeDispatch(() => later({ text: "Changed after the plugin stopped." }));
    makeSlashCommandsApi(facade, { hooks }, "Late").register({ name: "late" }, () =>
      later({ text: "Sent after the plugin stopped." }),
    );
    const message = (text: string) => ({
      threadId: ThreadId.make("thread:late"),
      messageId: "message:late",
      text,
      createdBy: "user" as const,
      creationSource: "web" as const,
      attachments: [],
    });
    const answering = yield* Effect.promise(() =>
      runtimeRequestHook!.answer({} as PluginRuntimeRequest, new AbortController().signal),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    const sending = yield* hooks
      .beforeDispatch(message("Ship it"), notAccepted)
      .pipe(Effect.forkChild({ startImmediately: true }));
    const commanding = yield* hooks
      .beforeDispatch(message("/late now"), notAccepted)
      .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
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
  }).pipe(Effect.provide(PluginHooks.layer)),
);
