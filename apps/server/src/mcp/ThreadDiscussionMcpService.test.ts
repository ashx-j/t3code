import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadDiscussionService from "../orchestration-v2/ThreadDiscussionService.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as ThreadDiscussionMcpService from "./ThreadDiscussionMcpService.ts";

const threadId = ThreadId.make("caller");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("env"),
  capabilities: new Set(["pull-requests"]),
  issuedAt: 1,
  requestNamespace: "session",
  thread: {
    threadId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
};
const thread = (
  id: ThreadId,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  ...v2PullRequestThread({
    id,
    projectId: ProjectId.make("project"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestUserMessageAt: null,
    createdAt: "2026-10-01T12:00:00Z",
    updatedAt: "2026-10-01T12:00:00Z",
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
  }),
  ...overrides,
});

const harness = Effect.fn("discussionMcpTest.harness")(function* (
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
) {
  const targets = yield* Ref.make<Array<ThreadId>>([]);
  const record = (id: ThreadId) => Ref.update(targets, (ids) => [...ids, id]);
  const identity = {
    host: "github.com" as const,
    repository: "team/repo",
    number: 1,
    url: "https://github.com/team/repo/discussions/1",
  };
  const service = yield* ThreadDiscussionMcpService.ThreadDiscussionMcpService.pipe(
    Effect.provide(
      ThreadDiscussionMcpService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadShell: (id) =>
                Effect.succeed(threads.find((thread) => thread.id === id) ?? null),
            }),
            Layer.mock(ThreadDiscussionService.ThreadDiscussionService)({
              link: (input) =>
                record(input.threadId).pipe(Effect.as({ ...identity, alreadyLinked: false })),
              unlink: (input) =>
                record(input.threadId).pipe(Effect.as({ ...identity, wasLinked: true })),
              list: (id) => record(id).pipe(Effect.as({ discussions: [] })),
            }),
          ),
        ),
      ),
    ),
  );
  return { service, targets };
});

it.effect("uses the calling thread for link, list and unlink", () =>
  Effect.gen(function* () {
    const { service, targets } = yield* harness([thread(threadId)]);
    yield* service.link(scope, { repository: "team/repo", number: 1 });
    yield* service.list(scope, {});
    yield* service.unlink(scope, { repository: "team/repo", number: 1 });
    assert.deepEqual(yield* Ref.get(targets), [threadId, threadId, threadId]);
  }),
);

it.effect("requires the PR capability and an explicit target for external clients", () =>
  Effect.gen(function* () {
    const { service, targets } = yield* harness([thread(threadId)]);
    assert.equal(
      (yield* service.list({ ...scope, capabilities: new Set() }, {}).pipe(Effect.flip))._tag,
      "McpCapabilityUnavailableError",
    );
    assert.include(
      (yield* service.list({ ...scope, thread: undefined }, {}).pipe(Effect.flip)).message,
      "Pass threadId",
    );
    assert.include(
      (yield* service.list(scope, { threadId: ThreadId.make("missing") }).pipe(Effect.flip))
        .message,
      "not found",
    );
    assert.deepEqual(yield* Ref.get(targets), []);
  }),
);

it.effect(
  "blocks cross-thread mutations without an owned active run or sufficient permission",
  () =>
    Effect.gen(function* () {
      const other = ThreadId.make("other");
      const { service, targets } = yield* harness([thread(threadId), thread(other)]);
      assert.include(
        (yield* service
          .link(scope, { threadId: other, repository: "team/repo", number: 1 })
          .pipe(Effect.flip)).message,
        "cannot be changed",
      );
      assert.include(
        (yield* service
          .unlink(
            { ...scope, thread: undefined },
            { threadId: other, repository: "team/repo", number: 1 },
          )
          .pipe(Effect.flip)).message,
        "cannot be changed",
      );
      assert.deepEqual(yield* Ref.get(targets), []);
      const active = yield* harness([
        thread(threadId, { activeRunId: RunId.make("run"), runtimeMode: "approval-required" }),
        thread(other),
      ]);
      assert.include(
        (yield* active.service
          .link(scope, { threadId: other, repository: "team/repo", number: 1 })
          .pipe(Effect.flip)).message,
        "cannot be changed",
      );
    }),
);

it.effect("allows an owned active caller to link another thread within its permissions", () =>
  Effect.gen(function* () {
    const other = ThreadId.make("other");
    const { service, targets } = yield* harness([
      thread(threadId, { activeRunId: RunId.make("run") }),
      thread(other),
    ]);
    yield* service.link(scope, { threadId: other, repository: "team/repo", number: 1 });
    assert.deepEqual(yield* Ref.get(targets), [other]);
  }),
);
