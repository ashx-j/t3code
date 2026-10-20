import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { parseGitHubConversationUrl } from "./githubReply.ts";
import {
  PullRequestLabel,
  PullRequestReaction,
  PullRequestReactionContent,
} from "./pullRequest.ts";

export const GitHubDiscussionUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (url) =>
      parseGitHubConversationUrl(url)?.kind === "discussion" ||
      "Use a github.com repository discussion URL.",
  ),
);

export const ThreadDiscussionKey = Schema.Struct({
  host: Schema.Literal("github.com"),
  repository: TrimmedNonEmptyString.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
  number: PositiveInt,
});
export type ThreadDiscussionKey = typeof ThreadDiscussionKey.Type;

export const ThreadDiscussionLink = Schema.Struct({
  ...ThreadDiscussionKey.fields,
  url: GitHubDiscussionUrl,
  title: Schema.NullOr(TrimmedNonEmptyString),
  source: Schema.Literals(["manual", "agent"]),
  linkedAt: IsoDateTime,
});
export type ThreadDiscussionLink = typeof ThreadDiscussionLink.Type;

const GitHubDiscussionActor = Schema.Struct({
  login: Schema.String,
  avatarUrl: Schema.String,
  url: Schema.String,
});

export const GitHubDiscussionComment = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  body: Schema.String,
  author: Schema.NullOr(GitHubDiscussionActor),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  reactions: Schema.optional(Schema.Array(PullRequestReaction)),
  viewerCanReact: Schema.optional(Schema.Boolean),
  upvoteCount: Schema.optional(NonNegativeInt),
  viewerCanUpvote: Schema.optional(Schema.Boolean),
  viewerHasUpvoted: Schema.optional(Schema.Boolean),
});
export type GitHubDiscussionComment = typeof GitHubDiscussionComment.Type;

export const GitHubDiscussionDetailInput = Schema.Struct({
  threadId: ThreadId,
  url: GitHubDiscussionUrl,
});
export type GitHubDiscussionDetailInput = typeof GitHubDiscussionDetailInput.Type;

export const GitHubDiscussionDetail = Schema.Struct({
  id: Schema.optional(TrimmedNonEmptyString),
  number: PositiveInt,
  url: GitHubDiscussionUrl,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  author: Schema.NullOr(GitHubDiscussionActor),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closed: Schema.Boolean,
  isAnswered: Schema.Boolean,
  locked: Schema.optional(Schema.Boolean),
  canComment: Schema.optional(Schema.Boolean),
  viewerCanReact: Schema.optional(Schema.Boolean),
  reactions: Schema.optional(Schema.Array(PullRequestReaction)),
  upvoteCount: Schema.optional(NonNegativeInt),
  viewerCanUpvote: Schema.optional(Schema.Boolean),
  viewerHasUpvoted: Schema.optional(Schema.Boolean),
  canEditLabels: Schema.optional(Schema.Boolean),
  canEditCategory: Schema.optional(Schema.Boolean),
  category: Schema.NullOr(
    Schema.Struct({
      id: Schema.optional(TrimmedNonEmptyString),
      name: Schema.String,
      emoji: Schema.String,
    }),
  ),
  labels: Schema.optional(Schema.Array(PullRequestLabel)),
  commentCount: Schema.optional(NonNegativeInt),
  commentsTruncated: Schema.optional(Schema.Boolean),
  comments: Schema.Array(
    Schema.Struct({
      ...GitHubDiscussionComment.fields,
      replyCount: Schema.optional(NonNegativeInt),
      repliesTruncated: Schema.optional(Schema.Boolean),
      replies: Schema.Array(GitHubDiscussionComment),
    }),
  ),
});
export type GitHubDiscussionDetail = typeof GitHubDiscussionDetail.Type;

export const GitHubDiscussionCommentInput = Schema.Struct({
  ...GitHubDiscussionDetailInput.fields,
  body: Schema.String.check(Schema.isMaxLength(65_536), Schema.isPattern(/\S/)),
  replyToId: Schema.optional(TrimmedNonEmptyString),
});
export type GitHubDiscussionCommentInput = typeof GitHubDiscussionCommentInput.Type;

export const GitHubDiscussionCommentResult = Schema.Struct({
  comment: GitHubDiscussionComment,
  replyToId: Schema.NullOr(TrimmedNonEmptyString),
});
export type GitHubDiscussionCommentResult = typeof GitHubDiscussionCommentResult.Type;

export const GitHubDiscussionReactionInput = Schema.Struct({
  ...GitHubDiscussionDetailInput.fields,
  subjectId: TrimmedNonEmptyString,
  content: PullRequestReactionContent,
  reacted: Schema.Boolean,
});
export type GitHubDiscussionReactionInput = typeof GitHubDiscussionReactionInput.Type;

export const GitHubDiscussionReactionResult = Schema.Struct({
  subjectId: TrimmedNonEmptyString,
  reactions: Schema.Array(PullRequestReaction),
});
export type GitHubDiscussionReactionResult = typeof GitHubDiscussionReactionResult.Type;

export const GitHubDiscussionUpvoteInput = Schema.Struct({
  ...GitHubDiscussionDetailInput.fields,
  subjectId: TrimmedNonEmptyString,
  upvoted: Schema.Boolean,
});
export type GitHubDiscussionUpvoteInput = typeof GitHubDiscussionUpvoteInput.Type;

export const GitHubDiscussionUpvoteResult = Schema.Struct({
  subjectId: TrimmedNonEmptyString,
  upvoteCount: NonNegativeInt,
  viewerHasUpvoted: Schema.Boolean,
});
export type GitHubDiscussionUpvoteResult = typeof GitHubDiscussionUpvoteResult.Type;

export const GitHubDiscussionCategory = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  emoji: Schema.String,
});

export const GitHubDiscussionLabel = Schema.Struct({
  ...PullRequestLabel.fields,
  id: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
});

export const GitHubDiscussionMetadataOptionsInput = Schema.Struct({
  ...GitHubDiscussionDetailInput.fields,
  kind: Schema.Literals(["labels", "categories"]),
});
export type GitHubDiscussionMetadataOptionsInput = typeof GitHubDiscussionMetadataOptionsInput.Type;
export const GitHubDiscussionMetadataOptions = Schema.Struct({
  labels: Schema.Array(GitHubDiscussionLabel),
  categories: Schema.Array(GitHubDiscussionCategory),
  truncated: Schema.Boolean,
});
export type GitHubDiscussionMetadataOptions = typeof GitHubDiscussionMetadataOptions.Type;

export const GitHubDiscussionSetLabelInput = Schema.Struct({
  ...GitHubDiscussionDetailInput.fields,
  labelId: TrimmedNonEmptyString,
  applied: Schema.Boolean,
});
export type GitHubDiscussionSetLabelInput = typeof GitHubDiscussionSetLabelInput.Type;
export const GitHubDiscussionSetLabelResult = Schema.Struct({
  label: PullRequestLabel,
  applied: Schema.Boolean,
});
export type GitHubDiscussionSetLabelResult = typeof GitHubDiscussionSetLabelResult.Type;

export const GitHubDiscussionSetCategoryInput = Schema.Struct({
  ...GitHubDiscussionDetailInput.fields,
  categoryId: TrimmedNonEmptyString,
});
export type GitHubDiscussionSetCategoryInput = typeof GitHubDiscussionSetCategoryInput.Type;
export const GitHubDiscussionSetCategoryResult = Schema.Struct({
  category: GitHubDiscussionCategory,
  isAnswered: Schema.Boolean,
});
export type GitHubDiscussionSetCategoryResult = typeof GitHubDiscussionSetCategoryResult.Type;

export class DiscussionOperationError extends Schema.TaggedError<DiscussionOperationError>()(
  "DiscussionOperationError",
  { message: Schema.String },
) {}
