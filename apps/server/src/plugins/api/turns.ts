import type {
  PluginApi,
  PluginBeforeDispatchResult,
  PluginCompletedRun,
} from "@t3tools/plugin-sdk/server";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as PluginHooks from "../PluginHooks.ts";
import type { FacadeContext } from "./facade.ts";

// A hook sits on the send path of every message, so it gets a short deadline and fails open.
const BEFORE_DISPATCH_DEADLINE = Duration.seconds(2);
const MAX_APPENDED_CHARS = 20_000;

const appendedText = (result: PluginBeforeDispatchResult) =>
  typeof result === "object" &&
  result !== null &&
  "appendText" in result &&
  typeof result.appendText === "string" &&
  result.appendText.trim().length > 0
    ? result.appendText.slice(0, MAX_APPENDED_CHARS)
    : undefined;

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const makeTurnsApi = (
  facade: FacadeContext,
  services: { readonly hooks: PluginHooks.PluginHooksRegistry },
  api: Pick<PluginApi, "events" | "storage">,
): PluginApi["turns"] => {
  let runHandlers = 0;
  return {
    afterRunCompleted: (handler) => {
      const { activation, pluginId } = facade;
      if (activation.controller.signal.aborted) {
        throw new Error("This plugin activation has ended.");
      }
      runHandlers += 1;
      const cursorKey = `t3.turns.afterRunCompleted.${runHandlers}`;
      void (async () => {
        const saved = await api.storage.get(cursorKey);
        const events = api.events.stored({
          types: ["run.updated"],
          ...(typeof saved === "number" ? { afterSequence: saved } : {}),
        });
        for await (const stored of events) {
          const run = stored.event.payload;
          if (!isJsonObject(run) || typeof run.status !== "string") continue;
          if (!TERMINAL_RUN_STATUSES.has(run.status)) continue;
          try {
            await handler({
              runId: String(run.id),
              threadId: String(run.threadId),
              status: run.status,
              run: stored.event.payload as PluginCompletedRun["run"],
            });
          } catch (error) {
            Effect.runForkWith(facade.context)(
              Effect.logWarning("plugin afterRunCompleted handler failed", {
                pluginId,
                failure: String(error).slice(0, 500),
              }),
            );
          }
          await api.storage.set(cursorKey, stored.sequence);
        }
      })().catch(() => undefined);
    },
    beforeDispatch: (hook) => {
      const { activation, pluginId } = facade;
      if (activation.controller.signal.aborted) {
        throw new Error("This plugin activation has ended.");
      }
      const remove = Effect.runSyncWith(facade.context)(
        services.hooks.addBeforeDispatch((message) =>
          activation.controller.signal.aborted
            ? Effect.sync(() => undefined)
            : Effect.tryPromise(() =>
                Promise.resolve().then(() =>
                  hook({
                    threadId: message.threadId,
                    messageId: message.messageId,
                    text: message.text,
                    createdBy: message.createdBy,
                    attachments: message.attachments,
                    ...(message.model === undefined ? {} : { model: message.model }),
                  }),
                ),
              ).pipe(
                Effect.timeoutOption(BEFORE_DISPATCH_DEADLINE),
                Effect.map(Option.match({ onNone: () => undefined, onSome: appendedText })),
                Effect.catchCause((cause) =>
                  Effect.logWarning("plugin beforeDispatch hook failed", {
                    pluginId,
                    failure: String(cause).slice(0, 500),
                  }).pipe(Effect.as(undefined)),
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
