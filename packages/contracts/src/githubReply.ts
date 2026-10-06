import * as Schema from "effect/Schema";
import { CommandId, IsoDateTime } from "./baseSchemas.ts";

/** PR comments are flat; discussion anchors select one comment and its replies. */
export function parseGitHubConversationUrl(value: string) {
  const match =
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|discussions)\/([1-9]\d*)(?:#(issuecomment-\d+|discussioncomment-\d+|discussion_r\d+|pullrequestreview-\d+))?\/?$/.exec(
      value,
    );
  if (!match) return null;
  const [, owner, repository, kind, number, anchor] = match;
  if (kind === "pull" && anchor?.startsWith("discussioncomment-")) return null;
  if (kind === "discussions" && anchor && !anchor.startsWith("discussioncomment-")) return null;
  return {
    owner: owner!,
    repository: repository!,
    kind: kind === "pull" ? ("pull" as const) : ("discussion" as const),
    number: Number(number),
    commentId:
      kind === "discussions" && anchor ? Number(anchor.slice("discussioncomment-".length)) : null,
    url: `https://github.com/${owner}/${repository}/${kind}/${number}${anchor ? `#${anchor}` : ""}`,
  };
}

export const GitHubConversationUrl = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) =>
        parseGitHubConversationUrl(value) !== null ||
        "Use a github.com pull request or repository discussion URL.",
    ),
  ),
);

export const GitHubReplySnooze = Schema.Struct({
  requestId: CommandId,
  url: GitHubConversationUrl,
  startedAt: IsoDateTime,
  nextCheckAt: IsoDateTime,
  status: Schema.Literals(["pending", "watching", "retrying", "rate-limited"]),
  failures: Schema.Number,
  viewer: Schema.optional(Schema.String),
  discussionCommentId: Schema.optional(Schema.String),
});
export type GitHubReplySnooze = typeof GitHubReplySnooze.Type;

export const GitHubReplyNotice = Schema.Struct({
  type: Schema.Literals(["reply", "error"]),
  url: Schema.String,
  receivedAt: IsoDateTime,
  author: Schema.optional(Schema.String),
  text: Schema.String,
});
export type GitHubReplyNotice = typeof GitHubReplyNotice.Type;
