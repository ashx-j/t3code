import { OrchestrationV2DomainEvent, type OrchestrationV2StoredEvent } from "@t3tools/contracts";
import type { PluginApi, PluginStoredEvent } from "@t3tools/plugin-sdk/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import type * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import type { FacadeContext } from "./facade.ts";

// A plugin that stops reading must not hold back event delivery for the rest of the server.
const PLUGIN_EVENT_BUFFER = 1024;

const encodeEvent = Schema.encodeUnknownSync(Schema.toCodecJson(OrchestrationV2DomainEvent));
const isJsonObject = Schema.is(Schema.JsonObject);

const toPluginEvent = (stored: OrchestrationV2StoredEvent): PluginStoredEvent => {
  const event = encodeEvent(stored.event);
  return {
    sequence: stored.sequence,
    type: stored.event.type,
    event: isJsonObject(event) ? event : {},
  };
};

export const makeEventsApi = (
  facade: FacadeContext,
  services: {
    readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
    readonly eventStore: OrchestrationEventStore.OrchestrationEventStore["Service"];
  },
): PluginApi["events"] => ({
  stored: (options) => {
    if (
      options.afterSequence !== undefined &&
      (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0)
    ) {
      throw new RangeError("afterSequence must be a whole number of 0 or more.");
    }
    const types = new Set(options.types);
    const [onlyType] = types;
    const start =
      options.afterSequence === undefined
        ? services.eventStore.latestAgentSequence()
        : Effect.succeed(options.afterSequence);
    // One type is filtered by the event sink before anything is decoded for the plugin. Several
    // types share one unfiltered stream, so events still arrive in sequence order.
    const stream = Stream.unwrap(
      start.pipe(
        Effect.map((afterSequence) =>
          types.size === 1 && onlyType !== undefined
            ? services.orchestrator.streamStoredEventsFrom({
                afterSequence,
                // An unknown type matches no stored event.
                eventType: onlyType as OrchestrationV2DomainEvent["type"],
              })
            : services.orchestrator
                .streamStoredEventsFrom({ afterSequence })
                .pipe(Stream.filter((stored) => types.has(stored.event.type))),
        ),
      ),
    ).pipe(
      Stream.map(toPluginEvent),
      Stream.buffer({ capacity: PLUGIN_EVENT_BUFFER, strategy: "sliding" }),
    );
    return facade.iterate(stream, options.signal);
  },
});
