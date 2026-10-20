import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubDiscussions from "./GitHubDiscussions.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCommentRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      query: Schema.String,
      variables: Schema.Struct({
        discussionId: Schema.String,
        body: Schema.String,
        replyToId: Schema.NullOr(Schema.String),
      }),
    }),
  ),
);
const decodeReactionRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      query: Schema.String,
      variables: Schema.Struct({ subjectId: Schema.String, content: Schema.String }),
    }),
  ),
);
const decodeUpvoteRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ query: Schema.String, variables: Schema.Struct({ subjectId: Schema.String }) }),
  ),
);
const url = "https://github.com/team/repo/discussions/1";
const author = {
  login: "someone",
  avatarUrl: "https://avatars.githubusercontent.com/u/1",
  url: "https://github.com/someone",
};
const comment = (id: string) => ({
  id,
  url: `${url}#discussioncomment-${id}`,
  body: `**Comment ${id}**`,
  author,
  createdAt: "2026-10-01T12:00:00Z",
  updatedAt: "2026-10-01T12:00:00Z",
  viewerCanReact: true,
  upvoteCount: 0,
  viewerCanUpvote: true,
  viewerHasUpvoted: false,
  reactionGroups: [],
});
const page = <T>(
  nodes: ReadonlyArray<T>,
  cursor: string | null = null,
  totalCount = nodes.length,
) => ({
  nodes,
  totalCount,
  pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
});
const discussion = (comments: ReturnType<typeof page>) => ({
  data: {
    viewer: { login: "someone" },
    repository: {
      discussion: {
        id: "discussion-id",
        locked: false,
        viewerCanReact: true,
        viewerCanLabel: true,
        poll: null,
        upvoteCount: 3,
        viewerCanUpvote: true,
        viewerHasUpvoted: false,
        reactionGroups: [],
        repository: { isArchived: false, viewerPermission: "TRIAGE" },
        number: 1,
        url,
        title: "A discussion",
        body: "**Body**",
        author,
        createdAt: "2026-10-01T12:00:00Z",
        updatedAt: "2026-10-01T12:00:00Z",
        closed: false,
        isAnswered: null,
        category: { name: "General", emoji: ":speech_balloon:" },
        labels: { nodes: [{ name: "ideas", color: "aabbcc" }, null] },
        comments,
      },
    },
  },
});

function layer(
  responses: ReadonlyArray<unknown>,
  queries: Array<GitHubApi.GitHubGraphQlInput> = [],
  mutations: Array<GitHubApi.GitHubGraphQlInput> = [],
  mutationFailure?: GitHubApi.GitHubApiError,
) {
  let index = 0;
  return GitHubDiscussions.layer.pipe(
    Layer.provide(
      Layer.mock(GitHubApi.GitHubApi)({
        credential: () =>
          Effect.succeed({ token: Redacted.make("test-token"), fingerprint: "test-account" }),
        graphql: (input) =>
          Effect.gen(function* () {
            const pinned = yield* GitHubApi.PinnedGitHubCredential;
            assert.equal(pinned?.credentialFingerprint, "test-account");
            if (input.query.startsWith("mutation")) {
              mutations.push(input);
              if (mutationFailure) return yield* mutationFailure;
            } else queries.push(input);
            assert.isBelow(index, responses.length, "unexpected GitHub request");
            return encode(responses[index++]);
          }),
      }),
    ),
  );
}

it.effect("reads one bounded preview with total counts, markdown and deleted authors", () => {
  const queries: Array<GitHubApi.GitHubGraphQlInput> = [];
  const roots = Array.from({ length: 20 }, (_, index) => ({
    ...comment(String(index + 1)),
    author: index === 1 ? null : author,
    replies: page(
      Array.from({ length: 5 }, (_, reply) => comment(`${index}-${reply}`)),
      "more-replies",
      30,
    ),
  }));
  return Effect.gen(function* () {
    const reader = yield* GitHubDiscussions.GitHubDiscussions;
    const result = yield* reader.read({ cwd: "/worktree", url });
    assert.equal(result.body, "**Body**");
    assert.equal(result.isAnswered, false);
    assert.equal(result.upvoteCount, 3);
    assert.equal(result.viewerCanUpvote, true);
    assert.equal(result.viewerHasUpvoted, false);
    assert.deepEqual(result.category, { name: "General", emoji: ":speech_balloon:" });
    assert.deepEqual(result.labels, [{ name: "ideas", color: "aabbcc" }]);
    assert.equal(result.comments[0]?.viewerCanUpvote, true);
    assert.equal(result.comments[0]?.replies[0]?.viewerHasUpvoted, false);
    assert.equal(result.comments[0]?.replies[0]?.body, "**Comment 0-0**");
    assert.isNull(result.comments[1]?.author);
    assert.equal(result.commentCount, 100);
    assert.equal(result.commentsTruncated, true);
    assert.lengthOf(result.comments, 20);
    for (const root of result.comments) {
      assert.equal(root.replyCount, 30);
      assert.equal(root.repliesTruncated, true);
      assert.lengthOf(root.replies, 5);
    }
    assert.lengthOf(queries, 1);
    assert.equal(queries[0]!.host, "github.com");
    assert.equal(queries[0]!.allowReserve, true);
    assert.include(queries[0]!.query, "comments(first: 20)");
    assert.include(queries[0]!.query, "replies(first: 5)");
    assert.include(queries[0]!.query, "labels(first: 100) { nodes { name color } }");
  }).pipe(Effect.provide(layer([discussion(page(roots, "more-comments", 100))], queries)));
});

it.effect.each([null, { nodes: [] }])("reads a discussion without labels: %j", (labels) =>
  Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    const result = yield* service.read({ cwd: "/worktree", url });
    assert.deepEqual(result.labels, []);
  }).pipe(
    Effect.provide(
      layer([
        {
          data: {
            ...discussion(page([])).data,
            repository: {
              discussion: { ...discussion(page([])).data.repository.discussion, labels },
            },
          },
        },
      ]),
    ),
  ),
);

const target = (node: unknown = null, overrides = {}) => ({
  data: {
    viewer: { login: "someone" },
    repository: {
      discussion: {
        id: "discussion-id",
        locked: false,
        viewerCanReact: true,
        viewerCanLabel: true,
        poll: null,
        upvoteCount: 3,
        viewerCanUpvote: true,
        viewerHasUpvoted: false,
        reactionGroups: [],
        repository: { isArchived: false, viewerPermission: "TRIAGE" },
        ...overrides,
      },
    },
    node,
  },
});
const targetComment = (overrides = {}) => ({
  id: "parent-id",
  viewerCanReact: true,
  upvoteCount: 2,
  viewerCanUpvote: true,
  viewerHasUpvoted: false,
  discussion: { id: "discussion-id" },
  replyTo: null,
  ...overrides,
});

it.effect.each([
  { name: "top-level comment", node: null, input: {}, replyToId: null },
  {
    name: "reply",
    node: targetComment(),
    input: { replyToId: "parent-id" },
    replyToId: "parent-id",
  },
  {
    name: "reply to a nested reply",
    node: targetComment({ id: "reply-id", replyTo: { id: "parent-id" } }),
    input: { replyToId: "reply-id" },
    replyToId: "parent-id",
  },
])("posts a $name using the selected discussion and parent", (scenario) => {
  const mutations: Array<GitHubApi.GitHubGraphQlInput> = [];
  const body = "Reply with **Markdown** and $literal\\ncharacters";
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    const result = yield* service.comment({ cwd: "/worktree", url, body, ...scenario.input });
    assert.equal(result.comment.id, "new-id");
    assert.equal(result.replyToId, scenario.replyToId);
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0]!.host, "github.com");
    assert.isTrue(mutations[0]!.allowReserve);
    const request = decodeCommentRequest(encode(mutations[0]!));
    assert.include(request.query, "addDiscussionComment");
    assert.deepEqual(request.variables, {
      discussionId: "discussion-id",
      body,
      replyToId: scenario.replyToId,
    });
  }).pipe(
    Effect.provide(
      layer(
        [target(scenario.node), { data: { addDiscussionComment: { comment: comment("new-id") } } }],
        [],
        mutations,
      ),
    ),
  );
});

it.effect.each([
  {
    name: "locked discussion",
    response: target(null, { locked: true }),
    input: {},
    message: "locked",
  },
  {
    name: "archived repository",
    response: target(null, { repository: { isArchived: true, viewerPermission: "ADMIN" } }),
    input: {},
    message: "archived",
  },
  {
    name: "comment in another discussion",
    response: target(targetComment({ discussion: { id: "another-discussion" } })),
    input: { replyToId: "parent-id" },
    message: "does not belong",
  },
  {
    name: "deleted comment",
    response: target(),
    input: { replyToId: "gone-id" },
    message: "does not belong",
  },
  {
    name: "discussion passed as a reply target",
    response: target({ id: "discussion-id" }),
    input: { replyToId: "discussion-id" },
    message: "Choose a comment",
  },
])("does not post to a $name", (scenario) => {
  const mutations: Array<GitHubApi.GitHubGraphQlInput> = [];
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    const failure = yield* service
      .comment({ cwd: "/worktree", url, body: "Text", ...scenario.input })
      .pipe(Effect.flip);
    assert.include(failure.message, scenario.message);
    assert.lengthOf(mutations, 0);
  }).pipe(Effect.provide(layer([scenario.response], [], mutations)));
});

it.effect("rejects empty or oversized comments before contacting GitHub", () =>
  Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    for (const body of [" \n\t", "a".repeat(65_537)]) {
      const failure = yield* service.comment({ cwd: "/worktree", url, body }).pipe(Effect.flip);
      assert.include(failure.message, "65,536");
    }
  }).pipe(Effect.provide(layer([]))),
);

it.effect.each(
  [true, false].flatMap((reacted) =>
    ["discussion", "comment", "reply"].map((subject) => ({ reacted, subject })),
  ),
)("sets a $subject reaction to $reacted", ({ reacted, subject }) => {
  const mutations: Array<GitHubApi.GitHubGraphQlInput> = [];
  const node =
    subject === "discussion"
      ? { id: "discussion-id" }
      : targetComment({
          id: subject,
          replyTo: subject === "reply" ? { id: "parent-id" } : null,
        });
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    const result = yield* service.setReaction({
      cwd: "/worktree",
      url,
      subjectId: node.id,
      content: "thumbs-up",
      reacted,
    });
    assert.deepEqual(result, {
      subjectId: node.id,
      reactions: reacted
        ? [{ content: "thumbs-up", count: 2, actors: ["friend"], viewerHasReacted: true }]
        : [],
    });
    const request = decodeReactionRequest(encode(mutations[0]!));
    assert.include(request.query, reacted ? "addReaction" : "removeReaction");
    assert.deepEqual(request.variables, { subjectId: node.id, content: "THUMBS_UP" });
  }).pipe(
    Effect.provide(
      layer(
        [
          target(node),
          {
            data: {
              reaction: {
                reactionGroups: reacted
                  ? [
                      {
                        content: "THUMBS_UP",
                        viewerHasReacted: true,
                        reactors: {
                          totalCount: 2,
                          nodes: [{ login: "someone" }, { login: "friend" }],
                        },
                      },
                    ]
                  : [],
              },
            },
          },
        ],
        [],
        mutations,
      ),
    ),
  );
});

it.effect("requires reaction permission and a subject in this discussion", () =>
  Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    for (const message of ["cannot react", "does not belong"]) {
      const failure = yield* service
        .setReaction({
          cwd: "/worktree",
          url,
          subjectId: "parent-id",
          content: "eyes",
          reacted: true,
        })
        .pipe(Effect.flip);
      assert.include(failure.message, message);
    }
  }).pipe(
    Effect.provide(
      layer([
        target(targetComment({ viewerCanReact: false })),
        target(targetComment({ discussion: { id: "other" } })),
      ]),
    ),
  ),
);

it.effect("does not retry an unconfirmed comment mutation", () => {
  const mutations: Array<GitHubApi.GitHubGraphQlInput> = [];
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    const failure = yield* service
      .comment({ cwd: "/worktree", url, body: "Text" })
      .pipe(Effect.flip);
    assert.include(failure.message, "Refresh the discussion before trying again");
    assert.lengthOf(mutations, 1);
  }).pipe(
    Effect.provide(layer([target(), { data: { addDiscussionComment: null } }], [], mutations)),
  );
});

it.effect.each(
  [true, false].flatMap((upvoted) =>
    ["discussion", "comment", "reply"].map((subject) => ({ upvoted, subject })),
  ),
)(
  "sets a $subject upvote to $upvoted and returns GitHub's current count",
  ({ upvoted, subject }) => {
    const mutations: Array<GitHubApi.GitHubGraphQlInput> = [];
    const node =
      subject === "discussion"
        ? { id: "discussion-id" }
        : targetComment({
            id: subject,
            viewerHasUpvoted: !upvoted,
            replyTo: subject === "reply" ? { id: "parent-id" } : null,
          });
    return Effect.gen(function* () {
      const service = yield* GitHubDiscussions.GitHubDiscussions;
      const result = yield* service.setUpvote({
        cwd: "/worktree",
        url,
        subjectId: node.id,
        upvoted,
      });
      assert.deepEqual(result, { subjectId: node.id, upvoteCount: 12, viewerHasUpvoted: upvoted });
      assert.lengthOf(mutations, 1);
      const request = decodeUpvoteRequest(encode(mutations[0]!));
      assert.include(request.query, upvoted ? "addUpvote" : "removeUpvote");
      assert.deepEqual(request.variables, { subjectId: node.id });
    }).pipe(
      Effect.provide(
        layer(
          [
            target(node, { viewerHasUpvoted: !upvoted }),
            { data: { upvote: { subject: { upvoteCount: 12, viewerHasUpvoted: upvoted } } } },
          ],
          [],
          mutations,
        ),
      ),
    );
  },
);

it.effect.each([
  {
    name: "no permission",
    response: target(targetComment({ viewerCanUpvote: false })),
    subjectId: "parent-id",
    message: "cannot upvote",
  },
  {
    name: "archived repository",
    response: target(
      { id: "discussion-id" },
      { repository: { isArchived: true, viewerPermission: "ADMIN" } },
    ),
    subjectId: "discussion-id",
    message: "cannot upvote",
  },
  {
    name: "wrong discussion",
    response: target(targetComment({ discussion: { id: "other" } })),
    subjectId: "parent-id",
    message: "does not belong",
  },
  {
    name: "deleted comment",
    response: target(null),
    subjectId: "parent-id",
    message: "does not belong",
  },
])("does not upvote with $name", ({ response, subjectId, message }) => {
  const mutations: Array<GitHubApi.GitHubGraphQlInput> = [];
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    const failure = yield* service
      .setUpvote({ cwd: "/worktree", url, subjectId, upvoted: true })
      .pipe(Effect.flip);
    assert.include(failure.message, message);
    assert.lengthOf(mutations, 0);
  }).pipe(Effect.provide(layer([response], [], mutations)));
});

it.effect.each([true, false])("does not repeat an upvote already set to %s", (upvoted) => {
  const mutations: Array<GitHubApi.GitHubGraphQlInput> = [];
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    assert.deepEqual(
      yield* service.setUpvote({ cwd: "/worktree", url, subjectId: "parent-id", upvoted }),
      {
        subjectId: "parent-id",
        upvoteCount: 2,
        viewerHasUpvoted: upvoted,
      },
    );
    assert.lengthOf(mutations, 0);
  }).pipe(
    Effect.provide(layer([target(targetComment({ viewerHasUpvoted: upvoted }))], [], mutations)),
  );
});

it.effect("propagates a failed upvote without retrying or reporting a successful vote", () => {
  const mutations: Array<GitHubApi.GitHubGraphQlInput> = [];
  const failure = new GitHubApi.GitHubApiRequestError({
    host: "github.com",
    operation: "discussion-mutation",
    cause: new Error("request failed"),
  });
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    const result = yield* service
      .setUpvote({ cwd: "/worktree", url, subjectId: "parent-id", upvoted: true })
      .pipe(Effect.flip);
    assert.equal(result.message, failure.message);
    assert.lengthOf(mutations, 1);
  }).pipe(Effect.provide(layer([target(targetComment())], [], mutations, failure)));
});

it.effect("links with a title-only read without fetching discussion comments", () => {
  const queries: Array<Parameters<GitHubApi.GitHubApi["Service"]["graphql"]>[0]> = [];
  return Effect.gen(function* () {
    const reader = yield* GitHubDiscussions.GitHubDiscussions;
    assert.deepEqual(yield* reader.summary({ cwd: "/repo", url }), { title: "A title" });
    assert.equal(queries.length, 1);
    assert.notInclude(queries[0]!.query, "comments");
  }).pipe(
    Effect.provide(
      layer([{ data: { repository: { discussion: { title: "A title" } } } }], queries),
    ),
  );
});

it.effect("reports a complete preview when both connections fit in one page", () =>
  Effect.gen(function* () {
    const reader = yield* GitHubDiscussions.GitHubDiscussions;
    const result = yield* reader.read({ cwd: "/repo", url });
    assert.equal(result.commentCount, 1);
    assert.equal(result.commentsTruncated, false);
    assert.equal(result.comments[0]?.replyCount, 1);
    assert.equal(result.comments[0]?.repliesTruncated, false);
  }).pipe(
    Effect.provide(layer([discussion(page([{ ...comment("1"), replies: page([comment("2")]) }]))])),
  ),
);

it.effect("rejects missing discussions and unsupported hosts", () =>
  Effect.gen(function* () {
    const reader = yield* GitHubDiscussions.GitHubDiscussions;
    assert.include(
      (yield* reader.read({ cwd: "/repo", url }).pipe(Effect.flip)).message,
      "not found",
    );
    assert.include(
      (yield* reader
        .read({ cwd: "/repo", url: "https://evil.example/team/repo/discussions/1" })
        .pipe(Effect.flip)).message,
      "github.com",
    );
  }).pipe(Effect.provide(layer([{ data: { repository: { discussion: null } } }]))),
);

const category = { id: "category-id", name: "General", emoji: ":speech_balloon:" };
const newCategory = { id: "new-category-id", name: "Ideas", emoji: ":bulb:" };
const label = { id: "label-id", name: "bug", color: "ff0000", description: null };
const metadataTarget = (node: unknown, repositoryOverrides = {}, discussionOverrides = {}) => ({
  data: {
    repository: {
      id: "repository-id",
      isArchived: false,
      viewerPermission: "TRIAGE",
      discussion: {
        id: "discussion-id",
        viewerCanLabel: true,
        poll: null,
        category,
        isAnswered: true,
        ...discussionOverrides,
      },
      ...repositoryOverrides,
    },
    node,
  },
});
const labelNode = { __typename: "Label", ...label, repository: { id: "repository-id" } };
const categoryNode = {
  __typename: "DiscussionCategory",
  ...newCategory,
  repository: { id: "repository-id" },
};
const decodeMetadataRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      query: Schema.String,
      variables: Schema.Record(Schema.String, Schema.String),
    }),
  ),
);

it.effect.each([
  {
    permission: "TRIAGE",
    viewerCanLabel: true,
    archived: false,
    poll: null,
    labels: true,
    category: true,
  },
  {
    permission: "WRITE",
    viewerCanLabel: false,
    archived: false,
    poll: null,
    labels: false,
    category: true,
  },
  {
    permission: "READ",
    viewerCanLabel: true,
    archived: false,
    poll: null,
    labels: true,
    category: false,
  },
  {
    permission: null,
    viewerCanLabel: false,
    archived: false,
    poll: null,
    labels: false,
    category: false,
  },
  {
    permission: "ADMIN",
    viewerCanLabel: true,
    archived: true,
    poll: null,
    labels: false,
    category: false,
  },
  {
    permission: "MAINTAIN",
    viewerCanLabel: true,
    archived: false,
    poll: { id: "poll" },
    labels: true,
    category: false,
  },
])("derives metadata controls from GitHub permissions: %j", (scenario) =>
  Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    const result = yield* service.read({ cwd: "/worktree", url });
    assert.equal(result.canEditLabels, scenario.labels);
    assert.equal(result.canEditCategory, scenario.category);
  }).pipe(
    Effect.provide(
      layer([
        {
          data: {
            ...discussion(page([])).data,
            repository: {
              discussion: {
                ...discussion(page([])).data.repository.discussion,
                viewerCanLabel: scenario.viewerCanLabel,
                poll: scenario.poll,
                repository: {
                  isArchived: scenario.archived,
                  viewerPermission: scenario.permission,
                },
              },
            },
          },
        },
      ]),
    ),
  ),
);

it.effect.each([true, false])("changes a single label, applied=%s", (applied) => {
  const mutations: Array<GitHubApi.GitHubGraphQlInput> = [];
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    const result = yield* service.setLabel({ cwd: "/worktree", url, labelId: label.id, applied });
    assert.deepEqual(result, { label: { name: label.name, color: label.color }, applied });
    assert.lengthOf(mutations, 1);
    const request = decodeMetadataRequest(encode(mutations[0]!));
    assert.include(request.query, applied ? "addLabelsToLabelable" : "removeLabelsFromLabelable");
    assert.deepEqual(request.variables, { discussionId: "discussion-id", labelId: label.id });
  }).pipe(
    Effect.provide(
      layer(
        [metadataTarget(labelNode), { data: { labels: { labelable: { id: "discussion-id" } } } }],
        [],
        mutations,
      ),
    ),
  );
});

it.effect.each([
  {
    name: "denied label permission",
    response: metadataTarget(labelNode, {}, { viewerCanLabel: false }),
  },
  { name: "archived repository", response: metadataTarget(labelNode, { isArchived: true }) },
  {
    name: "label from another repository",
    response: metadataTarget({ ...labelNode, repository: { id: "other" } }),
  },
  { name: "category supplied as label", response: metadataTarget(categoryNode) },
  { name: "deleted label", response: metadataTarget(null) },
  { name: "missing discussion", response: metadataTarget(labelNode, { discussion: null }) },
])("rejects label updates for $name before writing", ({ response }) => {
  const mutations: Array<GitHubApi.GitHubGraphQlInput> = [];
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    yield* service
      .setLabel({ cwd: "/worktree", url, labelId: label.id, applied: true })
      .pipe(Effect.flip);
    assert.lengthOf(mutations, 0);
  }).pipe(Effect.provide(layer([response], [], mutations)));
});

it.effect("moves categories with triage permission and returns the updated answer state", () => {
  const mutations: Array<GitHubApi.GitHubGraphQlInput> = [];
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    assert.deepEqual(
      yield* service.setCategory({ cwd: "/worktree", url, categoryId: newCategory.id }),
      { category: newCategory, isAnswered: false },
    );
    assert.lengthOf(mutations, 1);
    const request = decodeMetadataRequest(encode(mutations[0]!));
    assert.include(request.query, "updateDiscussion");
    assert.deepEqual(request.variables, {
      discussionId: "discussion-id",
      categoryId: newCategory.id,
    });
  }).pipe(
    Effect.provide(
      layer(
        [
          metadataTarget(categoryNode),
          {
            data: {
              updateDiscussion: {
                discussion: { id: "discussion-id", category: newCategory, isAnswered: null },
              },
            },
          },
        ],
        [],
        mutations,
      ),
    ),
  );
});

it.effect.each([
  {
    name: "read-only member",
    response: metadataTarget(categoryNode, { viewerPermission: "READ" }),
  },
  {
    name: "unknown permission",
    response: metadataTarget(categoryNode, { viewerPermission: null }),
  },
  { name: "archived repository", response: metadataTarget(categoryNode, { isArchived: true }) },
  { name: "poll discussion", response: metadataTarget(categoryNode, {}, { poll: { id: "poll" } }) },
  {
    name: "category from another repository",
    response: metadataTarget({ ...categoryNode, repository: { id: "other" } }),
  },
  { name: "label supplied as category", response: metadataTarget(labelNode) },
  { name: "deleted category", response: metadataTarget(null) },
])("rejects category changes for $name before writing", ({ response }) => {
  const mutations: Array<GitHubApi.GitHubGraphQlInput> = [];
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    yield* service
      .setCategory({ cwd: "/worktree", url, categoryId: newCategory.id })
      .pipe(Effect.flip);
    assert.lengthOf(mutations, 0);
  }).pipe(Effect.provide(layer([response], [], mutations)));
});

it.effect("does not repeat a category change that already applied", () => {
  const mutations: Array<GitHubApi.GitHubGraphQlInput> = [];
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    assert.deepEqual(
      yield* service.setCategory({ cwd: "/worktree", url, categoryId: newCategory.id }),
      { category: newCategory, isAnswered: true },
    );
    assert.lengthOf(mutations, 0);
  }).pipe(
    Effect.provide(
      layer([metadataTarget(categoryNode, {}, { category: newCategory })], [], mutations),
    ),
  );
});

it.effect.each(["label", "category"] as const)("never retries a failed %s mutation", (kind) => {
  const mutations: Array<GitHubApi.GitHubGraphQlInput> = [];
  const failure = new GitHubApi.GitHubApiRequestError({
    host: "github.com",
    operation: "discussion-mutation",
    cause: new Error("request failed"),
  });
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    const operation =
      kind === "label"
        ? service
            .setLabel({ cwd: "/worktree", url, labelId: label.id, applied: true })
            .pipe(Effect.asVoid)
        : service
            .setCategory({ cwd: "/worktree", url, categoryId: newCategory.id })
            .pipe(Effect.asVoid);
    const result = yield* operation.pipe(Effect.flip);
    assert.equal(result.message, failure.message);
    assert.lengthOf(mutations, 1);
  }).pipe(
    Effect.provide(
      layer([metadataTarget(kind === "label" ? labelNode : categoryNode)], [], mutations, failure),
    ),
  );
});

it.effect("reads repository categories without loading labels or discussion comments", () => {
  const queries: Array<GitHubApi.GitHubGraphQlInput> = [];
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    const result = yield* service.metadataOptions({ cwd: "/worktree", url, kind: "categories" });
    assert.deepEqual(result, { labels: [], categories: [category, newCategory], truncated: false });
    assert.notInclude(queries[0]!.query, "labels(");
    assert.notInclude(queries[0]!.query, "comments(");
  }).pipe(
    Effect.provide(
      layer(
        [{ data: { repository: { discussionCategories: page([category, null, newCategory]) } } }],
        queries,
      ),
    ),
  );
});

it.effect("bounds label candidate reads and reports truncation", () => {
  const queries: Array<GitHubApi.GitHubGraphQlInput> = [];
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    const result = yield* service.metadataOptions({ cwd: "/worktree", url, kind: "labels" });
    assert.isTrue(result.truncated);
    assert.lengthOf(result.labels, 5);
    assert.lengthOf(queries, 5);
    assert.deepEqual(
      queries.map((query) => query.variables?.after),
      [null, "1", "2", "3", "4"],
    );
    assert.notInclude(queries[0]!.query, "discussionCategories(");
  }).pipe(
    Effect.provide(
      layer(
        [1, 2, 3, 4, 5].map((index) => ({
          data: { repository: { labels: page([{ ...label, id: `${index}` }], `${index}`) } },
        })),
        queries,
      ),
    ),
  );
});

it.effect.each(["WRITE", "MAINTAIN", "ADMIN"])(
  "allows comments on locked discussions with %s permission",
  (viewerPermission) => {
    const mutations: Array<GitHubApi.GitHubGraphQlInput> = [];
    return Effect.gen(function* () {
      const service = yield* GitHubDiscussions.GitHubDiscussions;
      const result = yield* service.comment({ cwd: "/repo", url, body: "Maintainer reply" });
      assert.equal(result.comment.id, "new");
      assert.lengthOf(mutations, 1);
    }).pipe(
      Effect.provide(
        layer(
          [
            target(null, { locked: true, repository: { isArchived: false, viewerPermission } }),
            { data: { addDiscussionComment: { comment: comment("new") } } },
          ],
          [],
          mutations,
        ),
      ),
    );
  },
);

it.effect.each([null, "READ", "TRIAGE", "WRITE", "MAINTAIN", "ADMIN"])(
  "reports locked discussion comment permission for %s while preserving reactions and votes",
  (viewerPermission) => {
    const response = discussion(page([{ ...comment("1"), replies: page([comment("2")]) }]));
    return Effect.gen(function* () {
      const service = yield* GitHubDiscussions.GitHubDiscussions;
      const result = yield* service.read({ cwd: "/repo", url });
      assert.equal(
        result.canComment,
        ["WRITE", "MAINTAIN", "ADMIN"].includes(viewerPermission ?? ""),
      );
      assert.equal(result.viewerCanReact, true);
      assert.equal(result.viewerCanUpvote, true);
      assert.equal(result.comments[0]?.viewerCanReact, true);
      assert.equal(result.comments[0]?.replies[0]?.viewerCanUpvote, true);
    }).pipe(
      Effect.provide(
        layer([
          {
            data: {
              ...response.data,
              repository: {
                discussion: {
                  ...response.data.repository.discussion,
                  locked: true,
                  repository: { isArchived: false, viewerPermission },
                },
              },
            },
          },
        ]),
      ),
    );
  },
);

it.effect.each(["discussion", "comment", "reply"])(
  "allows permitted reactions and votes on a locked %s for a reader",
  (subject) => {
    const node =
      subject === "discussion"
        ? { id: "discussion-id" }
        : targetComment({
            id: subject,
            replyTo: subject === "reply" ? { id: "parent-id" } : null,
          });
    const response = target(node, {
      locked: true,
      repository: { isArchived: false, viewerPermission: "READ" },
    });
    const mutations: Array<GitHubApi.GitHubGraphQlInput> = [];
    return Effect.gen(function* () {
      const service = yield* GitHubDiscussions.GitHubDiscussions;
      yield* service.setReaction({
        cwd: "/repo",
        url,
        subjectId: node.id,
        content: "heart",
        reacted: true,
      });
      yield* service.setUpvote({ cwd: "/repo", url, subjectId: node.id, upvoted: true });
      assert.lengthOf(mutations, 2);
    }).pipe(
      Effect.provide(
        layer(
          [
            response,
            { data: { reaction: { reactionGroups: [] } } },
            response,
            { data: { upvote: { subject: { upvoteCount: 4, viewerHasUpvoted: true } } } },
          ],
          [],
          mutations,
        ),
      ),
    );
  },
);

it.effect(
  "pins the original account across preflight and mutation, then uses the newly selected account next time",
  () => {
    const original = { token: Redacted.make("original-token"), fingerprint: "original" };
    const replacement = { token: Redacted.make("replacement-token"), fingerprint: "replacement" };
    let active = original;
    let resolutions = 0;
    const accounts: string[] = [];
    return Effect.gen(function* () {
      const service = yield* GitHubDiscussions.GitHubDiscussions;
      yield* service.comment({ cwd: "/repo", url, body: "First" });
      yield* service.comment({ cwd: "/repo", url, body: "Second" });
      assert.equal(resolutions, 2);
      assert.deepEqual(accounts, ["original", "original", "replacement", "replacement"]);
    }).pipe(
      Effect.provide(
        GitHubDiscussions.layer.pipe(
          Layer.provide(
            Layer.mock(GitHubApi.GitHubApi)({
              credential: () =>
                Effect.sync(() => {
                  resolutions++;
                  return active;
                }),
              graphql: (input) =>
                Effect.gen(function* () {
                  const pinned = yield* GitHubApi.PinnedGitHubCredential;
                  assert.isNotNull(pinned);
                  accounts.push(pinned!.credentialFingerprint);
                  assert.equal(
                    Redacted.value(pinned!.token),
                    `${pinned!.credentialFingerprint}-token`,
                  );
                  if (input.query.startsWith("mutation")) {
                    return encode({ data: { addDiscussionComment: { comment: comment("new") } } });
                  }
                  active = replacement;
                  return encode(target());
                }),
            }),
          ),
        ),
      ),
    );
  },
);

it.effect("disables comment, reaction and vote controls throughout an archived preview", () => {
  const response = discussion(page([{ ...comment("1"), replies: page([comment("2")]) }]));
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    const result = yield* service.read({ cwd: "/repo", url });
    assert.equal(result.canComment, false);
    for (const post of [result, result.comments[0]!, result.comments[0]!.replies[0]!]) {
      assert.equal(post.viewerCanReact, false);
      assert.equal(post.viewerCanUpvote, false);
    }
  }).pipe(
    Effect.provide(
      layer([
        {
          data: {
            ...response.data,
            repository: {
              discussion: {
                ...response.data.repository.discussion,
                repository: { isArchived: true, viewerPermission: "ADMIN" },
              },
            },
          },
        },
      ]),
    ),
  );
});

it.effect("maps credential failures to discussion errors before any request", () =>
  Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    const error = yield* service.summary({ cwd: "/repo", url }).pipe(Effect.flip);
    assert.equal(error._tag, "DiscussionOperationError");
    assert.include(error.message, "GitHub refused the credential");
  }).pipe(
    Effect.provide(
      GitHubDiscussions.layer.pipe(
        Layer.provide(
          Layer.mock(GitHubApi.GitHubApi)({
            credential: () =>
              Effect.fail(
                new GitHubApi.GitHubApiAuthenticationError({
                  host: "github.com",
                  operation: "credential",
                }),
              ),
          }),
        ),
      ),
    ),
  ),
);
