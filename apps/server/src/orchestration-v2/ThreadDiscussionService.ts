import {
  CommandId,
  DiscussionOperationError,
  parseGitHubConversationUrl,
  type ThreadDiscussionLink,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as GitHubDiscussions from "../sourceControl/GitHubDiscussions.ts";

export interface DiscussionTargetInput {
  readonly threadId: ThreadId;
  readonly url?: string | undefined;
  readonly host?: string | undefined;
  readonly repository?: string | undefined;
  readonly number?: number | undefined;
}

type DiscussionIdentity = Pick<ThreadDiscussionLink, "host" | "repository" | "number" | "url">;

export class ThreadDiscussionService extends Context.Service<
  ThreadDiscussionService,
  {
    readonly link: (
      input: DiscussionTargetInput,
    ) => Effect.Effect<
      DiscussionIdentity & { readonly alreadyLinked: boolean },
      DiscussionOperationError
    >;
    readonly unlink: (
      input: DiscussionTargetInput,
    ) => Effect.Effect<
      Omit<DiscussionIdentity, "url"> & { readonly wasLinked: boolean },
      DiscussionOperationError
    >;
    readonly list: (
      threadId: ThreadId,
    ) => Effect.Effect<
      { readonly discussions: ReadonlyArray<ThreadDiscussionLink> },
      DiscussionOperationError
    >;
  }
>()("t3/orchestration-v2/ThreadDiscussionService") {}

const resolveTarget = Effect.fn("ThreadDiscussionService.resolveTarget")(function* (
  input: DiscussionTargetInput,
) {
  if (input.host !== undefined && input.host.toLowerCase() !== "github.com")
    return yield* new DiscussionOperationError({
      message: "Only github.com discussions are supported.",
    });
  if (input.url === undefined && (input.repository === undefined || input.number === undefined))
    return yield* new DiscussionOperationError({
      message: "Pass either url, or both repository and number.",
    });
  const url = input.url ?? `https://github.com/${input.repository}/discussions/${input.number}`;
  const parsed = parseGitHubConversationUrl(url);
  if (parsed?.kind !== "discussion" || !Number.isSafeInteger(parsed.number))
    return yield* new DiscussionOperationError({
      message: "Use a github.com repository discussion URL.",
    });
  const repository = `${parsed.owner}/${parsed.repository}`.toLowerCase();
  return {
    host: "github.com" as const,
    repository,
    number: parsed.number,
    url: `https://github.com/${repository}/discussions/${parsed.number}`,
  };
});

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const reader = yield* GitHubDiscussions.GitHubDiscussions;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const failure = () =>
    new DiscussionOperationError({ message: "Could not update this thread's discussions." });

  const requireThread = Effect.fn("ThreadDiscussionService.requireThread")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* engine.getThreadShell(threadId).pipe(Effect.mapError(failure));
    if (!thread || thread.deletedAt !== null)
      return yield* new DiscussionOperationError({ message: `Thread ${threadId} was not found.` });
    return thread;
  });

  const workspace = Effect.fn("ThreadDiscussionService.workspace")(function* (threadId: ThreadId) {
    const thread = yield* requireThread(threadId);
    const project = yield* projects.getShell(thread.projectId).pipe(Effect.mapError(failure));
    if (Option.isNone(project))
      return yield* new DiscussionOperationError({
        message: "This thread's project was not found.",
      });
    const cwd =
      thread.worktreePath !== null &&
      (yield* fileSystem.exists(thread.worktreePath).pipe(Effect.mapError(failure)))
        ? thread.worktreePath
        : project.value.workspaceRoot;
    return cwd;
  });

  const link = Effect.fn("ThreadDiscussionService.link")(function* (input: DiscussionTargetInput) {
    const thread = yield* requireThread(input.threadId);
    const target = yield* resolveTarget(input);
    if (
      thread.discussions?.some(
        (link) =>
          link.repository.toLowerCase() === target.repository && link.number === target.number,
      )
    )
      return { ...target, alreadyLinked: true };
    const discussion = yield* reader.summary({ cwd: yield* workspace(thread.id), url: target.url });
    const current = yield* requireThread(thread.id);
    if (current.projectId !== thread.projectId || current.worktreePath !== thread.worktreePath)
      return yield* new DiscussionOperationError({
        message: "The thread's workspace changed. Link the discussion again.",
      });
    const alreadyLinked =
      current.discussions?.some(
        (link) =>
          link.repository.toLowerCase() === target.repository && link.number === target.number,
      ) ?? false;
    if (!alreadyLinked) {
      yield* engine
        .dispatch({
          type: "thread.discussion.link",
          commandId: CommandId.make(
            `server:discussion-link:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
          ),
          threadId: thread.id,
          discussion: target,
          title: discussion.title,
          source: "agent",
        })
        .pipe(Effect.mapError(failure));
    }
    return { ...target, alreadyLinked };
  });

  const unlink = Effect.fn("ThreadDiscussionService.unlink")(function* (
    input: DiscussionTargetInput,
  ) {
    const thread = yield* requireThread(input.threadId);
    const target = yield* resolveTarget(input);
    const wasLinked =
      thread.discussions?.some(
        (link) =>
          link.repository.toLowerCase() === target.repository && link.number === target.number,
      ) ?? false;
    if (wasLinked)
      yield* engine
        .dispatch({
          type: "thread.discussion.unlink",
          commandId: CommandId.make(
            `server:discussion-unlink:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
          ),
          threadId: thread.id,
          discussion: target,
        })
        .pipe(Effect.mapError(failure));
    return { host: target.host, repository: target.repository, number: target.number, wasLinked };
  });

  return ThreadDiscussionService.of({
    link,
    unlink,
    list: (threadId) =>
      requireThread(threadId).pipe(
        Effect.map((thread) => ({ discussions: thread.discussions ?? [] })),
      ),
  });
});

export const layer = Layer.effect(ThreadDiscussionService, make);
