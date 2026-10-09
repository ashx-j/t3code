import {
  CommandId,
  type GitHubReplySnooze,
  type OrchestrationV2AppThread,
  type GitHubReplyNotice,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as GitHubReplyReader from "../sourceControl/GitHubReplyReader.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export class GitHubReplySnoozeWorker extends Context.Service<
  GitHubReplySnoozeWorker,
  {
    readonly sweep: Effect.Effect<void, ProjectionStore.ProjectionStoreV2Error>;
  }
>()("t3/orchestration-v2/GitHubReplySnoozeWorker") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const reader = yield* GitHubReplyReader.GitHubReplyReader;
  const sweep = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const candidates = yield* projections.getGitHubReplySnoozes();
    yield* Effect.forEach(
      candidates,
      Effect.fnUntraced(
        function* (thread: OrchestrationV2AppThread) {
          const watch = thread.githubReplySnooze;
          if (!watch || Date.parse(watch.nextCheckAt) > DateTime.toEpochMillis(now)) return;
          const project = yield* projects.get(thread.projectId);
          const result = yield* (
            Option.isNone(project)
              ? Effect.fail(new GitHubReplyReader.GitHubReplyReadError({ reason: "unavailable" }))
              : reader.read({ cwd: project.value.workspaceRoot, watch })
          ).pipe(Effect.result);
          let next: GitHubReplySnooze | null;
          let notice: GitHubReplyNotice | undefined;
          if (result._tag === "Success") {
            next = {
              ...watch,
              viewer: result.success.viewer,
              ...(result.success.discussionCommentId === undefined
                ? {}
                : { discussionCommentId: result.success.discussionCommentId }),
              status: "watching",
              failures: 0,
              nextCheckAt: DateTime.formatIso(DateTime.add(now, { minutes: 2 })),
            };
            if (result.success.reply) {
              next = null;
              notice = {
                type: "reply",
                receivedAt: DateTime.formatIso(now),
                ...result.success.reply,
              };
            }
          } else if (result.failure.reason === "rate-limited") {
            next = {
              ...watch,
              status: "rate-limited",
              nextCheckAt: DateTime.formatIso(
                DateTime.makeUnsafe(
                  Math.max(result.failure.retryAt ?? 0, DateTime.toEpochMillis(now) + 120_000),
                ),
              ),
            };
          } else {
            const failures = watch.failures + 1;
            if (failures >= 3 || result.failure.reason !== "unavailable") {
              next = null;
              notice = {
                type: "error",
                receivedAt: DateTime.formatIso(now),
                url: watch.url,
                text: result.failure.message,
              };
            } else {
              next = {
                ...watch,
                failures,
                status: "retrying",
                nextCheckAt: DateTime.formatIso(DateTime.add(now, { minutes: 2 ** failures })),
              };
            }
          }
          // The orchestrator compares requestId under its thread lock. Late results cannot wake a replacement snooze.
          yield* threads.dispatch({
            type: "thread.github-reply.sync",
            threadId: thread.id,
            commandId: CommandId.make(`github-reply:${watch.requestId}:${watch.nextCheckAt}`),
            requestId: watch.requestId,
            watch: next,
            ...(notice === undefined ? {} : { notice }),
          });
        },
        Effect.catchCause((cause) =>
          Effect.logWarning("github-reply-snooze.check-failed", { cause }),
        ),
      ),
      { concurrency: 2, discard: true },
    );
  });
  return GitHubReplySnoozeWorker.of({ sweep });
});

export const layer = Layer.effect(GitHubReplySnoozeWorker, make);
export const layerScheduled = Layer.effectDiscard(
  Effect.gen(function* () {
    const worker = yield* GitHubReplySnoozeWorker;
    const scheduler = yield* Scheduler.Scheduler;
    let nextSweepAt = 0;
    yield* scheduler.register(
      "github-reply-snooze",
      Effect.gen(function* () {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        if (now < nextSweepAt) return;
        nextSweepAt = now + 30_000;
        yield* worker.sweep;
      }),
    );
  }),
);
