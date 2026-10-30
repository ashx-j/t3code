import type { PluginApi } from "@t3tools/plugin-sdk/server";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import type { FacadeContext } from "./facade.ts";

const MIN_INTERVAL_MS = 1000;

export const makeScheduleApi = (facade: FacadeContext): PluginApi["schedule"] => ({
  every: (everyMs, handler) => {
    if (facade.activation.controller.signal.aborted) {
      throw new Error("This plugin activation has ended.");
    }
    if (!Number.isFinite(everyMs) || everyMs < MIN_INTERVAL_MS) {
      throw new RangeError(`schedule.every needs an interval of at least ${MIN_INTERVAL_MS} ms.`);
    }
    // Runs never overlap: the next wait starts when a run finishes.
    const tick = Effect.tryPromise(() => Promise.resolve().then(handler)).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("plugin scheduled work failed", {
          pluginId: facade.pluginId,
          failure: String(cause).slice(0, 500),
        }),
      ),
    );
    const fiber = Effect.runForkWith(facade.context)(
      Effect.sleep(Duration.millis(everyMs)).pipe(Effect.andThen(tick), Effect.forever),
    );
    const cancel = () => {
      Effect.runForkWith(facade.context)(Fiber.interrupt(fiber));
    };
    // Abort runs before cleanups, so a hung cleanup cannot keep a disabled plugin's timer alive.
    facade.activation.controller.signal.addEventListener("abort", cancel, { once: true });
    return cancel;
  },
});
