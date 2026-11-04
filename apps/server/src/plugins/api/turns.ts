import type {
  PluginApi,
  PluginBeforeDispatchResult,
  PluginCompletedRun,
  PluginStoredEvent,
} from "@t3tools/plugin-sdk/server";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as PluginHooks from "../PluginHooks.ts";
import { type FacadeContext, PluginCodeError } from "./facade.ts";
import type { RuntimeRequestHooks } from "./runtimeRequests.ts";

/** T3 keeps its own records in a plugin's storage under this prefix, out of the plugin's reach. */
export const T3_STORAGE_PREFIX = "t3.";

// A hook sits on the send path of every message, so it gets a short deadline and fails open.
const BEFORE_DISPATCH_DEADLINE = Duration.seconds(2);
const MAX_APPENDED_CHARS = 20_000;
const MAX_BLOCK_REASON_CHARS = 500;

/** What a hook's result does to `text`; anything unrecognised leaves it alone. */
const dispatchOutcome = (text: string, result: PluginBeforeDispatchResult, pluginName: string) => {
  if (typeof result !== "object" || result === null) return undefined;
  if ("block" in result && typeof result.block === "string") {
    return {
      block: result.block.trim().slice(0, MAX_BLOCK_REASON_CHARS) || "Blocked this message.",
      pluginName,
    };
  }
  if ("text" in result && typeof result.text === "string" && result.text.trim().length > 0) {
    return { text: result.text };
  }
  if (
    "appendText" in result &&
    typeof result.appendText === "string" &&
    result.appendText.trim().length > 0
  ) {
    return { text: `${text}\n\n${result.appendText.slice(0, MAX_APPENDED_CHARS)}` };
  }
  return undefined;
};

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Ended runs remembered with the cursor: a run can be updated again after it ends (a checkpoint
// lands on an interrupted run), and those later updates must not deliver it twice.
const REMEMBERED_RUNS = 256;
// Marks a remembered run whose rollback was delivered: a revert rolls back a run plugins already
// heard end, and they hear of it once more.
const ROLLED_BACK_SUFFIX = "#rolled_back";
const RESUME_DELAY_MS = 1000;

interface RunCursor {
  readonly sequence: number;
  readonly runIds: ReadonlyArray<string>;
}

const readCursor = (saved: unknown): RunCursor | undefined => {
  if (typeof saved === "number") return { sequence: saved, runIds: [] };
  if (!isJsonObject(saved) || typeof saved.sequence !== "number") return undefined;
  const runIds = Array.isArray(saved.runIds)
    ? saved.runIds.filter((id): id is string => typeof id === "string")
    : [];
  return { sequence: saved.sequence, runIds };
};

export const makeTurnsApi = (
  facade: FacadeContext,
  services: {
    readonly hooks: PluginHooks.PluginHooksRegistry;
    readonly runtimeRequests: RuntimeRequestHooks;
  },
  api: {
    readonly storage: Pick<PluginApi["storage"], "get" | "set">;
    /** Every `run.updated` event after `afterSequence`; never drops events. */
    readonly runEvents: (afterSequence: number) => AsyncIterable<PluginStoredEvent>;
    /** The newest stored thread event's sequence, where reading from now starts. */
    readonly latestSequence: () => Promise<number>;
    /** Shown with a block reason, so the sender knows which plugin stopped the message. */
    readonly pluginName: string;
  },
): PluginApi["turns"] => {
  let runHandlers = 0;
  return {
    afterRunCompleted: (handler) => {
      const { activation, pluginId } = facade;
      if (activation.controller.signal.aborted) {
        throw new Error("This plugin activation has ended.");
      }
      runHandlers += 1;
      const cursorKey = `${T3_STORAGE_PREFIX}turns.afterRunCompleted.${runHandlers}`;
      void (async () => {
        let sequence: number | undefined;
        let handled: Set<string> | undefined;
        // The stream can end with an error when the reader falls far behind; resume from the
        // saved position instead of going quiet until the plugin restarts.
        while (!activation.controller.signal.aborted) {
          try {
            if (handled === undefined) {
              const cursor = readCursor(await api.storage.get(cursorKey));
              sequence = cursor?.sequence;
              handled = new Set(cursor?.runIds ?? []);
            }
            if (sequence === undefined) {
              // Saved before any run ends, so runs that end while the plugin is off arrive when
              // it starts again, even if it never handled one.
              sequence = await api.latestSequence();
              await api.storage.set(cursorKey, { sequence, runIds: [] });
            }
            for await (const stored of api.runEvents(sequence)) {
              const run = stored.event.payload;
              if (!isJsonObject(run) || typeof run.status !== "string") continue;
              const runId = String(run.id);
              // A retry restarts the same run, which then ends again.
              if (!TERMINAL_RUN_STATUSES.has(run.status)) {
                handled.delete(runId);
                handled.delete(`${runId}${ROLLED_BACK_SUFFIX}`);
                continue;
              }
              const key = run.status === "rolled_back" ? `${runId}${ROLLED_BACK_SUFFIX}` : runId;
              if (handled.has(key)) continue;
              try {
                await handler({
                  runId,
                  threadId: String(run.threadId),
                  status: run.status,
                  run: stored.event.payload as PluginCompletedRun["run"],
                });
              } catch (error) {
                facade.reportFailure(error);
              }
              handled.add(key);
              const [oldest] = handled;
              if (handled.size > REMEMBERED_RUNS && oldest !== undefined) handled.delete(oldest);
              sequence = stored.sequence;
              await api.storage.set(cursorKey, { sequence, runIds: [...handled] });
            }
            return;
          } catch (error) {
            Effect.runForkWith(facade.context)(
              Effect.logWarning("plugin afterRunCompleted stream failed; resuming", {
                pluginId,
                failure: String(error).slice(0, 500),
              }),
            );
            await Effect.runPromiseWith(facade.context)(Effect.sleep(RESUME_DELAY_MS));
          }
        }
      })().catch((error) =>
        Effect.runForkWith(facade.context)(
          Effect.logWarning("plugin afterRunCompleted stopped", {
            pluginId,
            failure: String(error).slice(0, 500),
          }),
        ),
      );
    },
    onRuntimeRequest: (handler) => {
      const { activation, pluginId } = facade;
      const deactivated = activation.controller.signal;
      if (deactivated.aborted) throw new Error("This plugin activation has ended.");
      const remove = services.runtimeRequests.add({
        pluginId,
        // A plugin turned off while it decided no longer speaks for the user.
        answer: (request, signal) =>
          deactivated.aborted
            ? Promise.resolve(undefined)
            : facade
                .asPlugin(() =>
                  Promise.resolve().then(() =>
                    handler(request, { signal: AbortSignal.any([signal, deactivated]) }),
                  ),
                )
                .then(
                  (answer) => (deactivated.aborted ? undefined : answer),
                  // No answer leaves the request to the user.
                  (error: unknown) => {
                    facade.reportFailure(error);
                    return undefined;
                  },
                ),
      });
      deactivated.addEventListener("abort", remove, { once: true });
    },
    beforeDispatch: (hook) => {
      const { activation, pluginId } = facade;
      if (activation.controller.signal.aborted) {
        throw new Error("This plugin activation has ended.");
      }
      const remove = Effect.runSyncWith(facade.context)(
        services.hooks.addBeforeDispatch(pluginId, (message) =>
          activation.controller.signal.aborted
            ? Effect.sync(() => undefined)
            : Effect.tryPromise({
                try: () =>
                  facade.asPlugin(() =>
                    Promise.resolve().then(() =>
                      hook({
                        threadId: message.threadId,
                        messageId: message.messageId,
                        text: message.text,
                        createdBy: message.createdBy,
                        creationSource: message.creationSource,
                        attachments: message.attachments,
                        ...(message.model === undefined ? {} : { model: message.model }),
                      }),
                    ),
                  ),
                catch: (cause) => new PluginCodeError({ cause }),
              }).pipe(
                Effect.timeoutOption(BEFORE_DISPATCH_DEADLINE),
                Effect.map(
                  Option.match({
                    onNone: () => undefined,
                    onSome: (result) =>
                      activation.controller.signal.aborted
                        ? undefined
                        : dispatchOutcome(message.text, result, api.pluginName),
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.sync(() => {
                    facade.reportFailure(Cause.squash(cause));
                    return undefined;
                  }),
                ),
              ),
        ),
      );
      activation.controller.signal.addEventListener(
        "abort",
        () => Effect.runForkWith(facade.context)(remove),
        { once: true },
      );
    },
  };
};
