import { DiscussionOperationError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadDiscussionService from "../orchestration-v2/ThreadDiscussionService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { assertTargetWithinLimits } from "./threadAccess.ts";

type TargetInput = Omit<ThreadDiscussionService.DiscussionTargetInput, "threadId"> & {
  readonly threadId?: ThreadId | undefined;
};

type Failure =
  | DiscussionOperationError
  | import("@t3tools/contracts").McpCapabilityUnavailableError;

export class ThreadDiscussionMcpService extends Context.Service<
  ThreadDiscussionMcpService,
  {
    readonly link: (
      scope: McpInvocationContext.McpInvocationScope,
      input: TargetInput,
    ) => Effect.Effect<
      Effect.Success<
        ReturnType<ThreadDiscussionService.ThreadDiscussionService["Service"]["link"]>
      >,
      Failure
    >;
    readonly unlink: (
      scope: McpInvocationContext.McpInvocationScope,
      input: TargetInput,
    ) => Effect.Effect<
      Effect.Success<
        ReturnType<ThreadDiscussionService.ThreadDiscussionService["Service"]["unlink"]>
      >,
      Failure
    >;
    readonly list: (
      scope: McpInvocationContext.McpInvocationScope,
      input: { readonly threadId?: ThreadId | undefined },
    ) => Effect.Effect<
      Effect.Success<
        ReturnType<ThreadDiscussionService.ThreadDiscussionService["Service"]["list"]>
      >,
      Failure
    >;
  }
>()("t3/mcp/ThreadDiscussionMcpService") {}

const make = Effect.gen(function* () {
  const discussions = yield* ThreadDiscussionService.ThreadDiscussionService;
  const engine = yield* Orchestrator.OrchestratorV2;

  // discussion links use the same caller scope and cross-thread limits as pr links.
  const requireThread = Effect.fn("ThreadDiscussionMcpService.requireThread")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    requested: ThreadId | undefined,
    writable: boolean,
  ) {
    yield* McpInvocationContext.requireMcpCapability("pull-requests").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    );
    const threadId = requested ?? scope.thread?.threadId;
    if (!threadId)
      return yield* new DiscussionOperationError({
        message: "Pass threadId: this MCP client is not running inside a T3 thread.",
      });
    const read = (id: ThreadId) =>
      engine
        .getThreadShell(id)
        .pipe(
          Effect.mapError(
            () => new DiscussionOperationError({ message: "Could not read the thread." }),
          ),
        );
    const thread = yield* read(threadId);
    if (!thread || thread.deletedAt !== null)
      return yield* new DiscussionOperationError({ message: `Thread ${threadId} was not found.` });
    if (!writable || scope.thread?.threadId === threadId) return threadId;
    const denied = () =>
      new DiscussionOperationError({
        message: `Thread ${threadId} cannot be changed from here: it runs with broader permissions than this caller, or the calling thread has no active run.`,
      });
    if (scope.thread) {
      const caller = yield* read(scope.thread.threadId);
      if (
        !caller ||
        caller.archivedAt !== null ||
        caller.activeRunId === null ||
        caller.providerInstanceId !== scope.thread.providerInstanceId
      )
        return yield* denied();
      yield* assertTargetWithinLimits(caller, thread).pipe(Effect.mapError(denied));
    } else {
      yield* assertTargetWithinLimits(
        {
          runtimeMode: scope.client?.runtimeModeCeiling ?? "approval-required",
          interactionMode: "default",
        },
        thread,
      ).pipe(Effect.mapError(denied));
    }
    return threadId;
  });

  return ThreadDiscussionMcpService.of({
    link: (scope, input) =>
      requireThread(scope, input.threadId, true).pipe(
        Effect.flatMap((threadId) => discussions.link({ ...input, threadId })),
      ),
    unlink: (scope, input) =>
      requireThread(scope, input.threadId, true).pipe(
        Effect.flatMap((threadId) => discussions.unlink({ ...input, threadId })),
      ),
    list: (scope, input) =>
      requireThread(scope, input.threadId, false).pipe(Effect.flatMap(discussions.list)),
  });
});

export const layer = Layer.effect(ThreadDiscussionMcpService, make);
