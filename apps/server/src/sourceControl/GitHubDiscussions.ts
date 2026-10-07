import {
  DiscussionOperationError,
  GitHubDiscussionCategory,
  GitHubDiscussionLabel,
  type GitHubDiscussionMetadataOptionsInput,
  type GitHubDiscussionMetadataOptions,
  type GitHubDiscussionSetLabelInput,
  type GitHubDiscussionSetLabelResult,
  type GitHubDiscussionSetCategoryInput,
  type GitHubDiscussionSetCategoryResult,
  GitHubDiscussionComment,
  GitHubDiscussionDetail,
  type GitHubDiscussionCommentInput,
  type GitHubDiscussionCommentResult,
  type GitHubDiscussionReactionInput,
  type GitHubDiscussionReactionResult,
  type GitHubDiscussionUpvoteInput,
  type GitHubDiscussionUpvoteResult,
  NonNegativeInt,
  parseGitHubConversationUrl,
  PullRequestLabel,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as GitHubCli from "./GitHubCli.ts";
import {
  REACTION_GROUPS_FIELDS,
  RawReactionGroupsSchema,
  gitHubReactionContent,
  toReactions,
} from "../pullRequest/gitHubPullRequestJson.ts";

const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});
const UpvoteState = Schema.Struct({
  upvoteCount: NonNegativeInt,
  viewerCanUpvote: Schema.Boolean,
  viewerHasUpvoted: Schema.Boolean,
});
const RawComment = Schema.Struct({
  ...GitHubDiscussionComment.fields,
  ...UpvoteState.fields,
  viewerCanReact: Schema.Boolean,
  reactionGroups: RawReactionGroupsSchema,
});
const Replies = Schema.Struct({ nodes: Schema.Array(RawComment), pageInfo: PageInfo });
const Comment = Schema.Struct({ ...RawComment.fields, replies: Replies });
const DiscussionMetadata = Schema.Struct({
  ...UpvoteState.fields,
  id: Schema.String,
  locked: Schema.Boolean,
  viewerCanReact: Schema.Boolean,
  reactionGroups: RawReactionGroupsSchema,
  viewerCanLabel: Schema.Boolean,
  poll: Schema.NullOr(Schema.Struct({ id: Schema.String })),
  repository: Schema.Struct({
    isArchived: Schema.Boolean,
    viewerPermission: Schema.NullOr(Schema.String),
  }),
});
const Discussion = Schema.Struct({
  ...GitHubDiscussionDetail.fields,
  ...DiscussionMetadata.fields,
  isAnswered: Schema.NullOr(Schema.Boolean),
  labels: Schema.optional(
    Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Schema.NullOr(PullRequestLabel)) })),
  ),
  comments: Schema.Struct({ nodes: Schema.Array(Comment), pageInfo: PageInfo }),
});
const Response = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.optional(Schema.Struct({ login: Schema.String })),
    repository: Schema.optional(
      Schema.NullOr(Schema.Struct({ discussion: Schema.NullOr(Discussion) })),
    ),
    node: Schema.optional(Schema.NullOr(Schema.Struct({ replies: Replies }))),
  }),
});
const SummaryResponse = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        discussion: Schema.NullOr(Schema.Struct({ title: GitHubDiscussionDetail.fields.title })),
      }),
    ),
  }),
});
const decodeSummary = Schema.decodeUnknownEffect(Schema.fromJsonString(SummaryResponse));
const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(Response));
const upvoteFields = "upvoteCount viewerCanUpvote viewerHasUpvoted";
const commentFields = `id url body createdAt updatedAt author { login avatarUrl url } viewerCanReact ${upvoteFields} ${REACTION_GROUPS_FIELDS}`;
const metadataFields = `id locked viewerCanReact viewerCanLabel poll { id } ${upvoteFields} repository { isArchived viewerPermission } ${REACTION_GROUPS_FIELDS}`;
const pageFields = "pageInfo { hasNextPage endCursor }";
const TargetResponse = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ login: Schema.String }),
    repository: Schema.NullOr(Schema.Struct({ discussion: Schema.NullOr(DiscussionMetadata) })),
    node: Schema.optional(
      Schema.NullOr(
        Schema.Union([
          Schema.Struct({
            ...UpvoteState.fields,
            id: Schema.String,
            viewerCanReact: Schema.Boolean,
            discussion: Schema.Struct({ id: Schema.String }),
            replyTo: Schema.NullOr(Schema.Struct({ id: Schema.String })),
          }),
          Schema.Struct({ id: Schema.String }),
        ]),
      ),
    ),
  }),
});
const CommentResponse = Schema.Struct({
  data: Schema.Struct({
    addDiscussionComment: Schema.Struct({ comment: RawComment }),
  }),
});
const ReactionResponse = Schema.Struct({
  data: Schema.Struct({
    reaction: Schema.Struct({ reactionGroups: RawReactionGroupsSchema }),
  }),
});
const UpvoteResponse = Schema.Struct({
  data: Schema.Struct({
    upvote: Schema.Struct({
      subject: Schema.Struct({ upvoteCount: NonNegativeInt, viewerHasUpvoted: Schema.Boolean }),
    }),
  }),
});
const decodeTarget = Schema.decodeEffect(Schema.fromJsonString(TargetResponse));
const decodeComment = Schema.decodeEffect(Schema.fromJsonString(CommentResponse));
const decodeReaction = Schema.decodeEffect(Schema.fromJsonString(ReactionResponse));
const decodeUpvote = Schema.decodeEffect(Schema.fromJsonString(UpvoteResponse));
const MetadataRepository = Schema.Struct({
  id: Schema.String,
  isArchived: Schema.Boolean,
  viewerPermission: Schema.NullOr(Schema.String),
});
const MetadataTarget = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        ...MetadataRepository.fields,
        discussion: Schema.NullOr(
          Schema.Struct({
            id: Schema.String,
            viewerCanLabel: Schema.Boolean,
            poll: Schema.NullOr(Schema.Struct({ id: Schema.String })),
            category: GitHubDiscussionCategory,
            isAnswered: Schema.NullOr(Schema.Boolean),
          }),
        ),
      }),
    ),
    node: Schema.NullOr(
      Schema.Union([
        Schema.Struct({
          __typename: Schema.Literal("Label"),
          ...GitHubDiscussionLabel.fields,
          repository: Schema.Struct({ id: Schema.String }),
        }),
        Schema.Struct({
          __typename: Schema.Literal("DiscussionCategory"),
          ...GitHubDiscussionCategory.fields,
          repository: Schema.Struct({ id: Schema.String }),
        }),
        Schema.Struct({ __typename: Schema.String }),
      ]),
    ),
  }),
});
const MetadataOptionsResponse = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        labels: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              nodes: Schema.Array(Schema.NullOr(GitHubDiscussionLabel)),
              pageInfo: PageInfo,
            }),
          ),
        ),
        discussionCategories: Schema.optional(
          Schema.Struct({
            nodes: Schema.Array(Schema.NullOr(GitHubDiscussionCategory)),
            pageInfo: PageInfo,
          }),
        ),
      }),
    ),
  }),
});
const LabelMutationResponse = Schema.Struct({
  data: Schema.Struct({
    labels: Schema.Struct({ labelable: Schema.Struct({ id: Schema.String }) }),
  }),
});
const CategoryMutationResponse = Schema.Struct({
  data: Schema.Struct({
    updateDiscussion: Schema.Struct({
      discussion: Schema.Struct({
        id: Schema.String,
        category: GitHubDiscussionCategory,
        isAnswered: Schema.NullOr(Schema.Boolean),
      }),
    }),
  }),
});

const decodeMetadataOptions = Schema.decodeEffect(Schema.fromJsonString(MetadataOptionsResponse));
const decodeMetadataTarget = Schema.decodeEffect(Schema.fromJsonString(MetadataTarget));
const decodeLabelMutation = Schema.decodeEffect(Schema.fromJsonString(LabelMutationResponse));
const decodeCategoryMutation = Schema.decodeEffect(Schema.fromJsonString(CategoryMutationResponse));

// github documents category moves for repository members with triage access or greater.
function canEditCategory(
  repository: { isArchived: boolean; viewerPermission: string | null },
  poll: { id: string } | null,
) {
  return (
    !repository.isArchived &&
    poll === null &&
    ["TRIAGE", "WRITE", "MAINTAIN", "ADMIN"].includes(repository.viewerPermission ?? "")
  );
}

const encodeRequest = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      query: Schema.String,
      variables: Schema.Record(
        Schema.String,
        Schema.Union([Schema.String, Schema.Number, Schema.Null]),
      ),
    }),
  ),
);

function normalizeComment(
  comment: typeof RawComment.Type,
  viewer: string | null,
): GitHubDiscussionComment {
  const { reactionGroups, ...post } = comment;
  return { ...post, reactions: toReactions(reactionGroups, viewer) };
}

export class GitHubDiscussions extends Context.Service<
  GitHubDiscussions,
  {
    readonly metadataOptions: (
      input: Omit<GitHubDiscussionMetadataOptionsInput, "threadId"> & { readonly cwd: string },
    ) => Effect.Effect<GitHubDiscussionMetadataOptions, DiscussionOperationError>;
    readonly setLabel: (
      input: Omit<GitHubDiscussionSetLabelInput, "threadId"> & { readonly cwd: string },
    ) => Effect.Effect<GitHubDiscussionSetLabelResult, DiscussionOperationError>;
    readonly setCategory: (
      input: Omit<GitHubDiscussionSetCategoryInput, "threadId"> & { readonly cwd: string },
    ) => Effect.Effect<GitHubDiscussionSetCategoryResult, DiscussionOperationError>;
    readonly summary: (input: {
      readonly cwd: string;
      readonly url: string;
    }) => Effect.Effect<{ readonly title: string }, DiscussionOperationError>;
    readonly read: (input: {
      readonly cwd: string;
      readonly url: string;
    }) => Effect.Effect<GitHubDiscussionDetail, DiscussionOperationError>;
    readonly comment: (
      input: Omit<GitHubDiscussionCommentInput, "threadId"> & {
        readonly cwd: string;
      },
    ) => Effect.Effect<GitHubDiscussionCommentResult, DiscussionOperationError>;
    readonly setReaction: (
      input: Omit<GitHubDiscussionReactionInput, "threadId"> & {
        readonly cwd: string;
      },
    ) => Effect.Effect<GitHubDiscussionReactionResult, DiscussionOperationError>;
    readonly setUpvote: (
      input: Omit<GitHubDiscussionUpvoteInput, "threadId"> & {
        readonly cwd: string;
      },
    ) => Effect.Effect<GitHubDiscussionUpvoteResult, DiscussionOperationError>;
  }
>()("t3/sourceControl/GitHubDiscussions") {}

const make = Effect.gen(function* () {
  const cli = yield* GitHubCli.GitHubCli;
  const query = Effect.fn("GitHubDiscussions.query")(function* (
    cwd: string,
    document: string,
    variables: Readonly<Record<string, string | number | null>>,
  ) {
    const output = yield* cli
      .query({ cwd, host: "github.com", document, variables })
      .pipe(Effect.mapError((cause) => new DiscussionOperationError({ message: cause.message })));
    return yield* decodeResponse(output.stdout).pipe(
      Effect.mapError(
        () =>
          new DiscussionOperationError({
            message: "GitHub returned an invalid discussion response.",
          }),
      ),
    );
  });

  const read = Effect.fn("GitHubDiscussions.read")(function* ({
    cwd,
    url,
  }: {
    readonly cwd: string;
    readonly url: string;
  }) {
    const target = parseGitHubConversationUrl(url);
    if (target?.kind !== "discussion")
      return yield* new DiscussionOperationError({
        message: "Use a github.com repository discussion URL.",
      });
    let after: string | null = null;
    let detail: GitHubDiscussionDetail | undefined;
    const comments: Array<GitHubDiscussionDetail["comments"][number]> = [];
    const commentCursors = new Set<string>();
    while (true) {
      const response: typeof Response.Type = yield* query(
        cwd,
        `query($owner: String!, $name: String!, $number: Int!, $after: String) { viewer { login } repository(owner: $owner, name: $name) { discussion(number: $number) { ${metadataFields} number url title body author { login avatarUrl url } createdAt updatedAt closed isAnswered category { id name emoji } ${detail === undefined ? "labels(first: 100) { nodes { name color } }" : ""} comments(first: 100, after: $after) { nodes { ${commentFields} replies(first: 20) { nodes { ${commentFields} } ${pageFields} } } ${pageFields} } } } }`,
        { owner: target.owner, name: target.repository, number: target.number, after },
      );
      const discussion = response.data.repository?.discussion;
      if (!discussion)
        return yield* new DiscussionOperationError({
          message: "Discussion not found. Check GitHub sign-in and repository access.",
        });
      const viewer = response.data.viewer?.login ?? null;
      const { repository, reactionGroups, labels, poll, viewerCanLabel, ...post } = discussion;
      detail ??= {
        ...post,
        isAnswered: discussion.isAnswered ?? false,
        canComment: !discussion.locked && !repository.isArchived,
        canEditLabels: viewerCanLabel && !repository.isArchived,
        canEditCategory: canEditCategory(repository, poll),
        reactions: toReactions(reactionGroups, viewer),
        labels: labels?.nodes.filter((label) => label !== null) ?? [],
        comments: [],
      };
      for (const comment of discussion.comments.nodes) {
        const replies = [...comment.replies.nodes];
        let page = comment.replies;
        const replyCursors = new Set<string>();
        while (page.pageInfo.hasNextPage) {
          const cursor = page.pageInfo.endCursor;
          if (!cursor || replyCursors.has(cursor))
            return yield* new DiscussionOperationError({
              message: "GitHub did not return the next page of discussion replies.",
            });
          replyCursors.add(cursor);
          const response: typeof Response.Type = yield* query(
            cwd,
            `query($id: ID!, $after: String!) { node(id: $id) { ... on DiscussionComment { replies(first: 100, after: $after) { nodes { ${commentFields} } ${pageFields} } } } }`,
            { id: comment.id, after: cursor },
          );
          if (!response.data.node)
            return yield* new DiscussionOperationError({
              message: "A discussion comment is no longer available. Refresh the discussion.",
            });
          page = response.data.node.replies;
          replies.push(...page.nodes);
        }
        comments.push({
          ...normalizeComment(comment, viewer),
          replies: replies.map((reply) => normalizeComment(reply, viewer)),
        });
      }
      if (!discussion.comments.pageInfo.hasNextPage) break;
      const cursor = discussion.comments.pageInfo.endCursor;
      if (!cursor || commentCursors.has(cursor))
        return yield* new DiscussionOperationError({
          message: "GitHub did not return the next page of discussion comments.",
        });
      commentCursors.add(cursor);
      after = cursor;
    }
    return { ...detail, comments };
  });
  const summary = Effect.fn("GitHubDiscussions.summary")(function* ({
    cwd,
    url,
  }: {
    readonly cwd: string;
    readonly url: string;
  }) {
    const target = parseGitHubConversationUrl(url);
    if (target?.kind !== "discussion")
      return yield* new DiscussionOperationError({
        message: "Use a github.com repository discussion URL.",
      });
    const output = yield* cli
      .query({
        cwd,
        host: "github.com",
        document:
          "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { discussion(number: $number) { title } } }",
        variables: { owner: target.owner, name: target.repository, number: target.number },
      })
      .pipe(Effect.mapError((cause) => new DiscussionOperationError({ message: cause.message })));
    const result = yield* decodeSummary(output.stdout).pipe(
      Effect.mapError(
        () =>
          new DiscussionOperationError({
            message: "GitHub returned an invalid discussion response.",
          }),
      ),
    );
    const discussion = result.data.repository?.discussion;
    if (!discussion)
      return yield* new DiscussionOperationError({
        message: "Discussion not found. Check GitHub sign-in and repository access.",
      });
    return discussion;
  });
  // read only the selected discussion and node before writing, never the whole comment tree.
  const target = Effect.fn("GitHubDiscussions.target")(function* (
    cwd: string,
    url: string,
    subjectId?: string,
  ) {
    const parsed = parseGitHubConversationUrl(url);
    if (parsed?.kind !== "discussion")
      return yield* new DiscussionOperationError({
        message: "Use a github.com repository discussion URL.",
      });
    const output = yield* cli
      .query({
        cwd,
        host: "github.com",
        document: `query($owner: String!, $name: String!, $number: Int!${subjectId === undefined ? "" : ", $id: ID!"}) { viewer { login } repository(owner: $owner, name: $name) { discussion(number: $number) { ${metadataFields} } } ${subjectId === undefined ? "" : `node(id: $id) { id ... on DiscussionComment { viewerCanReact ${upvoteFields} discussion { id } replyTo { id } } }`} }`,
        variables: {
          owner: parsed.owner,
          name: parsed.repository,
          number: parsed.number,
          ...(subjectId === undefined ? {} : { id: subjectId }),
        },
      })
      .pipe(Effect.mapError((cause) => new DiscussionOperationError({ message: cause.message })));
    const response = yield* decodeTarget(output.stdout).pipe(
      Effect.mapError(
        () =>
          new DiscussionOperationError({
            message: "GitHub returned an invalid discussion response.",
          }),
      ),
    );
    const discussion = response.data.repository?.discussion;
    if (!discussion)
      return yield* new DiscussionOperationError({
        message: "Discussion not found. Check GitHub sign-in and repository access.",
      });
    const node =
      response.data.node && "discussion" in response.data.node ? response.data.node : null;
    if (
      subjectId !== undefined &&
      subjectId !== discussion.id &&
      (!node || node.discussion.id !== discussion.id)
    )
      return yield* new DiscussionOperationError({
        message: "That comment does not belong to this discussion. Refresh the discussion.",
      });
    return { discussion, node, viewer: response.data.viewer.login };
  });

  const mutate = Effect.fn("GitHubDiscussions.mutate")(function* (
    cwd: string,
    document: string,
    variables: Readonly<Record<string, string | number | null>>,
  ) {
    // mutations bypass the read budget and are never retried, since a timeout may follow a successful write.
    return yield* cli
      .execute({
        cwd,
        args: ["api", "graphql", "--hostname", "github.com", "--input", "-"],
        stdin: encodeRequest({ query: document, variables }),
      })
      .pipe(Effect.mapError((cause) => new DiscussionOperationError({ message: cause.message })));
  });

  const comment: GitHubDiscussions["Service"]["comment"] = Effect.fn("GitHubDiscussions.comment")(
    function* (input) {
      if (!input.body.trim() || input.body.length > 65_536)
        return yield* new DiscussionOperationError({
          message: "Write a comment between 1 and 65,536 characters.",
        });
      const { discussion, node, viewer } = yield* target(input.cwd, input.url, input.replyToId);
      if (discussion.locked || discussion.repository.isArchived)
        return yield* new DiscussionOperationError({
          message:
            "This discussion is locked or its repository is archived. Comments are unavailable.",
        });
      if (input.replyToId !== undefined && !node)
        return yield* new DiscussionOperationError({ message: "Choose a comment to reply to." });
      const replyToId = node?.replyTo?.id ?? node?.id ?? null;
      const output = yield* mutate(
        input.cwd,
        `mutation($discussionId: ID!, $body: String!, $replyToId: ID) { addDiscussionComment(input: { discussionId: $discussionId, body: $body, replyToId: $replyToId }) { comment { ${commentFields} } } }`,
        { discussionId: discussion.id, body: input.body, replyToId },
      );
      const result = yield* decodeComment(output.stdout).pipe(
        Effect.mapError(
          () =>
            new DiscussionOperationError({
              message:
                "GitHub did not confirm the comment. Refresh the discussion before trying again.",
            }),
        ),
      );
      return {
        comment: normalizeComment(result.data.addDiscussionComment.comment, viewer),
        replyToId,
      };
    },
  );

  const setReaction: GitHubDiscussions["Service"]["setReaction"] = Effect.fn(
    "GitHubDiscussions.setReaction",
  )(function* (input) {
    const { discussion, node, viewer } = yield* target(input.cwd, input.url, input.subjectId);
    const subject = input.subjectId === discussion.id ? discussion : node;
    if (!subject?.viewerCanReact || discussion.locked || discussion.repository.isArchived)
      return yield* new DiscussionOperationError({
        message: "Your GitHub account cannot react to this discussion.",
      });
    const output = yield* mutate(
      input.cwd,
      `mutation($subjectId: ID!, $content: ReactionContent!) { reaction: ${input.reacted ? "addReaction" : "removeReaction"}(input: { subjectId: $subjectId, content: $content }) { ${REACTION_GROUPS_FIELDS} } }`,
      { subjectId: input.subjectId, content: gitHubReactionContent(input.content) },
    );
    const result = yield* decodeReaction(output.stdout).pipe(
      Effect.mapError(
        () =>
          new DiscussionOperationError({
            message:
              "GitHub did not confirm the reaction. Refresh the discussion before trying again.",
          }),
      ),
    );
    return {
      subjectId: input.subjectId,
      reactions: toReactions(result.data.reaction.reactionGroups, viewer),
    };
  });

  const setUpvote: GitHubDiscussions["Service"]["setUpvote"] = Effect.fn(
    "GitHubDiscussions.setUpvote",
  )(function* (input) {
    const { discussion, node } = yield* target(input.cwd, input.url, input.subjectId);
    const subject = input.subjectId === discussion.id ? discussion : node;
    if (!subject?.viewerCanUpvote || discussion.locked || discussion.repository.isArchived)
      return yield* new DiscussionOperationError({
        message: "Your GitHub account cannot upvote this discussion or comment.",
      });
    if (subject.viewerHasUpvoted === input.upvoted)
      return {
        subjectId: input.subjectId,
        upvoteCount: subject.upvoteCount,
        viewerHasUpvoted: subject.viewerHasUpvoted,
      };
    const output = yield* mutate(
      input.cwd,
      `mutation($subjectId: ID!) { upvote: ${input.upvoted ? "addUpvote" : "removeUpvote"}(input: { subjectId: $subjectId }) { subject { upvoteCount viewerHasUpvoted } } }`,
      { subjectId: input.subjectId },
    );
    const result = yield* decodeUpvote(output.stdout).pipe(
      Effect.mapError(
        () =>
          new DiscussionOperationError({
            message:
              "GitHub did not confirm the upvote. Refresh the discussion before trying again.",
          }),
      ),
    );
    return { subjectId: input.subjectId, ...result.data.upvote.subject };
  });

  const metadataOptions: GitHubDiscussions["Service"]["metadataOptions"] = Effect.fn(
    "GitHubDiscussions.metadataOptions",
  )(function* (input) {
    const parsed = parseGitHubConversationUrl(input.url);
    if (parsed?.kind !== "discussion")
      return yield* new DiscussionOperationError({
        message: "Use a github.com repository discussion URL.",
      });
    const labels: Array<typeof GitHubDiscussionLabel.Type> = [];
    const categories: Array<typeof GitHubDiscussionCategory.Type> = [];
    const cursors = new Set<string>();
    let truncated = false;
    let after: string | null = null;
    while (true) {
      const output = yield* cli
        .query({
          cwd: input.cwd,
          host: "github.com",
          document: `query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) { ${input.kind === "labels" ? "labels(first: 100, after: $after) { nodes { id name color description }" : "discussionCategories(first: 100, after: $after) { nodes { id name emoji }"} ${pageFields} } } }`,
          variables: { owner: parsed.owner, name: parsed.repository, after },
        })
        .pipe(Effect.mapError((cause) => new DiscussionOperationError({ message: cause.message })));
      const response: typeof MetadataOptionsResponse.Type = yield* decodeMetadataOptions(
        output.stdout,
      ).pipe(
        Effect.mapError(
          () =>
            new DiscussionOperationError({
              message: "GitHub returned invalid discussion options.",
            }),
        ),
      );
      const repository = response.data.repository;
      const connection =
        input.kind === "labels" ? repository?.labels : repository?.discussionCategories;
      if (!connection)
        return yield* new DiscussionOperationError({
          message: "Discussion options are unavailable. Check repository access.",
        });
      labels.push(...(repository?.labels?.nodes.filter((label) => label !== null) ?? []));
      categories.push(
        ...(repository?.discussionCategories?.nodes.filter((category) => category !== null) ?? []),
      );
      if (!connection.pageInfo.hasNextPage) break;
      if (cursors.size >= 4) {
        truncated = true;
        break;
      }
      const cursor = connection.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor))
        return yield* new DiscussionOperationError({
          message: "GitHub did not return the next page of discussion options.",
        });
      cursors.add(cursor);
      after = cursor;
    }
    return { labels, categories, truncated };
  });

  const metadataTarget = Effect.fn("GitHubDiscussions.metadataTarget")(function* (
    cwd: string,
    url: string,
    id: string,
  ) {
    const parsed = parseGitHubConversationUrl(url);
    if (parsed?.kind !== "discussion")
      return yield* new DiscussionOperationError({
        message: "Use a github.com repository discussion URL.",
      });
    const output = yield* cli
      .query({
        cwd,
        host: "github.com",
        document: `query($owner: String!, $name: String!, $number: Int!, $id: ID!) { repository(owner: $owner, name: $name) { id isArchived viewerPermission discussion(number: $number) { id viewerCanLabel poll { id } category { id name emoji } isAnswered } } node(id: $id) { __typename ... on Label { id name color description repository { id } } ... on DiscussionCategory { id name emoji repository { id } } } }`,
        variables: { owner: parsed.owner, name: parsed.repository, number: parsed.number, id },
      })
      .pipe(Effect.mapError((cause) => new DiscussionOperationError({ message: cause.message })));
    const response = yield* decodeMetadataTarget(output.stdout).pipe(
      Effect.mapError(
        () =>
          new DiscussionOperationError({ message: "GitHub returned invalid discussion metadata." }),
      ),
    );
    const repository = response.data.repository;
    if (!repository?.discussion)
      return yield* new DiscussionOperationError({
        message: "Discussion not found. Check GitHub sign-in and repository access.",
      });
    return { repository, discussion: repository.discussion, node: response.data.node };
  });

  const setLabel: GitHubDiscussions["Service"]["setLabel"] = Effect.fn(
    "GitHubDiscussions.setLabel",
  )(function* (input) {
    const { repository, discussion, node } = yield* metadataTarget(
      input.cwd,
      input.url,
      input.labelId,
    );
    if (repository.isArchived || !discussion.viewerCanLabel)
      return yield* new DiscussionOperationError({
        message: "Your GitHub account cannot change this discussion's labels.",
      });
    if (!node || !("color" in node) || node.repository.id !== repository.id)
      return yield* new DiscussionOperationError({
        message: "Choose a label from this discussion's repository.",
      });
    const output = yield* mutate(
      input.cwd,
      `mutation($discussionId: ID!, $labelId: ID!) { labels: ${input.applied ? "addLabelsToLabelable" : "removeLabelsFromLabelable"}(input: { labelableId: $discussionId, labelIds: [$labelId] }) { labelable { ... on Discussion { id } } } }`,
      { discussionId: discussion.id, labelId: input.labelId },
    );
    const response = yield* decodeLabelMutation(output.stdout).pipe(
      Effect.mapError(
        () =>
          new DiscussionOperationError({
            message:
              "GitHub did not confirm the labels. Refresh the discussion before trying again.",
          }),
      ),
    );
    if (response.data.labels.labelable.id !== discussion.id)
      return yield* new DiscussionOperationError({
        message: "GitHub did not confirm this discussion's labels. Refresh before trying again.",
      });
    return { label: { name: node.name, color: node.color }, applied: input.applied };
  });

  const setCategory: GitHubDiscussions["Service"]["setCategory"] = Effect.fn(
    "GitHubDiscussions.setCategory",
  )(function* (input) {
    const { repository, discussion, node } = yield* metadataTarget(
      input.cwd,
      input.url,
      input.categoryId,
    );
    if (!canEditCategory(repository, discussion.poll))
      return yield* new DiscussionOperationError({
        message: "This discussion's category cannot be changed by your GitHub account.",
      });
    if (!node || !("emoji" in node) || node.repository.id !== repository.id)
      return yield* new DiscussionOperationError({
        message: "Choose a category from this discussion's repository.",
      });
    if (discussion.category.id === input.categoryId)
      return { category: discussion.category, isAnswered: discussion.isAnswered ?? false };
    const output = yield* mutate(
      input.cwd,
      "mutation($discussionId: ID!, $categoryId: ID!) { updateDiscussion(input: { discussionId: $discussionId, categoryId: $categoryId }) { discussion { id category { id name emoji } isAnswered } } }",
      { discussionId: discussion.id, categoryId: input.categoryId },
    );
    const response = yield* decodeCategoryMutation(output.stdout).pipe(
      Effect.mapError(
        () =>
          new DiscussionOperationError({
            message:
              "GitHub did not confirm the category. Refresh the discussion before trying again.",
          }),
      ),
    );
    const updated = response.data.updateDiscussion.discussion;
    if (updated.id !== discussion.id || updated.category.id !== input.categoryId)
      return yield* new DiscussionOperationError({
        message: "GitHub did not confirm this discussion's category. Refresh before trying again.",
      });
    return { category: updated.category, isAnswered: updated.isAnswered ?? false };
  });

  return GitHubDiscussions.of({
    read,
    summary,
    comment,
    setReaction,
    setUpvote,
    metadataOptions,
    setLabel,
    setCategory,
  });
});

export const layer = Layer.effect(GitHubDiscussions, make);
