import {
  WS_METHODS,
  type EnvironmentId,
  type GitHubDiscussionCommentInput,
  type GitHubDiscussionDetailInput,
  type GitHubDiscussionReactionInput,
  type GitHubDiscussionUpvoteInput,
  type GitHubDiscussionSetLabelInput,
  type GitHubDiscussionSetCategoryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

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
    setLabel: createEnvironmentCommand(runtime, {
      label: "environment-data:discussions:set-label",
      execute: (input: GitHubDiscussionSetLabelInput, registry, environmentId) =>
        request(WS_METHODS.discussionsSetLabel, input).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              const atom = detailQuery({ environmentId, input });
              if (registry.get(atom).waiting) registry.refresh(atom);
              registry.update(
                atom,
                AsyncResult.map((detail) => ({
                  ...detail,
                  labels: result.applied
                    ? [
                        ...(detail.labels ?? []).filter(
                          (label) => label.name !== result.label.name,
                        ),
                        result.label,
                      ]
                    : (detail.labels ?? []).filter((label) => label.name !== result.label.name),
                })),
              );
            }),
          ),
        ),
    }),
    setCategory: createEnvironmentCommand(runtime, {
      label: "environment-data:discussions:set-category",
      execute: (input: GitHubDiscussionSetCategoryInput, registry, environmentId) =>
        request(WS_METHODS.discussionsSetCategory, input).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              const atom = detailQuery({ environmentId, input });
              if (registry.get(atom).waiting) registry.refresh(atom);
              registry.update(
                atom,
                AsyncResult.map((detail) => ({ ...detail, ...result })),
              );
            }),
          ),
        ),
    }),
    comment: createEnvironmentCommand(runtime, {
      label: "environment-data:discussions:comment",
      execute: (input: GitHubDiscussionCommentInput, registry, environmentId) =>
        request(WS_METHODS.discussionsComment, input).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              const atom = detailQuery({ environmentId, input });
              if (registry.get(atom).waiting) registry.refresh(atom);
              registry.update(
                atom,
                AsyncResult.map((detail) => ({
                  ...detail,
                  comments:
                    result.replyToId === null
                      ? detail.comments.some((comment) => comment.id === result.comment.id)
                        ? detail.comments
                        : [...detail.comments, { ...result.comment, replies: [] }]
                      : detail.comments.map((comment) =>
                          comment.id === result.replyToId
                            ? {
                                ...comment,
                                replies: comment.replies.some(
                                  (reply) => reply.id === result.comment.id,
                                )
                                  ? comment.replies
                                  : [...comment.replies, result.comment],
                              }
                            : comment,
                        ),
                })),
              );
            }),
          ),
        ),
    }),
    setReaction: createEnvironmentCommand(runtime, {
      label: "environment-data:discussions:set-reaction",
      execute: (input: GitHubDiscussionReactionInput, registry, environmentId) =>
        request(WS_METHODS.discussionsSetReaction, input).pipe(
          Effect.tap((result) =>
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
                      reply.id === result.subjectId
                        ? { ...reply, reactions: result.reactions }
                        : reply,
                    ),
                  })),
                })),
              );
            }),
          ),
        ),
    }),
    setUpvote: createEnvironmentCommand(runtime, {
      label: "environment-data:discussions:set-upvote",
      execute: (input: GitHubDiscussionUpvoteInput, registry, environmentId) =>
        request(WS_METHODS.discussionsSetUpvote, input).pipe(
          Effect.tap(({ subjectId, ...upvote }) =>
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
          ),
        ),
    }),
  };
}
