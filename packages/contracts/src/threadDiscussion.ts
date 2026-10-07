import * as Schema from "effect/Schema";
import { IsoDateTime, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { parseGitHubConversationUrl } from "./githubReply.ts";

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
});

export const GitHubDiscussionDetailInput = Schema.Struct({
  threadId: ThreadId,
  url: GitHubDiscussionUrl,
});
export type GitHubDiscussionDetailInput = typeof GitHubDiscussionDetailInput.Type;

export const GitHubDiscussionDetail = Schema.Struct({
  number: PositiveInt,
  url: GitHubDiscussionUrl,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  author: Schema.NullOr(GitHubDiscussionActor),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closed: Schema.Boolean,
  isAnswered: Schema.Boolean,
  category: Schema.NullOr(Schema.Struct({ name: Schema.String, emoji: Schema.String })),
  comments: Schema.Array(
    Schema.Struct({
      ...GitHubDiscussionComment.fields,
      replies: Schema.Array(GitHubDiscussionComment),
    }),
  ),
});
export type GitHubDiscussionDetail = typeof GitHubDiscussionDetail.Type;

export class DiscussionOperationError extends Schema.TaggedError<DiscussionOperationError>()(
  "DiscussionOperationError",
  { message: Schema.String },
) {}
