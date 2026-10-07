import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as GitHubCli from "./GitHubCli.ts";
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
const page = <T>(nodes: ReadonlyArray<T>, cursor: string | null = null) => ({
  nodes,
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
  queries: Array<Parameters<GitHubCli.GitHubCli["Service"]["query"]>[0]> = [],
  mutations: Array<Parameters<GitHubCli.GitHubCli["Service"]["execute"]>[0]> = [],
  mutationFailure?: GitHubCli.GitHubCliError,
) {
  let index = 0;
  return GitHubDiscussions.layer.pipe(
    Layer.provide(
      Layer.mock(GitHubCli.GitHubCli)({
        execute: (input) =>
          Effect.gen(function* () {
            mutations.push(input);
            if (mutationFailure) return yield* mutationFailure;
            assert.isBelow(index, responses.length, "unexpected GitHub mutation");
            return {
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: encode(responses[index++]),
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
        query: (input) =>
          Effect.sync(() => {
            queries.push(input);
            assert.isBelow(index, responses.length, "unexpected GitHub request");
            return {
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: encode(responses[index++]),
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      }),
    ),
  );
}

it.effect(
  "reads markdown, deleted authors and every comment and reply page in the selected workspace",
  () => {
    const queries: Array<Parameters<GitHubCli.GitHubCli["Service"]["query"]>[0]> = [];
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
      assert.deepEqual(
        result.comments.map((entry) => entry.id),
        ["1", "2"],
      );
      assert.deepEqual(
        result.comments[0]?.replies.map((entry) => entry.id),
        ["3", "4"],
      );
      assert.isNull(result.comments[1]?.author);
      assert.equal(result.comments[0]?.replies[1]?.body, "**Comment 4**");
      assert.isTrue(
        queries.every((query) => query.cwd === "/worktree" && query.host === "github.com"),
      );
      assert.deepEqual(
        queries.map((query) => query.variables.after),
        [null, "replies-next", "comments-next"],
      );
      assert.include(queries[0]!.document, "labels(first: 100) { nodes { name color } }");
      assert.notInclude(queries[2]!.document, "labels(");
    }).pipe(
      Effect.provide(
        layer(
          [
            discussion(
              page(
                [{ ...comment("1"), replies: page([comment("3")], "replies-next") }],
                "comments-next",
              ),
            ),
            { data: { node: { replies: page([comment("4")]) } } },
            discussion(page([{ ...comment("2"), author: null, replies: page([]) }])),
          ],
          queries,
        ),
      ),
    );
  },
);

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
  const mutations: Array<Parameters<GitHubCli.GitHubCli["Service"]["execute"]>[0]> = [];
  const body = "Reply with **Markdown** and $literal\\ncharacters";
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    const result = yield* service.comment({ cwd: "/worktree", url, body, ...scenario.input });
    assert.equal(result.comment.id, "new-id");
    assert.equal(result.replyToId, scenario.replyToId);
    assert.equal(mutations.length, 1);
    assert.deepEqual(mutations[0]!.args, [
      "api",
      "graphql",
      "--hostname",
      "github.com",
      "--input",
      "-",
    ]);
    assert.equal(mutations[0]!.cwd, "/worktree");
    const request = decodeCommentRequest(mutations[0]!.stdin);
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
  const mutations: Array<Parameters<GitHubCli.GitHubCli["Service"]["execute"]>[0]> = [];
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
  const mutations: Array<Parameters<GitHubCli.GitHubCli["Service"]["execute"]>[0]> = [];
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
    const request = decodeReactionRequest(mutations[0]!.stdin);
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
  const mutations: Array<Parameters<GitHubCli.GitHubCli["Service"]["execute"]>[0]> = [];
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
    const mutations: Array<Parameters<GitHubCli.GitHubCli["Service"]["execute"]>[0]> = [];
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
      assert.equal(mutations[0]!.cwd, "/worktree");
      const request = decodeUpvoteRequest(mutations[0]!.stdin);
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
    name: "locked discussion",
    response: target({ id: "discussion-id" }, { locked: true }),
    subjectId: "discussion-id",
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
  const mutations: Array<Parameters<GitHubCli.GitHubCli["Service"]["execute"]>[0]> = [];
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
  const mutations: Array<Parameters<GitHubCli.GitHubCli["Service"]["execute"]>[0]> = [];
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
  const mutations: Array<Parameters<GitHubCli.GitHubCli["Service"]["execute"]>[0]> = [];
  const failure = new GitHubCli.GitHubCliCommandError({
    command: "gh",
    cwd: "/worktree",
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
  const queries: Array<Parameters<GitHubCli.GitHubCli["Service"]["query"]>[0]> = [];
  return Effect.gen(function* () {
    const reader = yield* GitHubDiscussions.GitHubDiscussions;
    assert.deepEqual(yield* reader.summary({ cwd: "/repo", url }), { title: "A title" });
    assert.equal(queries.length, 1);
    assert.notInclude(queries[0]!.document, "comments");
  }).pipe(
    Effect.provide(
      layer([{ data: { repository: { discussion: { title: "A title" } } } }], queries),
    ),
  );
});

it.effect("fails rather than silently truncating a broken page", () =>
  Effect.gen(function* () {
    const reader = yield* GitHubDiscussions.GitHubDiscussions;
    const result = yield* reader.read({ cwd: "/repo", url }).pipe(Effect.flip);
    assert.include(result.message, "next page");
  }).pipe(
    Effect.provide(
      layer([discussion({ nodes: [], pageInfo: { hasNextPage: true, endCursor: null } })]),
    ),
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
  const mutations: Array<Parameters<GitHubCli.GitHubCli["Service"]["execute"]>[0]> = [];
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    const result = yield* service.setLabel({ cwd: "/worktree", url, labelId: label.id, applied });
    assert.deepEqual(result, { label: { name: label.name, color: label.color }, applied });
    assert.lengthOf(mutations, 1);
    const request = decodeMetadataRequest(mutations[0]!.stdin);
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
  const mutations: Array<Parameters<GitHubCli.GitHubCli["Service"]["execute"]>[0]> = [];
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    yield* service
      .setLabel({ cwd: "/worktree", url, labelId: label.id, applied: true })
      .pipe(Effect.flip);
    assert.lengthOf(mutations, 0);
  }).pipe(Effect.provide(layer([response], [], mutations)));
});

it.effect("moves categories with triage permission and returns the updated answer state", () => {
  const mutations: Array<Parameters<GitHubCli.GitHubCli["Service"]["execute"]>[0]> = [];
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    assert.deepEqual(
      yield* service.setCategory({ cwd: "/worktree", url, categoryId: newCategory.id }),
      { category: newCategory, isAnswered: false },
    );
    assert.lengthOf(mutations, 1);
    const request = decodeMetadataRequest(mutations[0]!.stdin);
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
  const mutations: Array<Parameters<GitHubCli.GitHubCli["Service"]["execute"]>[0]> = [];
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    yield* service
      .setCategory({ cwd: "/worktree", url, categoryId: newCategory.id })
      .pipe(Effect.flip);
    assert.lengthOf(mutations, 0);
  }).pipe(Effect.provide(layer([response], [], mutations)));
});

it.effect("does not repeat a category change that already applied", () => {
  const mutations: Array<Parameters<GitHubCli.GitHubCli["Service"]["execute"]>[0]> = [];
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
  const mutations: Array<Parameters<GitHubCli.GitHubCli["Service"]["execute"]>[0]> = [];
  const failure = new GitHubCli.GitHubCliCommandError({
    command: "gh",
    cwd: "/worktree",
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
  const queries: Array<Parameters<GitHubCli.GitHubCli["Service"]["query"]>[0]> = [];
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    const result = yield* service.metadataOptions({ cwd: "/worktree", url, kind: "categories" });
    assert.deepEqual(result, { labels: [], categories: [category, newCategory], truncated: false });
    assert.notInclude(queries[0]!.document, "labels(");
    assert.notInclude(queries[0]!.document, "comments(");
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
  const queries: Array<Parameters<GitHubCli.GitHubCli["Service"]["query"]>[0]> = [];
  return Effect.gen(function* () {
    const service = yield* GitHubDiscussions.GitHubDiscussions;
    const result = yield* service.metadataOptions({ cwd: "/worktree", url, kind: "labels" });
    assert.isTrue(result.truncated);
    assert.lengthOf(result.labels, 5);
    assert.lengthOf(queries, 5);
    assert.deepEqual(
      queries.map((query) => query.variables.after),
      [null, "1", "2", "3", "4"],
    );
    assert.notInclude(queries[0]!.document, "discussionCategories(");
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
