import { assert, it } from "@effect/vitest";
import { CommandId, type GitHubReplySnooze } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as GitHubCli from "./GitHubCli.ts";
import * as GitHubReplyReader from "./GitHubReplyReader.ts";

const watch: GitHubReplySnooze = {
  requestId: CommandId.make("watch"),
  url: "https://github.com/team/repo/pull/1",
  startedAt: "2026-10-01T12:00:00.000Z",
  nextCheckAt: "2026-10-01T12:00:00.000Z",
  status: "pending",
  failures: 0,
};
const old = "2026-10-01T11:00:00Z";
const recent = "2026-10-01T12:01:00Z";
const comment = (id: string, author = "someone", createdAt = recent, databaseId = 1) => ({
  id,
  author: { login: author },
  createdAt,
  databaseId,
});
const page = <T>(nodes: ReadonlyArray<T>, cursor: string | null = null) => ({
  nodes,
  pageInfo: { hasPreviousPage: cursor !== null, startCursor: cursor },
});
const response = (data: object) => ({ data: { viewer: { login: "me" }, ...data } });
const pr = (nodes: ReadonlyArray<ReturnType<typeof comment>>, cursor: string | null = null) =>
  response({ repository: { pullRequest: { comments: page(nodes, cursor) } } });
const emptyReviews = response({ repository: { pullRequest: { reviews: page([]) } } });
const emptyThreads = response({
  repository: {
    pullRequest: {
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    },
  },
});
const body = response({
  node: {
    url: "https://github.com/team/repo/pull/1#issuecomment-2",
    bodyText: "Please consider this.",
    author: { login: "someone" },
  },
});
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function layer(responses: ReadonlyArray<unknown>, queries: string[] = []) {
  let index = 0;
  return GitHubReplyReader.layer.pipe(
    Layer.provide(
      Layer.mock(GitHubCli.GitHubCli)({
        query: (input) =>
          Effect.sync(() => {
            queries.push(input.document);
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

it.effect("reads new feedback without filtering out merged or closed PRs", () =>
  Effect.gen(function* () {
    const reader = yield* GitHubReplyReader.GitHubReplyReader;
    const result = yield* reader.read({ cwd: "/repo", watch });
    assert.equal(result.reply?.text, "Please consider this.");
    assert.equal(result.viewer, "me");
  }).pipe(Effect.provide(layer([pr([comment("existing", "someone", old), comment("new")]), body]))),
);

it.effect("ignores existing comments, own comments and CI-only updates", () =>
  Effect.gen(function* () {
    const reader = yield* GitHubReplyReader.GitHubReplyReader;
    assert.isNull((yield* reader.read({ cwd: "/repo", watch })).reply);
  }).pipe(
    Effect.provide(
      layer([
        pr([comment("existing", "someone", old), comment("own", "me")]),
        emptyReviews,
        emptyThreads,
      ]),
    ),
  ),
);

it.effect("pages past newer self comments to another person's response", () =>
  Effect.gen(function* () {
    const reader = yield* GitHubReplyReader.GitHubReplyReader;
    assert.isNotNull((yield* reader.read({ cwd: "/repo", watch })).reply);
  }).pipe(Effect.provide(layer([pr([comment("own", "me")], "older"), pr([comment("new")]), body]))),
);

it.effect("finds replies on an old discussion comment beyond the first page", () =>
  Effect.gen(function* () {
    const reader = yield* GitHubReplyReader.GitHubReplyReader;
    assert.isNotNull(
      (yield* reader.read({
        cwd: "/repo",
        watch: { ...watch, url: "https://github.com/team/repo/discussions/1" },
      })).reply,
    );
  }).pipe(
    Effect.provide(
      layer([
        response({
          repository: {
            discussion: {
              comments: page([{ ...comment("root-1", "me", old), replies: page([]) }], "older"),
            },
          },
        }),
        response({
          repository: {
            discussion: {
              comments: page([
                { ...comment("root-2", "me", old), replies: page([comment("own", "me")], "more") },
              ]),
            },
          },
        }),
        response({ node: { replies: page([comment("own", "me")], "older-replies") } }),
        response({ node: { replies: page([comment("reply")]) } }),
        body,
      ]),
    ),
  ),
);

it.effect("honors a discussion comment anchor and persists the resolved parent", () =>
  Effect.gen(function* () {
    const reader = yield* GitHubReplyReader.GitHubReplyReader;
    const result = yield* reader.read({
      cwd: "/repo",
      watch: { ...watch, url: "https://github.com/team/repo/discussions/1#discussioncomment-5" },
    });
    assert.equal(result.discussionCommentId, "root");
    assert.isNull(result.reply);
  }).pipe(
    Effect.provide(
      layer([
        response({
          repository: {
            discussion: {
              comments: page([{ ...comment("root", "me", old, 5), replies: page([]) }]),
            },
          },
        }),
        response({ node: { replies: page([]) } }),
      ]),
    ),
  ),
);

it.effect("detects a review submitted after snoozing even if its draft is older", () =>
  Effect.gen(function* () {
    const reader = yield* GitHubReplyReader.GitHubReplyReader;
    assert.isNotNull((yield* reader.read({ cwd: "/repo", watch })).reply);
  }).pipe(
    Effect.provide(
      layer([
        pr([]),
        response({
          repository: {
            pullRequest: {
              reviews: page([
                {
                  ...comment("review", "someone", old),
                  submittedAt: recent,
                  state: "CHANGES_REQUESTED",
                },
              ]),
            },
          },
        }),
        body,
      ]),
    ),
  ),
);

it.effect("detects inline review replies and pages past own replies", () =>
  Effect.gen(function* () {
    const reader = yield* GitHubReplyReader.GitHubReplyReader;
    assert.isNotNull((yield* reader.read({ cwd: "/repo", watch })).reply);
  }).pipe(
    Effect.provide(
      layer([
        pr([]),
        emptyReviews,
        response({
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{ id: "review-thread", comments: page([comment("own", "me")]) }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
        response({ node: { comments: page([comment("other"), comment("own", "me")]) } }),
        body,
      ]),
    ),
  ),
);

it.effect("reports missing conversations instead of treating them as successfully watched", () =>
  Effect.gen(function* () {
    const reader = yield* GitHubReplyReader.GitHubReplyReader;
    const result = yield* reader.read({ cwd: "/repo", watch }).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
  }).pipe(Effect.provide(layer([response({ repository: { pullRequest: null } })]))),
);

it.effect("shares cached reads for threads watching the same conversation", () =>
  Effect.gen(function* () {
    const reader = yield* GitHubReplyReader.GitHubReplyReader;
    yield* reader.read({ cwd: "/repo", watch });
    yield* reader.read({ cwd: "/repo", watch: { ...watch, requestId: CommandId.make("other") } });
  }).pipe(Effect.provide(layer([pr([]), emptyReviews, emptyThreads]))),
);
