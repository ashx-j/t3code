import {
  AuthSourceControlWriteScope,
  type AuthSessionState,
  DiscussionOperationError,
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type GitHubDiscussionDetail,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
  type PreparedConnection,
  type NetworkStatus,
} from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import type { EnvironmentRpcInput, EnvironmentRpcSuccess } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { createDiscussionState } from "./discussions.ts";
import { executeAtomQuery } from "./runtime.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthSourceControlWriteScope],
      permissions: [AuthSourceControlWriteScope],
    }),
  ),
);

const target = {
  environmentId: EnvironmentId.make("environment"),
  input: { threadId: ThreadId.make("thread"), url: "https://github.com/team/repo/discussions/1" },
};
const post = (id: string) => ({
  id,
  url: `${target.input.url}#discussioncomment-1`,
  body: id,
  author: null,
  createdAt: "2026-10-01T12:00:00Z",
  updatedAt: "2026-10-01T12:00:00Z",
  reactions: [],
});
const detail: GitHubDiscussionDetail = {
  ...post("discussion"),
  url: target.input.url,
  number: 1,
  title: "Discussion",
  closed: false,
  isAnswered: false,
  category: null,
  commentCount: 100,
  commentsTruncated: true,
  comments: [
    { ...post("parent"), replyCount: 30, repliesTruncated: true, replies: [post("reply")] },
  ],
};

type DiscussionRpc =
  | typeof WS_METHODS.discussionsDetail
  | typeof WS_METHODS.discussionsComment
  | typeof WS_METHODS.discussionsSetReaction
  | typeof WS_METHODS.discussionsSetUpvote
  | typeof WS_METHODS.discussionsSetLabel
  | typeof WS_METHODS.discussionsSetCategory;
type DiscussionTestClient = Partial<{
  [Tag in DiscussionRpc]: (
    input: EnvironmentRpcInput<Tag>,
  ) => Effect.Effect<EnvironmentRpcSuccess<Tag>, DiscussionOperationError>;
}>;

const setup = Effect.fn("discussionsTest.setup")(function* (client: DiscussionTestClient) {
  const rpcSession: RpcSession = {
    client: client as unknown as WsRpcProtocolClient,
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.empty,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: target.environmentId,
      label: "Test",
      httpBaseUrl: "http://localhost",
      wsBaseUrl: "ws://localhost",
    }),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
      desired: true,
      network: "online",
      attempt: 1,
      generation: 1,
    }),
    session: yield* SubscriptionRef.make(Option.some(rpcSession)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map(),
  );
  const networkStatus = yield* SubscriptionRef.make<NetworkStatus>("online");
  const runtime = Atom.runtime(
    Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
      entries,
      networkStatus,
      run: (_id, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      followStream: (_id, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    }),
  );
  const state = createDiscussionState(runtime);
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  const atom = state.detailQuery(target);
  yield* Effect.acquireRelease(
    Effect.sync(() => registry.mount(atom)),
    (unmount) => Effect.sync(unmount),
  );
  yield* Effect.promise(() => executeAtomQuery(registry, atom));
  return { state, registry, atom };
});

it.effect(
  "shares anchors and patches successful comments, replies and reactions without another full read",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let reads = 0;
        const { state, registry, atom } = yield* setup({
          [WS_METHODS.discussionsDetail]: () =>
            Effect.sync(() => {
              reads++;
              return detail;
            }),
          [WS_METHODS.discussionsComment]: (input) =>
            Effect.succeed({ comment: post(input.body), replyToId: input.replyToId ?? null }),
          [WS_METHODS.discussionsSetReaction]: (input) =>
            Effect.succeed({
              subjectId: input.subjectId,
              reactions: [{ content: input.content, count: 1, actors: [], viewerHasReacted: true }],
            }),
        });
        expect(
          state.detailQuery({
            ...target,
            input: { ...target.input, url: `${target.input.url}#discussioncomment-1` },
          }),
        ).toBe(atom);
        for (const input of [
          { ...target.input, body: "top" },
          { ...target.input, body: "new-reply", replyToId: "parent" },
          { ...target.input, body: "top" },
          { ...target.input, body: "new-reply", replyToId: "parent" },
        ]) {
          expect(
            (yield* Effect.promise(() => state.comment.run(registry, { ...target, input })))._tag,
          ).toBe("Success");
        }
        for (const subjectId of ["discussion", "parent", "reply"]) {
          yield* Effect.promise(() =>
            state.setReaction.run(registry, {
              ...target,
              input: { ...target.input, subjectId, content: "heart", reacted: true },
            }),
          );
        }
        const value = Option.getOrThrow(AsyncResult.value(registry.get(atom)));
        expect(value.comments.map((comment) => comment.id)).toEqual(["parent", "top"]);
        expect(value.comments[0]?.replies.map((reply) => reply.id)).toEqual(["reply", "new-reply"]);
        expect(value.commentCount).toBe(101);
        expect(value.commentsTruncated).toBe(true);
        expect(value.comments[0]?.replyCount).toBe(31);
        expect(value.comments[0]?.repliesTruncated).toBe(true);
        expect(value.comments[1]?.replyCount).toBe(0);
        expect(value.comments[1]?.repliesTruncated).toBe(false);
        expect(value.reactions?.[0]?.content).toBe("heart");
        expect(value.comments[0]?.reactions?.[0]?.content).toBe("heart");
        expect(value.comments[0]?.replies[0]?.reactions?.[0]?.content).toBe("heart");
        expect(reads).toBe(1);
      }),
    ),
);

it.effect("retains confirmed changes when refresh fails and never retries a failed write", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let failRead = false;
      let failWrite = false;
      let writes = 0;
      const failure = new DiscussionOperationError({ message: "GitHub unavailable" });
      const { state, registry, atom } = yield* setup({
        [WS_METHODS.discussionsDetail]: () =>
          failRead ? Effect.fail(failure) : Effect.succeed(detail),
        [WS_METHODS.discussionsComment]: () =>
          Effect.suspend(() => {
            writes++;
            return failWrite
              ? Effect.fail(failure)
              : Effect.succeed({ comment: post("new"), replyToId: null });
          }),
      });
      const input = { ...target, input: { ...target.input, body: "new" } };
      yield* Effect.promise(() => state.comment.run(registry, input));
      failRead = true;
      const refreshed = yield* Effect.promise(() =>
        executeAtomQuery(registry, atom, { refresh: true, reportFailure: false }),
      );
      expect(refreshed._tag).toBe("Failure");
      expect(Option.getOrThrow(AsyncResult.value(registry.get(atom))).comments.at(-1)?.id).toBe(
        "new",
      );
      failWrite = true;
      const failed = yield* Effect.promise(() => state.comment.run(registry, input));
      expect(failed._tag).toBe("Failure");
      expect(writes).toBe(2);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(atom))).comments).toHaveLength(2);
    }),
  ),
);

it.effect(
  "patches only the upvoted subject, supports removing it, and keeps the last value on failure",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let fail = false;
        let writes = 0;
        const { state, registry, atom } = yield* setup({
          [WS_METHODS.discussionsDetail]: () => Effect.succeed(detail),
          [WS_METHODS.discussionsSetUpvote]: (input) =>
            Effect.suspend(() => {
              writes++;
              return fail
                ? Effect.fail(new DiscussionOperationError({ message: "GitHub unavailable" }))
                : Effect.succeed({
                    subjectId: input.subjectId,
                    upvoteCount: input.upvoted ? 7 : 6,
                    viewerHasUpvoted: input.upvoted,
                  });
            }),
        });
        for (const subjectId of ["discussion", "parent", "reply"]) {
          const result = yield* Effect.promise(() =>
            state.setUpvote.run(registry, {
              ...target,
              input: { ...target.input, subjectId, upvoted: true },
            }),
          );
          expect(result._tag).toBe("Success");
        }
        const upvoted = Option.getOrThrow(AsyncResult.value(registry.get(atom)));
        expect(upvoted.upvoteCount).toBe(7);
        expect(upvoted.viewerHasUpvoted).toBe(true);
        expect(upvoted.comments[0]?.upvoteCount).toBe(7);
        expect(upvoted.comments[0]?.replies[0]?.upvoteCount).toBe(7);
        yield* Effect.promise(() =>
          state.setUpvote.run(registry, {
            ...target,
            input: { ...target.input, subjectId: "parent", upvoted: false },
          }),
        );
        const removed = Option.getOrThrow(AsyncResult.value(registry.get(atom)));
        expect(removed.upvoteCount).toBe(7);
        expect(removed.comments[0]?.upvoteCount).toBe(6);
        expect(removed.comments[0]?.viewerHasUpvoted).toBe(false);
        expect(removed.comments[0]?.replies[0]?.upvoteCount).toBe(7);
        fail = true;
        const failure = yield* Effect.promise(() =>
          state.setUpvote.run(registry, {
            ...target,
            input: { ...target.input, subjectId: "parent", upvoted: true },
          }),
        );
        expect(failure._tag).toBe("Failure");
        expect(Option.getOrThrow(AsyncResult.value(registry.get(atom)))).toBe(removed);
        expect(writes).toBe(5);
      }),
    ),
);

it.effect(
  "patches confirmed metadata, retains comments and other labels, and preserves the cache on failure",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let failWrite = false;
        let failRead = false;
        let writes = 0;
        const existingLabel = { name: "keep", color: "111111" };
        const addedLabel = { name: "bug", color: "ff0000" };
        const category = { id: "category", name: "Ideas", emoji: ":bulb:" };
        const failure = new DiscussionOperationError({ message: "GitHub unavailable" });
        const { state, registry, atom } = yield* setup({
          [WS_METHODS.discussionsDetail]: () =>
            failRead
              ? Effect.fail(failure)
              : Effect.succeed({ ...detail, labels: [existingLabel], isAnswered: true }),
          [WS_METHODS.discussionsSetLabel]: (input) =>
            Effect.suspend(() => {
              writes++;
              return failWrite
                ? Effect.fail(failure)
                : Effect.succeed({ label: addedLabel, applied: input.applied });
            }),
          [WS_METHODS.discussionsSetCategory]: () =>
            Effect.suspend(() => {
              writes++;
              return failWrite
                ? Effect.fail(failure)
                : Effect.succeed({ category, isAnswered: false });
            }),
        });
        const labelInput = {
          ...target,
          input: { ...target.input, labelId: "label", applied: true },
        };
        const categoryInput = { ...target, input: { ...target.input, categoryId: category.id } };
        yield* Effect.promise(() => state.setLabel.run(registry, labelInput));
        expect(Option.getOrThrow(AsyncResult.value(registry.get(atom))).labels).toEqual([
          existingLabel,
          addedLabel,
        ]);
        yield* Effect.promise(() =>
          state.setLabel.run(registry, {
            ...labelInput,
            input: { ...labelInput.input, applied: false },
          }),
        );
        yield* Effect.promise(() => state.setCategory.run(registry, categoryInput));
        const saved = Option.getOrThrow(AsyncResult.value(registry.get(atom)));
        expect(saved.labels).toEqual([existingLabel]);
        expect(saved.category).toEqual(category);
        expect(saved.isAnswered).toBe(false);
        expect(saved.comments).toBe(detail.comments);
        failWrite = true;
        const labelFailure = yield* Effect.promise(() => state.setLabel.run(registry, labelInput));
        const categoryFailure = yield* Effect.promise(() =>
          state.setCategory.run(registry, categoryInput),
        );
        expect(labelFailure._tag).toBe("Failure");
        expect(categoryFailure._tag).toBe("Failure");
        expect(writes).toBe(5);
        expect(Option.getOrThrow(AsyncResult.value(registry.get(atom)))).toBe(saved);
        failRead = true;
        yield* Effect.promise(() =>
          executeAtomQuery(registry, atom, { refresh: true, reportFailure: false }),
        );
        expect(Option.getOrThrow(AsyncResult.value(registry.get(atom)))).toBe(saved);
      }),
    ),
);
