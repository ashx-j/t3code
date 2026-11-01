import { ScheduledTaskSchedule } from "@t3tools/contracts";
import type { PluginApi } from "@t3tools/plugin-sdk/server";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { nextScheduledRunAt } from "../../scheduledTasks/Schedule.ts";
import type { FacadeContext } from "./facade.ts";

const MIN_INTERVAL_MS = 1000;
const decodeSchedule = Schema.decodeUnknownOption(ScheduledTaskSchedule);
const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

export const makeScheduleApi = (facade: FacadeContext): PluginApi["schedule"] => {
  const ensureActive = () => {
    if (facade.activation.controller.signal.aborted) {
      throw new Error("This plugin activation has ended.");
    }
  };
  // Waits, runs the handler, and repeats. Runs never overlap: the next wait starts when a run finishes.
  const start = (wait: Effect.Effect<void>, handler: () => void | Promise<void>) => {
    const tick = Effect.tryPromise(() => Promise.resolve().then(handler)).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("plugin scheduled work failed", {
          pluginId: facade.pluginId,
          failure: String(cause).slice(0, 500),
        }),
      ),
    );
    const fiber = Effect.runForkWith(facade.context)(
      wait.pipe(Effect.andThen(tick), Effect.forever),
    );
    const cancel = () => {
      Effect.runForkWith(facade.context)(Fiber.interrupt(fiber));
    };
    // Abort runs before cleanups, so a hung cleanup cannot keep a disabled plugin's timer alive.
    facade.activation.controller.signal.addEventListener("abort", cancel, { once: true });
    return cancel;
  };
  return {
    every: (everyMs, handler) => {
      ensureActive();
      if (!Number.isFinite(everyMs) || everyMs < MIN_INTERVAL_MS) {
        throw new RangeError(`schedule.every needs an interval of at least ${MIN_INTERVAL_MS} ms.`);
      }
      return start(Effect.sleep(Duration.millis(everyMs)), handler);
    },
    at: (when, handler) => {
      ensureActive();
      // The same times and weekdays scheduled tasks accept, computed the same way.
      const schedule = decodeSchedule({
        type: "fixed_time",
        timeOfDay: when.time,
        ...(when.weekdays === undefined ? {} : { weekdays: when.weekdays }),
      });
      if (Option.isNone(schedule)) {
        throw new RangeError(
          "schedule.at needs a time such as 09:30 and weekdays from 0 (Sunday) to 6 (Saturday).",
        );
      }
      const untilNextRun = localNow.pipe(
        Effect.flatMap((now) => {
          const next = nextScheduledRunAt(schedule.value, now);
          return next === null
            ? Effect.never
            : Effect.sleep(
                Duration.millis(DateTime.toEpochMillis(next) - DateTime.toEpochMillis(now)),
              );
        }),
      );
      return start(untilNextRun, handler);
    },
  };
};
