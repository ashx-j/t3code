import { parseGitHubConversationUrl, type GitHubReplySnooze } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as GitHubCli from "./GitHubCli.ts";

export class GitHubReplyReadError extends Schema.TaggedError<GitHubReplyReadError>()(
  "GitHubReplyReadError",
  {
    reason: Schema.Literals([
      "unavailable",
      "account-changed",
      "comment-not-found",
      "rate-limited",
      "baseline-missing",
    ]),
    retryAt: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.reason) {
      case "rate-limited":
        return "GitHub checks are paused until the API rate limit resets.";
      case "account-changed":
        return "The GitHub account changed. Snooze again using the intended account.";
      case "comment-not-found":
        return "The selected discussion comment is no longer available.";
      case "baseline-missing":
        return "This saved GitHub snooze needs to be renewed. Snooze again to continue checking replies.";
      case "unavailable":
        return "GitHub replies could not be checked. Check GitHub CLI sign-in and repository access, then snooze again.";
    }
  }
}

const Author = Schema.NullOr(Schema.Struct({ login: Schema.String }));
const Comment = Schema.Struct({
  id: Schema.String,
  databaseId: Schema.optional(Schema.NullOr(Schema.Number)),
  createdAt: Schema.String,
  author: Author,
});
const PageInfo = Schema.Struct({
  hasPreviousPage: Schema.Boolean,
  startCursor: Schema.NullOr(Schema.String),
});
const Comments = Schema.Struct({ nodes: Schema.Array(Comment), pageInfo: PageInfo });
const DiscussionComments = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({ ...Comment.fields, replies: Comments })),
  pageInfo: PageInfo,
});
const Reviews = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      ...Comment.fields,
      submittedAt: Schema.NullOr(Schema.String),
      state: Schema.String,
    }),
  ),
  pageInfo: PageInfo,
});
const ReviewThreads = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({ id: Schema.String, comments: Comments })),
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
});
const commentFields = "id databaseId createdAt author { login }";
const pageFields = "pageInfo { hasPreviousPage startCursor }";
const Response = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ login: Schema.String }),
    repository: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          pullRequest: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                comments: Schema.optional(Comments),
                reviews: Schema.optional(Reviews),
                reviewThreads: Schema.optional(ReviewThreads),
              }),
            ),
          ),
          discussion: Schema.optional(
            Schema.NullOr(Schema.Struct({ comments: DiscussionComments })),
          ),
        }),
      ),
    ),
    node: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          replies: Schema.optional(Comments),
          comments: Schema.optional(Comments),
          bodyText: Schema.optional(Schema.String),
          url: Schema.optional(Schema.String),
          author: Schema.optional(Author),
        }),
      ),
    ),
  }),
});
const Reply = Schema.Struct({ url: Schema.String, text: Schema.String, author: Schema.String });
type Reply = typeof Reply.Type;

export class GitHubReplyReader extends Context.Service<
  GitHubReplyReader,
  {
    readonly read: (input: {
      readonly cwd: string;
      readonly watch: GitHubReplySnooze;
      readonly captureBaseline?: boolean;
    }) => Effect.Effect<
      {
        readonly viewer: string;
        readonly discussionCommentId?: string;
        readonly reply: Reply | null;
        readonly baseline: NonNullable<GitHubReplySnooze["baseline"]>;
      },
      GitHubReplyReadError
    >;
  }
>()("t3/sourceControl/GitHubReplyReader") {}

const Variables = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Null]),
);
const QueryKey = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Variables]));
const encodeKey = Schema.encodeSync(QueryKey);
const decodeKey = Schema.decodeUnknownEffect(QueryKey);
const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(Response));

const make = Effect.gen(function* () {
  const cli = yield* GitHubCli.GitHubCli;
  const queryRaw = Effect.fn("GitHubReplyReader.query")(function* (
    cwd: string,
    document: string,
    variables: Readonly<Record<string, string | number | null>>,
  ) {
    const result = yield* cli.query({ cwd, host: "github.com", document, variables }).pipe(
      Effect.mapError(
        (cause) =>
          new GitHubReplyReadError({
            reason: cause._tag === "GitHubCliRateLimitError" ? "rate-limited" : "unavailable",
            ...(cause._tag === "GitHubCliRateLimitError" && cause.retryAt !== undefined
              ? { retryAt: cause.retryAt }
              : {}),
            cause,
          }),
      ),
    );
    return yield* decodeResponse(result.stdout).pipe(
      Effect.mapError((cause) => new GitHubReplyReadError({ reason: "unavailable", cause })),
    );
  });

  const queries = yield* Cache.make({
    capacity: 256,
    timeToLive: "30 seconds",
    lookup: (key: string) =>
      decodeKey(key).pipe(
        Effect.orDie,
        Effect.flatMap(([cwd, document, variables]) => queryRaw(cwd, document, variables)),
      ),
  });
  const query = (
    cwd: string,
    document: string,
    variables: Readonly<Record<string, string | number | null>>,
  ) => Cache.get(queries, encodeKey([cwd, document, variables]));

  const read = Effect.fn("GitHubReplyReader.read")(function* ({
    cwd,
    watch,
    captureBaseline = false,
  }: {
    readonly cwd: string;
    readonly watch: GitHubReplySnooze;
    readonly captureBaseline?: boolean;
  }) {
    const target = parseGitHubConversationUrl(watch.url);
    const changesRequested = watch.wakeCondition === "changes-requested";
    if (!target || (changesRequested && target.kind !== "pull"))
      return yield* new GitHubReplyReadError({ reason: "unavailable" });
    if (!captureBaseline && !watch.baseline)
      return yield* new GitHubReplyReadError({ reason: "baseline-missing" });
    // Setup must see fresh data. Only acknowledge snooze after this observation completes.
    // GitHub has no snapshot across connections; responses observed during setup are existing.
    const readQuery = captureBaseline ? queryRaw : query;
    let baseline = (captureBaseline ? undefined : watch.baseline) ?? { latestAt: null, ids: [] };
    const existingIds = new Set(baseline.ids);
    const observe = (comment: typeof Comment.Type) => {
      if (!captureBaseline) return;
      const timestamp = Date.parse(comment.createdAt);
      const latest = baseline.latestAt === null ? -Infinity : Date.parse(baseline.latestAt);
      if (timestamp > latest) baseline = { latestAt: comment.createdAt, ids: [comment.id] };
      else if (timestamp === latest) baseline = { ...baseline, ids: [...baseline.ids, comment.id] };
    };
    let viewer = watch.viewer;
    const checkViewer = (login: string) => {
      if (viewer !== undefined && viewer !== login)
        return Effect.fail(new GitHubReplyReadError({ reason: "account-changed" }));
      viewer = login;
      return Effect.void;
    };
    const isNew = (comment: typeof Comment.Type) => {
      if (captureBaseline || baseline.latestAt === null) return true;
      const timestamp = Date.parse(comment.createdAt);
      const latest = Date.parse(baseline.latestAt);
      return timestamp > latest || (timestamp === latest && !existingIds.has(comment.id));
    };
    const isBeforeBaseline = (comment: typeof Comment.Type) =>
      baseline.latestAt !== null && Date.parse(comment.createdAt) < Date.parse(baseline.latestAt);
    const mayContainResponse = (comment: typeof Comment.Type) =>
      captureBaseline ? !isBeforeBaseline(comment) : isNew(comment);
    const isResponse = (comment: typeof Comment.Type) => {
      observe(comment);
      return (
        !captureBaseline &&
        isNew(comment) &&
        comment.author !== null &&
        comment.author.login !== viewer
      );
    };
    let responseId: string | undefined;
    let discussionCommentId = watch.discussionCommentId;

    // Replies are paged independently: a newer self-reply must not hide another person's response.
    const readReplies = Effect.fn("GitHubReplyReader.replies")(function* (
      id: string,
      findAnchor?: number,
      reviewThread = false,
    ) {
      let before: string | null = null;
      while (true) {
        const result: typeof Response.Type = yield* readQuery(
          cwd,
          `query($id: ID!, $before: String) { viewer { login } node(id: $id) { ... on ${reviewThread ? "PullRequestReviewThread" : "DiscussionComment"} { ${reviewThread ? "comments" : "replies"}(last: 100, before: $before) { nodes { ${commentFields} } ${pageFields} } } } }`,
          { id, before },
        );
        yield* checkViewer(result.data.viewer.login);
        const page: typeof Comments.Type | undefined = reviewThread
          ? result.data.node?.comments
          : result.data.node?.replies;
        if (!page) return yield* new GitHubReplyReadError({ reason: "comment-not-found" });
        if (findAnchor !== undefined) {
          if (page.nodes.some((comment) => comment.databaseId === findAnchor)) return true;
        } else {
          responseId = page.nodes.find(isResponse)?.id;
          if (responseId || page.nodes.some(isBeforeBaseline)) return false;
        }
        if (!page.pageInfo.hasPreviousPage) return false;
        if (!page.pageInfo.startCursor || page.pageInfo.startCursor === before)
          return yield* new GitHubReplyReadError({ reason: "unavailable" });
        before = page.pageInfo.startCursor;
      }
    });

    if (target.kind === "discussion" && discussionCommentId) {
      yield* readReplies(discussionCommentId);
    } else if (!changesRequested) {
      let before: string | null = null;
      while (true) {
        const field = target.kind === "pull" ? "pullRequest" : "discussion";
        const replies =
          target.kind === "pull"
            ? ""
            : `replies(last: 1) { nodes { ${commentFields} } ${pageFields} }`;
        const result: typeof Response.Type = yield* readQuery(
          cwd,
          `query($owner: String!, $name: String!, $number: Int!, $before: String) { viewer { login } repository(owner: $owner, name: $name) { ${field}(number: $number) { comments(last: 100, before: $before) { nodes { ${commentFields} ${replies} } ${pageFields} } } } }`,
          { owner: target.owner, name: target.repository, number: target.number, before },
        );
        yield* checkViewer(result.data.viewer.login);
        if (target.kind === "pull") {
          const page: typeof Comments.Type | undefined =
            result.data.repository?.pullRequest?.comments;
          if (!page) return yield* new GitHubReplyReadError({ reason: "unavailable" });
          responseId = page.nodes.find(isResponse)?.id;
          if (responseId || page.nodes.some(isBeforeBaseline) || !page.pageInfo.hasPreviousPage)
            break;
          if (!page.pageInfo.startCursor || page.pageInfo.startCursor === before)
            return yield* new GitHubReplyReadError({ reason: "unavailable" });
          before = page.pageInfo.startCursor;
        } else {
          const page: typeof DiscussionComments.Type | undefined =
            result.data.repository?.discussion?.comments;
          if (!page) return yield* new GitHubReplyReadError({ reason: "unavailable" });
          for (const comment of page.nodes) {
            if (target.commentId !== null) {
              if (
                comment.databaseId === target.commentId ||
                (yield* readReplies(comment.id, target.commentId))
              ) {
                discussionCommentId = comment.id;
                yield* readReplies(comment.id);
                break;
              }
            } else {
              if (isResponse(comment)) responseId = comment.id;
              if (!responseId && comment.replies.nodes.some(mayContainResponse))
                yield* readReplies(comment.id);
              if (responseId) break;
            }
          }
          if (responseId || discussionCommentId || !page.pageInfo.hasPreviousPage) break;
          if (!page.pageInfo.startCursor || page.pageInfo.startCursor === before)
            return yield* new GitHubReplyReadError({ reason: "unavailable" });
          before = page.pageInfo.startCursor;
        }
      }
    }
    // reviews and inline threads are independent connections. PR state and CI changes never enter this reader.
    if (target.kind === "pull" && !responseId) {
      let before: string | null = null;
      while (true) {
        const result: typeof Response.Type = yield* readQuery(
          cwd,
          `query($owner: String!, $name: String!, $number: Int!, $before: String) { viewer { login } repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviews(last: 100, before: $before) { nodes { ${commentFields} submittedAt state } ${pageFields} } } } }`,
          { owner: target.owner, name: target.repository, number: target.number, before },
        );
        yield* checkViewer(result.data.viewer.login);
        const page: typeof Reviews.Type | undefined = result.data.repository?.pullRequest?.reviews;
        if (!page) return yield* new GitHubReplyReadError({ reason: "unavailable" });
        responseId = page.nodes.find(
          (review) =>
            (changesRequested
              ? review.state === "CHANGES_REQUESTED"
              : review.state !== "PENDING") &&
            review.submittedAt !== null &&
            isResponse({ ...review, createdAt: review.submittedAt }),
        )?.id;
        if (responseId || !page.pageInfo.hasPreviousPage) break;
        // Reviews are ordered by creation, not submission. An old draft submitted today must still be read.
        if (!page.pageInfo.startCursor || page.pageInfo.startCursor === before)
          return yield* new GitHubReplyReadError({ reason: "unavailable" });
        before = page.pageInfo.startCursor;
      }
      let after: string | null = null;
      while (true) {
        if (changesRequested || responseId) break;
        const result: typeof Response.Type = yield* readQuery(
          cwd,
          `query($owner: String!, $name: String!, $number: Int!, $after: String) { viewer { login } repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $after) { nodes { id comments(last: 1) { nodes { ${commentFields} } ${pageFields} } } pageInfo { hasNextPage endCursor } } } } }`,
          { owner: target.owner, name: target.repository, number: target.number, after },
        );
        yield* checkViewer(result.data.viewer.login);
        const page: typeof ReviewThreads.Type | undefined =
          result.data.repository?.pullRequest?.reviewThreads;
        if (!page) return yield* new GitHubReplyReadError({ reason: "unavailable" });
        for (const thread of page.nodes) {
          if (thread.comments.nodes.some(mayContainResponse))
            yield* readReplies(thread.id, undefined, true);
          if (responseId) break;
        }
        if (responseId || !page.pageInfo.hasNextPage) break;
        if (!page.pageInfo.endCursor || page.pageInfo.endCursor === after)
          return yield* new GitHubReplyReadError({ reason: "unavailable" });
        after = page.pageInfo.endCursor;
      }
    }
    if (target.commentId !== null && !discussionCommentId)
      return yield* new GitHubReplyReadError({ reason: "comment-not-found" });
    let reply: Reply | null = null;
    if (responseId) {
      const result: typeof Response.Type = yield* readQuery(
        cwd,
        "query($id: ID!) { viewer { login } node(id: $id) { ... on IssueComment { bodyText url author { login } } ... on DiscussionComment { bodyText url author { login } } ... on PullRequestReview { bodyText url author { login } } ... on PullRequestReviewComment { bodyText url author { login } } } }",
        { id: responseId },
      );
      yield* checkViewer(result.data.viewer.login);
      const comment = result.data.node;
      if (!comment?.url || comment.bodyText === undefined || !comment.author)
        return yield* new GitHubReplyReadError({ reason: "unavailable" });
      reply = {
        url: comment.url,
        text: comment.bodyText.slice(0, 6000),
        author: comment.author.login,
      };
    }
    if (!viewer) return yield* new GitHubReplyReadError({ reason: "unavailable" });
    return {
      viewer,
      ...(discussionCommentId === undefined ? {} : { discussionCommentId }),
      reply,
      baseline,
    };
  });
  return GitHubReplyReader.of({ read });
});

export const layer = Layer.effect(GitHubReplyReader, make);
