import type { PluginId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { errorText } from "./api/facade.ts";

// Clients send web failures, so they are bounded like plugin errors.
const MAX_WEB_FAILURE_CHARS = 1_000;
// A plugin's failures outside a call reach clients at most this often, the latest one last, so a
// timer failing every few milliseconds with new text does not resend the list each time.
const FAILURE_PUBLISH_INTERVAL = Duration.seconds(5);

interface Failure<Revision> {
  readonly revision: Revision;
  readonly message: string;
}

const messageFor = <Revision>(
  failure: Failure<Revision> | undefined,
  revision: number | undefined,
) => (failure !== undefined && failure.revision === revision ? failure.message : undefined);

/**
 * Builds the host's record of the failures a plugin's row shows: web failures clients report and
 * server code failing outside a call. Each belongs to the start, the revision, it happened in.
 */
export const makePluginFailures = Effect.gen(function* () {
  // By plugin id, for the start it was reported for: a new start's revision hides the old one.
  const webFailures = yield* Ref.make<ReadonlyMap<PluginId, Failure<number>>>(new Map());
  // Like web failures. A stopped plugin's leftover timers fail with no revision.
  const serverFailures = yield* Ref.make<ReadonlyMap<PluginId, Failure<number | undefined>>>(
    new Map(),
  );
  // When each plugin's failure was last published, and the plugins whose next one is waiting.
  const publishedAt = new Map<PluginId, number>();
  const waiting = new Set<PluginId>();

  return {
    /** Looks up a plugin's failures for the start `revision`. */
    current: Effect.gen(function* () {
      const web = yield* Ref.get(webFailures);
      const server = yield* Ref.get(serverFailures);
      return (pluginId: PluginId, revision: number | undefined) => ({
        web: messageFor(web.get(pluginId), revision),
        server: messageFor(server.get(pluginId), revision),
      });
    }),
    /** Keeps the latest web failure a client reported for the start `revision`. */
    reportWeb: (pluginId: PluginId, revision: number, message: string) =>
      Ref.update(webFailures, (all) =>
        new Map(all).set(pluginId, { revision, message: message.slice(0, MAX_WEB_FAILURE_CHARS) }),
      ),
    /**
     * Records a failure of the start `revision` outside a call, then succeeds with whether to
     * publish: a timer that fails every second with the same text logs and publishes once.
     * Untraced: a plugin's timer can fail every few milliseconds.
     */
    recordServer: Effect.fnUntraced(function* (
      pluginId: PluginId,
      revision: number | undefined,
      error: unknown,
    ) {
      const message = errorText(error);
      const known = (yield* Ref.get(serverFailures)).get(pluginId);
      if (known?.revision === revision && known?.message === message) return false;
      yield* Ref.update(serverFailures, (all) => new Map(all).set(pluginId, { revision, message }));
      if (waiting.has(pluginId)) return false;
      const last = publishedAt.get(pluginId);
      const wait =
        last === undefined
          ? 0
          : last + Duration.toMillis(FAILURE_PUBLISH_INTERVAL) - (yield* Clock.currentTimeMillis);
      if (wait > 0) {
        waiting.add(pluginId);
        yield* Effect.sleep(Duration.millis(wait)).pipe(
          Effect.ensuring(Effect.sync(() => waiting.delete(pluginId))),
        );
      }
      publishedAt.set(pluginId, yield* Clock.currentTimeMillis);
      yield* Effect.logWarning("plugin code failed outside a call", {
        pluginId,
        reason: (yield* Ref.get(serverFailures)).get(pluginId)?.message ?? message,
      });
      return true;
    }),
    /** Forgets the plugin's server failures, as a stop does. */
    clearServer: (pluginId: PluginId) =>
      Ref.update(serverFailures, (all) => {
        const next = new Map(all);
        next.delete(pluginId);
        return next;
      }),
  };
});

export type PluginFailures = Effect.Success<typeof makePluginFailures>;
