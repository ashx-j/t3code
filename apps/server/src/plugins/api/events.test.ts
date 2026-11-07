import { assert, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationV2DomainEvent,
  PluginId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import type * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import { makePluginActivation, type PluginPublication } from "../PluginApi.ts";
import { makeEventsApi } from "./events.ts";
import { makeFacadeContext } from "./facade.ts";

it.effect("gives a plugin resuming from an old sequence every event stored since", () =>
  Effect.gen(function* () {
    const event: OrchestrationV2DomainEvent = {
      type: "run.background-work-cancelled",
      id: EventId.make("event:cancelled"),
      threadId: ThreadId.make("thread:events"),
      occurredAt: DateTime.makeUnsafe(0),
      payload: { runId: RunId.make("run:events"), restartCancelledBackgroundWork: [] },
    };
    const stored = Array.from({ length: 3000 }, (_, index) => ({
      sequence: index + 1,
      commandId: null,
      event,
    }));
    const after = (afterSequence: number | undefined, throughSequence = Infinity) =>
      Stream.fromIterable(
        stored.filter(
          ({ sequence }) => sequence > (afterSequence ?? 0) && sequence <= throughSequence,
        ),
      );
    // Both hand over the whole backlog in one chunk, faster than any plugin reads it.
    const services = {
      orchestrator: {
        streamStoredEventsFrom: (input) => after(input?.afterSequence),
      } as Pick<
        Orchestrator.OrchestratorV2["Service"],
        "streamStoredEventsFrom"
      > as Orchestrator.OrchestratorV2["Service"],
      eventStore: {
        latestAgentSequence: () => Effect.succeed(stored.length),
        readAgentEvents: (input) => after(input?.afterSequence, input?.throughSequence),
      } as Pick<
        OrchestrationEventStore.OrchestrationEventStore["Service"],
        "latestAgentSequence" | "readAgentEvents"
      > as OrchestrationEventStore.OrchestrationEventStore["Service"],
    };
    const facade = makeFacadeContext({
      pluginId: PluginId.make("events"),
      activation: makePluginActivation(yield* PubSub.sliding<PluginPublication>(1)),
      context: yield* Effect.context<never>(),
    });

    const sequences = yield* Effect.promise(() =>
      Array.fromAsync(
        makeEventsApi(facade, services).stored({
          types: ["run.background-work-cancelled"],
          afterSequence: 0,
        }),
        (event) => event.sequence,
      ),
    );
    assert.strictEqual(sequences.length, stored.length);
    assert.strictEqual(sequences.at(-1), stored.length);
  }),
);
