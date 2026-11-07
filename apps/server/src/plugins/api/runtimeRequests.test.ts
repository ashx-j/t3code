import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  PluginId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import type { PluginRuntimeRequestAnswer } from "@t3tools/plugin-sdk/server";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { makeRuntimeRequestHooks } from "./runtimeRequests.ts";

const threadId = ThreadId.make("thread:runtime-requests");
const request = {
  id: "request:deploy",
  nodeId: "node:deploy",
  kind: "command",
  status: "pending",
  responseCapability: { type: "live", providerSessionId: "session:deploy" },
};
const item = {
  id: "item:deploy",
  threadId,
  runId: "run:deploy",
  type: "approval_request",
  requestId: "request:deploy",
  requestKind: "command",
  prompt: "./deploy.sh",
  status: "waiting",
  options: [
    { decision: "accept", label: "Approve" },
    { decision: "decline", label: "Decline" },
  ],
};
const pending = {
  type: "runtime-request.updated",
  threadId,
  payload: request,
} as unknown as OrchestrationV2DomainEvent;
const accepted = (decision: "accept" | "decline") => ({
  type: "runtime-request.respond" as const,
  threadId,
  requestId: RuntimeRequestId.make("request:deploy"),
  decision,
});

const itemUpdated = {
  type: "turn-item.updated",
  threadId,
  payload: item,
} as unknown as OrchestrationV2DomainEvent;

/**
 * Hooks over a pending deploy approval. `subscribe` makes each subscription to the event stream,
 * `respond` decides whether the server accepts each answer, `waiting` lists the request's thread
 * among the live ones before any event names it, and `records` is what the thread has recorded
 * when the hooks read it, the request and its item by default.
 */
const harness = Effect.fn(function* (options: {
  readonly subscribe: (
    events: Queue.Queue<OrchestrationV2DomainEvent>,
  ) => Stream.Stream<OrchestrationV2DomainEvent, Orchestrator.OrchestratorV2Error>;
  readonly respond?: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
  readonly waiting?: boolean;
  readonly records?: () => {
    readonly runtimeRequests: ReadonlyArray<object>;
    readonly turnItems: ReadonlyArray<object>;
  };
}) {
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const responded = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
  const orchestrator = yield* Effect.provide(
    Orchestrator.OrchestratorV2,
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.suspend(() => options.subscribe(events)),
      listActiveShellIndex: () =>
        Effect.succeed(
          options.waiting === true ? [{ id: threadId, mayBeLive: true } as never] : [],
        ),
      getThreadRecords: () =>
        Effect.sync(
          () => (options.records?.() ?? { runtimeRequests: [request], turnItems: [item] }) as never,
        ),
    }),
  );
  const threads = yield* Effect.provide(
    ThreadManagementService.ThreadManagementService,
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      dispatch: (command) =>
        (options.respond?.(command) ?? Effect.void).pipe(
          Effect.andThen(Queue.offer(responded, command)),
          Effect.as({ sequence: 1 } as never),
        ),
    }),
  );
  const hooks = makeRuntimeRequestHooks({
    context: yield* Effect.context<never>(),
    orchestrator,
    threads,
    crypto: yield* Crypto.Crypto,
  });
  const asked: Array<string> = [];
  const hook = (name: string, answer: () => Promise<PluginRuntimeRequestAnswer>) =>
    hooks.add({
      pluginId: PluginId.make(name),
      answer: () => {
        asked.push(name);
        return answer();
      },
    });
  return { events, responded, asked, hook };
});

it.layer(NodeServices.layer)("runtime request hooks", (it) => {
  it.effect(
    "asks hooks in plugin id order, skips one past its deadline or with an unfit answer",
    () =>
      Effect.gen(function* () {
        const { events, responded, asked, hook } = yield* harness({ subscribe: Stream.fromQueue });
        // Registered out of id order, as plugins that finish starting in another order would.
        hook("d-never-asked", async () => ({ decision: "decline" }));
        hook("c-answers", async () => ({ decision: "accept" }));
        const hangs = Promise.withResolvers<void>();
        hook("a-hangs", () => {
          hangs.resolve();
          return new Promise(() => undefined);
        });
        // Not one of the decisions this request offers.
        hook("b-unfit", async () => ({ decision: "acceptAlways" }));

        yield* Queue.offer(events, pending);
        yield* Effect.promise(() => hangs.promise);
        yield* TestClock.adjust("10 seconds");

        assert.deepInclude(yield* Queue.take(responded), accepted("accept"));
        assert.deepStrictEqual(asked, ["a-hangs", "b-unfit", "c-answers"]);
      }),
  );

  it.effect("asks the next hook when the server refuses an answer to a pending request", () =>
    Effect.gen(function* () {
      const { events, responded, asked, hook } = yield* harness({
        subscribe: Stream.fromQueue,
        respond: (command) =>
          command.type === "runtime-request.respond" && command.decision === "accept"
            ? Effect.fail(
                new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "Refused.",
                }),
              )
            : Effect.void,
      });
      hook("a-refused", async () => ({ decision: "accept" }));
      hook("b-declines", async () => ({ decision: "decline" }));

      yield* Queue.offer(events, pending);
      assert.deepInclude(yield* Queue.take(responded), accepted("decline"));
      assert.deepStrictEqual(asked, ["a-refused", "b-declines"]);
    }),
  );

  it.effect("asks about a request that was already pending when the first hook arrived", () =>
    Effect.gen(function* () {
      // Such as one raised while the only plugin with a hook reloaded.
      const { responded, hook } = yield* harness({ subscribe: Stream.fromQueue, waiting: true });
      hook("answers", async () => ({ decision: "accept" }));
      assert.deepInclude(yield* Queue.take(responded), accepted("accept"));
    }),
  );

  it.effect("asks once the request and its turn item are both recorded, in either order", () =>
    Effect.gen(function* () {
      // Claude records the request before its item.
      let records: { runtimeRequests: Array<object>; turnItems: Array<object> } = {
        runtimeRequests: [request],
        turnItems: [],
      };
      const requestFirst = yield* harness({ subscribe: Stream.fromQueue, records: () => records });
      requestFirst.hook("answers", async () => ({ decision: "accept" }));
      yield* Queue.offer(requestFirst.events, pending);
      records = { runtimeRequests: [request], turnItems: [item] };
      yield* Queue.offer(requestFirst.events, itemUpdated);
      assert.deepInclude(yield* Queue.take(requestFirst.responded), accepted("accept"));

      // Codex records the item first, for a request that takes feedback.
      records = { runtimeRequests: [], turnItems: [item] };
      const itemFirst = yield* harness({ subscribe: Stream.fromQueue, records: () => records });
      itemFirst.hook("answers", async () => ({ decision: "decline", feedback: "Not today." }));
      yield* Queue.offer(itemFirst.events, itemUpdated);
      records = {
        runtimeRequests: [
          {
            ...request,
            responseCapability: { ...request.responseCapability, supportsFeedback: true },
          },
        ],
        turnItems: [item],
      };
      yield* Queue.offer(itemFirst.events, pending);
      assert.deepInclude(yield* Queue.take(itemFirst.responded), {
        ...accepted("decline"),
        feedback: "Not today.",
      });
    }),
  );

  it.effect("answers a question with the options the plugin picks", () =>
    Effect.gen(function* () {
      const question = {
        ...item,
        type: "user_input_request",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which files?",
            options: [
              { label: "Only src", description: "Leave tests alone" },
              { label: "Everything", description: "Touch all files" },
            ],
          },
        ],
      };
      const { events, responded, hook } = yield* harness({
        subscribe: Stream.fromQueue,
        records: () => ({
          runtimeRequests: [{ ...request, kind: "user_input" }],
          turnItems: [question],
        }),
      });
      hook("answers", async () => ({ answers: { scope: "Only src" } }));
      yield* Queue.offer(events, pending);
      assert.deepInclude(yield* Queue.take(responded), {
        type: "runtime-request.respond",
        requestId: RuntimeRequestId.make("request:deploy"),
        answers: { scope: "Only src" },
      });
    }),
  );

  it.effect("keeps answering after its event stream fails", () =>
    Effect.gen(function* () {
      let subscriptions = 0;
      const { events, responded, hook } = yield* harness({
        subscribe: (queue) => {
          subscriptions += 1;
          return subscriptions === 1
            ? Stream.fail(new Orchestrator.OrchestratorDomainEventStreamError({}))
            : Stream.fromQueue(queue);
        },
      });
      hook("answers", async () => ({ decision: "accept" }));

      yield* TestClock.adjust("1 second");
      yield* Queue.offer(events, pending);
      assert.deepInclude(yield* Queue.take(responded), accepted("accept"));
      assert.strictEqual(subscriptions, 2);
    }),
  );
});
