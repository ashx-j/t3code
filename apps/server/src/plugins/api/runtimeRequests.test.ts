import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  PluginId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
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
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import { makeRuntimeRequestHooks } from "./runtimeRequests.ts";

const threadId = ThreadId.make("thread:runtime-requests");

it.effect("asks hooks in order, skips one past its deadline or with an unfit answer", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const responded = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
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
    const services = Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamStoredEventsFrom: (input) =>
          input?.eventType === "runtime-request.updated" ? Stream.fromQueue(events) : Stream.never,
        getThreadRecords: () =>
          Effect.succeed({ runtimeRequests: [request], turnItems: [item] } as never),
      }),
      Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
        latestAgentSequence: () => Effect.succeed(0),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        dispatch: (command) =>
          Queue.offer(responded, command).pipe(Effect.as({ sequence: 1 } as never)),
      }),
    );
    yield* Effect.gen(function* () {
      const hooks = makeRuntimeRequestHooks({
        context: yield* Effect.context<never>(),
        orchestrator: yield* Orchestrator.OrchestratorV2,
        eventStore: yield* OrchestrationEventStore.OrchestrationEventStore,
        threads: yield* ThreadManagementService.ThreadManagementService,
        crypto: yield* Crypto.Crypto,
      });
      const asked: Array<string> = [];
      const hangs = Promise.withResolvers<void>();
      const hook = (name: string, answer: () => Promise<PluginRuntimeRequestAnswer>) =>
        hooks.add({
          pluginId: PluginId.make(name),
          answer: () => {
            asked.push(name);
            return answer();
          },
        });
      hook("hangs", () => {
        hangs.resolve();
        return new Promise(() => undefined);
      });
      // Not one of the decisions this request offers.
      hook("unfit", async () => ({ decision: "acceptAlways" }));
      hook("answers", async () => ({ decision: "accept" }));
      hook("never-asked", async () => ({ decision: "decline" }));

      yield* Queue.offer(events, {
        sequence: 1,
        event: { type: "runtime-request.updated", threadId, payload: request },
      } as never);
      yield* Effect.promise(() => hangs.promise);
      yield* TestClock.adjust("10 seconds");

      assert.deepInclude(yield* Queue.take(responded), {
        type: "runtime-request.respond",
        threadId,
        requestId: RuntimeRequestId.make("request:deploy"),
        decision: "accept",
      });
      assert.deepStrictEqual(asked, ["hangs", "unfit", "answers"]);
    }).pipe(Effect.provide(services));
  }).pipe(Effect.provide(NodeServices.layer)),
);
