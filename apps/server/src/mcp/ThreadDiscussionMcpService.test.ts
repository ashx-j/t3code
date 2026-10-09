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
import * as Stream from "effect/Stream";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadDiscussionService from "../orchestration-v2/ThreadDiscussionService.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as ThreadDiscussionMcpService from "./ThreadDiscussionMcpService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as DiscussionsHandlers from "./toolkits/discussions/handlers.ts";
import { DiscussionsToolkit } from "./toolkits/discussions/tools.ts";

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
  const toolkit = yield* DiscussionsToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(DiscussionsHandlers.layer).pipe(
        Layer.provide(
          Layer.succeed(ThreadDiscussionMcpService.ThreadDiscussionMcpService, service),
        ),
      ),
    ),
  );
  const call = <Name extends keyof typeof DiscussionsToolkit.tools>(
    name: Name,
    input: Parameters<typeof toolkit.handle<Name>>[1],
    invocation: McpInvocationScope = scope,
  ) =>
    toolkit.handle(name, input).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provideService(ThreadDiscussionMcpService.ThreadDiscussionMcpService, service),
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed(threads.find((thread) => thread.id === id) ?? null),
        }),
      ),
    );
  return { service, targets, call };
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
      const { call, targets } = yield* harness([thread(threadId), thread(other)]);
      assert.propertyVal(
        yield* call("link_discussion", {
          threadId: other,
          repository: "team/repo",
          number: 1,
        }).pipe(Effect.flip),
        "code",
        "parent_not_active",
      );
      assert.propertyVal(
        yield* call(
          "unlink_discussion",
          { threadId: other, repository: "team/repo", number: 1 },
          { ...scope, thread: undefined },
        ).pipe(Effect.flip),
        "code",
        "runtime_mode_escalation_denied",
      );
      assert.deepEqual(yield* Ref.get(targets), []);
      const active = yield* harness([
        thread(threadId, { activeRunId: RunId.make("run"), runtimeMode: "approval-required" }),
        thread(other),
      ]);
      assert.propertyVal(
        yield* active
          .call("link_discussion", { threadId: other, repository: "team/repo", number: 1 })
          .pipe(Effect.flip),
        "code",
        "runtime_mode_escalation_denied",
      );
    }),
);

it.effect("allows an owned active caller to link another thread within its permissions", () =>
  Effect.gen(function* () {
    const other = ThreadId.make("other");
    const { call, targets } = yield* harness([
      thread(threadId, { activeRunId: RunId.make("run") }),
      thread(other),
    ]);
    yield* call("link_discussion", { threadId: other, repository: "team/repo", number: 1 });
    assert.deepEqual(yield* Ref.get(targets), [other]);
  }),
);

it.effect("read-only clients can list links but cannot link or unlink discussions", () =>
  Effect.gen(function* () {
    const { call, targets } = yield* harness([thread(threadId)]);
    const readOnly: McpInvocationScope = {
      ...scope,
      thread: undefined,
      client: { sessionId: "reader", label: "Reader", access: "read-only" },
    };
    for (const name of ["link_discussion", "unlink_discussion"] as const) {
      const error = yield* call(
        name,
        { threadId, repository: "team/repo", number: 1 },
        readOnly,
      ).pipe(Effect.flip);
      assert.propertyVal(error, "code", "capability_denied");
    }
    assert.deepEqual(yield* Ref.get(targets), []);
    yield* call("list_thread_discussions", { threadId }, readOnly);
    assert.deepEqual(yield* Ref.get(targets), [threadId]);
  }),
);
