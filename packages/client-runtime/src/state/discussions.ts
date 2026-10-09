import {
  WS_METHODS,
  type EnvironmentId,
  type GitHubDiscussionDetailInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createDiscussionState<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  const sourceQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:discussions:detail",
    tag: WS_METHODS.discussionsDetail,
    staleTimeMs: 60_000,
  });
  // confirmed writes survive a background refresh, including a failed refresh.
  const writableQuery = Atom.family((source: ReturnType<typeof sourceQuery>) =>
    Atom.writable(
      (get) => {
        const result = get(source);
        if (result._tag === "Success" && !result.waiting) return result;
        const previous = get.self<typeof result>();
        const value = Option.flatMap(previous, AsyncResult.value);
        if (Option.isNone(value)) return result;
        return result._tag === "Failure"
          ? AsyncResult.failureWithPrevious(result.cause, { previous, waiting: result.waiting })
          : AsyncResult.success(value.value, result);
      },
      (context, value: Atom.Type<ReturnType<typeof sourceQuery>>) => context.setSelf(value),
      (refresh) => refresh(source),
    ).pipe(Atom.setIdleTTL(5 * 60_000)),
  );
  const detailQuery = ({
    environmentId,
    input,
  }: {
    readonly environmentId: EnvironmentId;
    readonly input: GitHubDiscussionDetailInput;
  }) =>
    writableQuery(
      sourceQuery({
        environmentId,
        input: {
          threadId: input.threadId,
          url: input.url.split("#")[0]!.replace(/\/$/, "").toLowerCase(),
        },
      }),
    );

  return {
    detailQuery,
    metadataOptions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:discussions:metadata-options",
      tag: WS_METHODS.discussionsMetadataOptions,
      staleTimeMs: 60_000,
    }),
    setLabel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:discussions:set-label",
      tag: WS_METHODS.discussionsSetLabel,
      onSuccess: ({ input, environmentId }, registry, result) =>
        Effect.sync(() => {
          const atom = detailQuery({ environmentId, input });
          if (registry.get(atom).waiting) registry.refresh(atom);
          registry.update(
            atom,
            AsyncResult.map((detail) => ({
              ...detail,
              labels: result.applied
                ? [
                    ...(detail.labels ?? []).filter((label) => label.name !== result.label.name),
                    result.label,
                  ]
                : (detail.labels ?? []).filter((label) => label.name !== result.label.name),
            })),
          );
        }),
    }),
    setCategory: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:discussions:set-category",
      tag: WS_METHODS.discussionsSetCategory,
      onSuccess: ({ input, environmentId }, registry, result) =>
        Effect.sync(() => {
          const atom = detailQuery({ environmentId, input });
          if (registry.get(atom).waiting) registry.refresh(atom);
          registry.update(
            atom,
            AsyncResult.map((detail) => ({ ...detail, ...result })),
          );
        }),
    }),
    comment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:discussions:comment",
      tag: WS_METHODS.discussionsComment,
      onSuccess: ({ input, environmentId }, registry, result) =>
        Effect.sync(() => {
          const atom = detailQuery({ environmentId, input });
          if (registry.get(atom).waiting) registry.refresh(atom);
          registry.update(
            atom,
            AsyncResult.map((detail) => ({
              ...detail,
              commentCount:
                result.replyToId === null &&
                !detail.comments.some((comment) => comment.id === result.comment.id)
                  ? (detail.commentCount ?? detail.comments.length) + 1
                  : detail.commentCount,
              comments:
                result.replyToId === null
                  ? detail.comments.some((comment) => comment.id === result.comment.id)
                    ? detail.comments
                    : [
                        ...detail.comments,
                        { ...result.comment, replyCount: 0, repliesTruncated: false, replies: [] },
                      ]
                  : detail.comments.map((comment) =>
                      comment.id === result.replyToId
                        ? {
                            ...comment,
                            replyCount: comment.replies.some(
                              (reply) => reply.id === result.comment.id,
                            )
                              ? comment.replyCount
                              : (comment.replyCount ?? comment.replies.length) + 1,
                            replies: comment.replies.some((reply) => reply.id === result.comment.id)
                              ? comment.replies
                              : [...comment.replies, result.comment],
                          }
                        : comment,
                    ),
            })),
          );
        }),
    }),
    setReaction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:discussions:set-reaction",
      tag: WS_METHODS.discussionsSetReaction,
      onSuccess: ({ input, environmentId }, registry, result) =>
        Effect.sync(() => {
          const atom = detailQuery({ environmentId, input });
          if (registry.get(atom).waiting) registry.refresh(atom);
          registry.update(
            atom,
            AsyncResult.map((detail) => ({
              ...detail,
              ...(detail.id === result.subjectId ? { reactions: result.reactions } : {}),
              comments: detail.comments.map((comment) => ({
                ...comment,
                ...(comment.id === result.subjectId ? { reactions: result.reactions } : {}),
                replies: comment.replies.map((reply) =>
                  reply.id === result.subjectId ? { ...reply, reactions: result.reactions } : reply,
                ),
              })),
            })),
          );
        }),
    }),
    setUpvote: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:discussions:set-upvote",
      tag: WS_METHODS.discussionsSetUpvote,
      onSuccess: ({ input, environmentId }, registry, { subjectId, ...upvote }) =>
        Effect.sync(() => {
          const atom = detailQuery({ environmentId, input });
          if (registry.get(atom).waiting) registry.refresh(atom);
          registry.update(
            atom,
            AsyncResult.map((detail) => ({
              ...detail,
              ...(detail.id === subjectId ? upvote : {}),
              comments: detail.comments.map((comment) => ({
                ...comment,
                ...(comment.id === subjectId ? upvote : {}),
                replies: comment.replies.map((reply) =>
                  reply.id === subjectId ? { ...reply, ...upvote } : reply,
                ),
              })),
            })),
          );
        }),
    }),
  };
}
