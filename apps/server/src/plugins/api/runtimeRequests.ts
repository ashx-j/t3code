import {
  CommandId,
  ProviderApprovalDecision,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type PluginId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import type {
  PluginApprovalDecision,
  PluginRuntimeRequest,
  PluginRuntimeRequestAnswer,
} from "@t3tools/plugin-sdk/server";
import type * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import type * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";

// The user sees the request the whole time and may answer first, so a plugin gets a short window.
const RUNTIME_REQUEST_DEADLINE = Duration.seconds(10);
// Requests the reactor has asked about, kept until they resolve; bounded for ones that never do.
const MAX_TRACKED_REQUESTS = 1024;
// What the clients offer when a provider lists no options.
const DEFAULT_DECISIONS: ReadonlyArray<PluginApprovalDecision> = [
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
];

const isDecision = Schema.is(ProviderApprovalDecision);
const isAnswers = Schema.is(
  Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])),
);

type RequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "approval_request" | "user_input_request" }
>;

export interface RuntimeRequestHook {
  readonly pluginId: PluginId;
  /** Resolves with the plugin's answer; the registry bounds it and treats a rejection as no answer. */
  readonly answer: (
    request: PluginRuntimeRequest,
    signal: AbortSignal,
  ) => Promise<PluginRuntimeRequestAnswer>;
}

/** Shared by every plugin. Its reactor follows events only while at least one hook is registered. */
export interface RuntimeRequestHooks {
  /** Adds a hook after the existing ones and returns the function that removes it. */
  readonly add: (hook: RuntimeRequestHook) => () => void;
}

const toPluginRuntimeRequest = (
  request: OrchestrationV2RuntimeRequest,
  item: RequestItem,
): PluginRuntimeRequest =>
  item.type === "approval_request"
    ? {
        threadId: item.threadId,
        requestId: request.id,
        runId: item.runId,
        kind: item.requestKind,
        ...(item.prompt === undefined ? {} : { prompt: item.prompt }),
        ...(item.reason === undefined ? {} : { reason: item.reason }),
        ...(item.appName === undefined ? {} : { appName: item.appName }),
        decisions: item.options?.map((option) => option.decision) ?? DEFAULT_DECISIONS,
        canDeclineWithFeedback:
          request.responseCapability.type === "live" &&
          request.responseCapability.supportsFeedback === true,
        questions: [],
      }
    : {
        threadId: item.threadId,
        requestId: request.id,
        runId: item.runId,
        kind: "user_input",
        decisions: [],
        canDeclineWithFeedback: false,
        questions: item.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          options: question.options.map((option) => ({
            label: option.label,
            description: option.description,
          })),
          multiSelect: question.multiSelect === true,
          allowCustomAnswer: question.allowCustomAnswer === true,
        })),
      };

/** The respond command fields for an answer that fits the request, or nothing. */
const responseFor = (
  request: PluginRuntimeRequest,
  answer: PluginRuntimeRequestAnswer,
):
  | { readonly decision: PluginApprovalDecision; readonly feedback?: string }
  | { readonly answers: Readonly<Record<string, string | ReadonlyArray<string>>> }
  | undefined => {
  if (typeof answer !== "object" || answer === null) return undefined;
  if (request.kind === "user_input") {
    return "answers" in answer && isAnswers(answer.answers)
      ? { answers: answer.answers }
      : undefined;
  }
  if (!("decision" in answer) || !isDecision(answer.decision)) return undefined;
  if (!request.decisions.includes(answer.decision)) return undefined;
  // Providers take feedback only with a decline they can deliver live; elsewhere it is dropped.
  const feedback =
    answer.decision === "decline" &&
    request.canDeclineWithFeedback &&
    typeof answer.feedback === "string" &&
    answer.feedback.trim().length > 0
      ? answer.feedback
      : undefined;
  return feedback === undefined
    ? { decision: answer.decision }
    : { decision: answer.decision, feedback };
};

// Fewer requests than this are ever waiting at once; a backlog drops the oldest, not the server.
const CANDIDATE_BUFFER = 1024;
// The live event stream has no budget to overflow, so a failure is rare; this spaces out retries.
const RESTART_DELAY = Duration.seconds(1);

const candidateOf = (
  event: OrchestrationV2DomainEvent,
):
  | { readonly threadId: ThreadId; readonly requestId: RuntimeRequestId; readonly open: boolean }
  | undefined => {
  if (event.type === "runtime-request.updated") {
    return {
      threadId: event.threadId,
      requestId: event.payload.id,
      open: event.payload.status === "pending",
    };
  }
  if (
    event.type === "turn-item.updated" &&
    (event.payload.type === "approval_request" || event.payload.type === "user_input_request")
  ) {
    return {
      threadId: event.threadId,
      requestId: event.payload.requestId,
      open: event.payload.status === "waiting",
    };
  }
  return undefined;
};

/**
 * Asks plugins about approvals and questions an agent raises, in hook order, and sends the first
 * answer through `runtime-request.respond` like a client would. Adapters record the request and
 * its turn item in either order, so both events are watched and a request is asked about once
 * both exist. No answer leaves the request to the user, who sees it the whole time.
 */
export const makeRuntimeRequestHooks = (input: {
  readonly context: Context.Context<never>;
  readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
  readonly threads: ThreadManagementService.ThreadManagementService["Service"];
  readonly crypto: Crypto.Crypto;
}): RuntimeRequestHooks => {
  const { context, orchestrator, threads } = input;
  let hooks: ReadonlyArray<RuntimeRequestHook> = [];
  let reactor: Fiber.Fiber<void> | undefined;
  // Requests already asked about. Interrupting the asking fiber aborts the signal plugins hold.
  const tracked = new Map<RuntimeRequestId, Fiber.Fiber<void>>();

  const forget = (requestId: RuntimeRequestId) => {
    const asking = tracked.get(requestId);
    tracked.delete(requestId);
    return asking === undefined ? Effect.void : Fiber.interrupt(asking);
  };

  const ask = Effect.fnUntraced(function* (
    target: { readonly threadId: ThreadId; readonly requestId: RuntimeRequestId },
    request: PluginRuntimeRequest,
  ) {
    for (const hook of hooks) {
      const answer = yield* Effect.tryPromise((signal) => hook.answer(request, signal)).pipe(
        Effect.timeoutOption(RUNTIME_REQUEST_DEADLINE),
        Effect.map(Option.getOrUndefined),
        Effect.catchCause((cause) =>
          Effect.logWarning("plugin runtime request hook failed", {
            pluginId: hook.pluginId,
            failure: String(cause).slice(0, 500),
          }).pipe(Effect.as(undefined)),
        ),
      );
      if (answer === undefined) continue;
      const response = responseFor(request, answer);
      if (response === undefined) {
        yield* Effect.logWarning("plugin answered a runtime request with an unusable answer", {
          pluginId: hook.pluginId,
          requestId: request.requestId,
        });
        continue;
      }
      const commandId = CommandId.make(
        `command:plugin:${hook.pluginId}:${yield* input.crypto.randomUUIDv4().pipe(Effect.orDie)}`,
      );
      // The user may have answered meanwhile, so a refused response is expected, not a failure.
      yield* threads
        .dispatch({
          type: "runtime-request.respond",
          commandId,
          ...target,
          ...response,
        })
        .pipe(
          Effect.tap(() =>
            Effect.logInfo("plugin answered a runtime request", {
              pluginId: hook.pluginId,
              requestId: request.requestId,
              kind: request.kind,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logDebug("plugin runtime request answer was not accepted", {
              pluginId: hook.pluginId,
              requestId: request.requestId,
              cause: String(cause).slice(0, 500),
            }),
          ),
        );
      return;
    }
  });

  const consider = Effect.fnUntraced(function* (threadId: ThreadId, requestId: RuntimeRequestId) {
    if (tracked.has(requestId)) return;
    const records = yield* orchestrator.getThreadRecords(
      threadId,
      ["runtimeRequests", "turnItems"],
      { turnItemTypes: ["approval_request", "user_input_request"] },
    );
    const request = records.runtimeRequests.find((candidate) => candidate.id === requestId);
    const item = records.turnItems.find(
      (candidate): candidate is RequestItem =>
        (candidate.type === "approval_request" || candidate.type === "user_input_request") &&
        candidate.requestId === requestId,
    );
    if (
      request?.status !== "pending" ||
      request.responseCapability.type === "not_resumable" ||
      item === undefined ||
      tracked.has(requestId)
    ) {
      return;
    }
    const [oldest] = tracked.keys();
    if (tracked.size >= MAX_TRACKED_REQUESTS && oldest !== undefined) yield* forget(oldest);
    tracked.set(
      requestId,
      yield* ask({ threadId, requestId }, toPluginRuntimeRequest(request, item)).pipe(
        Effect.forkDetach,
      ),
    );
  });

  // The in-memory event stream other reactors use: nothing is serialized or budgeted per event,
  // and the type check runs before anything else. The buffer keeps projection reads for one
  // request from holding back the events behind it.
  const react = orchestrator.streamDomainEvents.pipe(
    Stream.map(candidateOf),
    Stream.filter((candidate) => candidate !== undefined),
    Stream.buffer({ capacity: CANDIDATE_BUFFER, strategy: "sliding" }),
    Stream.runForEach((candidate) =>
      candidate.open
        ? consider(candidate.threadId, candidate.requestId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("reading a runtime request for plugins failed", {
                requestId: candidate.requestId,
                cause: String(cause).slice(0, 500),
              }),
            ),
          )
        : forget(candidate.requestId),
    ),
    // Started again while any hook is registered, so one failure cannot silence every plugin.
    Effect.catchCause((cause) =>
      Effect.logWarning("plugin runtime request reactor stopped; restarting", {
        cause: String(cause).slice(0, 500),
      }),
    ),
    Effect.andThen(Effect.sleep(RESTART_DELAY)),
    Effect.forever,
  );

  return {
    add: (hook) => {
      hooks = [...hooks, hook];
      reactor ??= Effect.runForkWith(context)(react);
      return () => {
        hooks = hooks.filter((other) => other !== hook);
        if (hooks.length > 0 || reactor === undefined) return;
        const stopping = reactor;
        reactor = undefined;
        const asking = [...tracked.values()];
        tracked.clear();
        Effect.runForkWith(context)(Fiber.interruptAll([stopping, ...asking]));
      };
    },
  };
};
