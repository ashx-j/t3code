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

/**
 * Hooks over a pending deploy approval. `subscribe` makes each subscription to the event stream,
 * and `respond` decides whether the server accepts each answer.
 */
const harness = Effect.fn(function* (options: {
  readonly subscribe: (
    events: Queue.Queue<OrchestrationV2DomainEvent>,
  ) => Stream.Stream<OrchestrationV2DomainEvent, Orchestrator.OrchestratorV2Error>;
  readonly respond?: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
}) {
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const responded = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
  const orchestrator = yield* Effect.provide(
    Orchestrator.OrchestratorV2,
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.suspend(() => options.subscribe(events)),
      getThreadRecords: () =>
        Effect.succeed({ runtimeRequests: [request], turnItems: [item] } as never),
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
  it.effect("asks hooks in order, skips one past its deadline or with an unfit answer", () =>
    Effect.gen(function* () {
      const { events, responded, asked, hook } = yield* harness({ subscribe: Stream.fromQueue });
      const hangs = Promise.withResolvers<void>();
      hook("hangs", () => {
        hangs.resolve();
        return new Promise(() => undefined);
      });
      // Not one of the decisions this request offers.
      hook("unfit", async () => ({ decision: "acceptAlways" }));
      hook("answers", async () => ({ decision: "accept" }));
      hook("never-asked", async () => ({ decision: "decline" }));

      yield* Queue.offer(events, pending);
      yield* Effect.promise(() => hangs.promise);
      yield* TestClock.adjust("10 seconds");

      assert.deepInclude(yield* Queue.take(responded), accepted("accept"));
      assert.deepStrictEqual(asked, ["hangs", "unfit", "answers"]);
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
