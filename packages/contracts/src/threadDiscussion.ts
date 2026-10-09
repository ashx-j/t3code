import * as Schema from "effect/Schema";
import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
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

export class DiscussionOperationError extends Schema.TaggedError<DiscussionOperationError>()(
  "DiscussionOperationError",
  { message: Schema.String },
) {}
