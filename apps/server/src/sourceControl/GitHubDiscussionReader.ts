import {
  DiscussionOperationError,
  GitHubDiscussionComment,
  GitHubDiscussionDetail,
  parseGitHubConversationUrl,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as GitHubCli from "./GitHubCli.ts";

const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});
const Replies = Schema.Struct({ nodes: Schema.Array(GitHubDiscussionComment), pageInfo: PageInfo });
const Comment = Schema.Struct({ ...GitHubDiscussionComment.fields, replies: Replies });
const Discussion = Schema.Struct({
  ...GitHubDiscussionDetail.fields,
  isAnswered: Schema.NullOr(Schema.Boolean),
  comments: Schema.Struct({ nodes: Schema.Array(Comment), pageInfo: PageInfo }),
});
const Response = Schema.Struct({
  data: Schema.Struct({
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
const commentFields = "id url body createdAt updatedAt author { login avatarUrl url }";
const pageFields = "pageInfo { hasNextPage endCursor }";

export class GitHubDiscussionReader extends Context.Service<
  GitHubDiscussionReader,
  {
    readonly summary: (input: {
      readonly cwd: string;
      readonly url: string;
    }) => Effect.Effect<{ readonly title: string }, DiscussionOperationError>;
    readonly read: (input: {
      readonly cwd: string;
      readonly url: string;
    }) => Effect.Effect<GitHubDiscussionDetail, DiscussionOperationError>;
  }
>()("t3/sourceControl/GitHubDiscussionReader") {}

const make = Effect.gen(function* () {
  const cli = yield* GitHubCli.GitHubCli;
  const query = Effect.fn("GitHubDiscussionReader.query")(function* (
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

  const read = Effect.fn("GitHubDiscussionReader.read")(function* ({
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
        `query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) { discussion(number: $number) { number url title body author { login avatarUrl url } createdAt updatedAt closed isAnswered category { name emoji } comments(first: 100, after: $after) { nodes { ${commentFields} replies(first: 100) { nodes { ${commentFields} } ${pageFields} } } ${pageFields} } } } }`,
        { owner: target.owner, name: target.repository, number: target.number, after },
      );
      const discussion = response.data.repository?.discussion;
      if (!discussion)
        return yield* new DiscussionOperationError({
          message: "Discussion not found. Check GitHub sign-in and repository access.",
        });
      detail ??= { ...discussion, isAnswered: discussion.isAnswered ?? false, comments: [] };
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
        comments.push({ ...comment, replies });
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
  const summary = Effect.fn("GitHubDiscussionReader.summary")(function* ({
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
  return GitHubDiscussionReader.of({ read, summary });
});

export const layer = Layer.effect(GitHubDiscussionReader, make);
