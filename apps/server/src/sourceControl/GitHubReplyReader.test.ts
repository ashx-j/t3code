import { assert, it } from "@effect/vitest";
import { CommandId, type GitHubReplySnooze } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";
import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubReplyReader from "./GitHubReplyReader.ts";

const watch: GitHubReplySnooze = {
  requestId: CommandId.make("watch"),
  url: "https://github.com/team/repo/pull/1",
  startedAt: "2026-10-01T12:00:00.000Z",
  nextCheckAt: "2026-10-01T12:00:00.000Z",
  status: "pending",
  failures: 0,
  baseline: { latestAt: "2026-10-01T11:00:00Z", ids: ["existing", "root-1", "root-2", "root"] },
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

function layer(
  responses: ReadonlyArray<unknown>,
  queries: string[] = [],
  fingerprint: Effect.Effect<string> = Effect.succeed("test-credential"),
) {
  let index = 0;
  return GitHubReplyReader.layer.pipe(
    Layer.provide(
      Layer.mock(GitHubApi.GitHubApi)({
        credential: () =>
          fingerprint.pipe(
            Effect.map((fingerprint) => ({ token: Redacted.make("test-token"), fingerprint })),
          ),
        graphql: (input) =>
          Effect.sync(() => {
            queries.push(input.query);
            assert.isBelow(index, responses.length, "unexpected GitHub request");
            return encode(responses[index++]);
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

it.effect.each(["2026-10-01T12:00:00.100Z", "2026-10-01T14:00:00.100Z"])(
  "tracks same-second reply IDs independently of local start time %s after restart",
  (startedAt) =>
    Effect.gen(function* () {
      const boundary = "2026-10-01T12:00:00Z";
      const setup = yield* Effect.gen(function* () {
        const reader = yield* GitHubReplyReader.GitHubReplyReader;
        return yield* reader.read({
          cwd: "/repo",
          watch: { ...watch, startedAt },
          captureBaseline: true,
        });
      }).pipe(
        Effect.provide(
          layer([
            pr([comment("existing-2", "someone", boundary)], "older"),
            pr([comment("existing-1", "someone", boundary), comment("ancient", "someone", old)]),
            emptyReviews,
            emptyThreads,
          ]),
        ),
      );
      assert.deepEqual(setup.baseline, { latestAt: boundary, ids: ["existing-2", "existing-1"] });
      assert.isNull(setup.reply);
      // Recreate the reader from only the persisted watch. A known ID in the newest page
      // must not stop pagination before another response in the same second.
      const restored = { ...watch, startedAt, viewer: setup.viewer, baseline: setup.baseline };
      const reply = yield* Effect.gen(function* () {
        const reader = yield* GitHubReplyReader.GitHubReplyReader;
        return yield* reader.read({ cwd: "/repo", watch: restored });
      }).pipe(
        Effect.provide(
          layer([
            pr(
              [comment("existing-2", "someone", boundary), comment("own", "me", boundary)],
              "older",
            ),
            pr([comment("existing-1", "someone", boundary), comment("new", "someone", boundary)]),
            body,
          ]),
        ),
      );
      assert.isNotNull(reply.reply);
    }),
);

it.effect("ignores existing boundary IDs and new own comments", () =>
  Effect.gen(function* () {
    const reader = yield* GitHubReplyReader.GitHubReplyReader;
    const result = yield* reader.read({
      cwd: "/repo",
      watch: {
        ...watch,
        baseline: { latestAt: recent, ids: ["existing"] },
      },
    });
    assert.isNull(result.reply);
  }).pipe(
    Effect.provide(
      layer([pr([comment("existing"), comment("own", "me")]), emptyReviews, emptyThreads]),
    ),
  ),
);

it.effect("captures fresh setup data even when a polling result is cached", () =>
  Effect.gen(function* () {
    const reader = yield* GitHubReplyReader.GitHubReplyReader;
    yield* reader.read({ cwd: "/repo", watch });
    const setup = yield* reader.read({ cwd: "/repo", watch, captureBaseline: true });
    assert.deepEqual(setup.baseline, { latestAt: recent, ids: ["arrived-before-setup"] });
  }).pipe(
    Effect.provide(
      layer([
        pr([]),
        emptyReviews,
        emptyThreads,
        pr([comment("arrived-before-setup")]),
        emptyReviews,
        emptyThreads,
      ]),
    ),
  ),
);

it.effect("uses review submission time and leaves pending drafts outside the baseline", () =>
  Effect.gen(function* () {
    const setup = yield* Effect.gen(function* () {
      const reader = yield* GitHubReplyReader.GitHubReplyReader;
      return yield* reader.read({ cwd: "/repo", watch, captureBaseline: true });
    }).pipe(
      Effect.provide(
        layer([
          pr([]),
          response({
            repository: {
              pullRequest: {
                reviews: page([
                  {
                    ...comment("submitted", "someone", old),
                    submittedAt: recent,
                    state: "COMMENTED",
                  },
                  { ...comment("draft", "someone", old), submittedAt: null, state: "PENDING" },
                ]),
              },
            },
          }),
          emptyThreads,
        ]),
      ),
    );
    assert.deepEqual(setup.baseline, { latestAt: recent, ids: ["submitted"] });
    const result = yield* Effect.gen(function* () {
      const reader = yield* GitHubReplyReader.GitHubReplyReader;
      return yield* reader.read({ cwd: "/repo", watch: { ...watch, baseline: setup.baseline } });
    }).pipe(
      Effect.provide(
        layer([
          pr([]),
          response({
            repository: {
              pullRequest: {
                reviews: page(
                  [
                    {
                      ...comment("submitted", "someone", old),
                      submittedAt: recent,
                      state: "COMMENTED",
                    },
                  ],
                  "older-draft",
                ),
              },
            },
          }),
          response({
            repository: {
              pullRequest: {
                reviews: page([
                  {
                    ...comment("draft", "someone", old),
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
    );
    assert.isNotNull(result.reply);
  }),
);

it.effect("fails visibly for a persisted watch without an observation baseline", () =>
  Effect.gen(function* () {
    const reader = yield* GitHubReplyReader.GitHubReplyReader;
    const { baseline: _baseline, ...legacyWatch } = watch;
    const error = yield* reader.read({ cwd: "/repo", watch: legacyWatch }).pipe(Effect.flip);
    assert.equal(error.reason, "baseline-missing");
  }).pipe(Effect.provide(layer([]))),
);

it.effect("keeps the selected discussion parent and boundary reply IDs through setup", () =>
  Effect.gen(function* () {
    const reader = yield* GitHubReplyReader.GitHubReplyReader;
    const setup = yield* reader.read({
      cwd: "/repo",
      captureBaseline: true,
      watch: {
        ...watch,
        url: "https://github.com/team/repo/discussions/1#discussioncomment-5",
      },
    });
    assert.equal(setup.discussionCommentId, "root");
    assert.deepEqual(setup.baseline, { latestAt: recent, ids: ["reply-2", "reply-1"] });
    assert.isNull(setup.reply);
  }).pipe(
    Effect.provide(
      layer([
        response({
          repository: {
            discussion: {
              comments: page([
                { ...comment("root", "me", old, 5), replies: page([comment("reply-2")]) },
              ]),
            },
          },
        }),
        response({ node: { replies: page([comment("reply-2")], "older") } }),
        response({ node: { replies: page([comment("old", "someone", old), comment("reply-1")]) } }),
      ]),
    ),
  ),
);

const changesWatch: GitHubReplySnooze = { ...watch, wakeCondition: "changes-requested" };
const review = (
  id: string,
  state = "CHANGES_REQUESTED",
  author = "someone",
  submittedAt: string | null = recent,
  createdAt = old,
) => ({
  ...comment(id, author, createdAt),
  state,
  submittedAt,
});
const reviews = (nodes: ReadonlyArray<ReturnType<typeof review>>, cursor: string | null = null) =>
  response({ repository: { pullRequest: { reviews: page(nodes, cursor) } } });
const emptyReviewBody = response({
  node: {
    url: "https://github.com/team/repo/pull/1#pullrequestreview-2",
    bodyText: "",
    author: { login: "someone" },
  },
});

it.effect(
  "changes-requested snooze reads only reviews and ignores approvals, comments, own and pending reviews",
  () => {
    const queries: string[] = [];
    return Effect.gen(function* () {
      const reader = yield* GitHubReplyReader.GitHubReplyReader;
      const result = yield* reader.read({ cwd: "/repo", watch: changesWatch });
      assert.isNull(result.reply);
      assert.equal(queries.length, 1);
      assert.include(queries[0]!, "reviews(last:");
      assert.notInclude(queries[0]!, "comments(");
      assert.notInclude(queries[0]!, "reviewThreads(");
    }).pipe(
      Effect.provide(
        layer(
          [
            reviews([
              review("existing", "CHANGES_REQUESTED", "someone", old),
              review("approval", "APPROVED"),
              review("comment", "COMMENTED"),
              review("self", "CHANGES_REQUESTED", "me"),
              review("pending", "PENDING", "someone", null),
              review("unsubmitted", "CHANGES_REQUESTED", "someone", null),
            ]),
          ],
          queries,
        ),
      ),
    );
  },
);

it.effect(
  "changes-requested snooze wakes for an empty review submitted from an older draft beyond the first page",
  () =>
    Effect.gen(function* () {
      const reader = yield* GitHubReplyReader.GitHubReplyReader;
      const result = yield* reader.read({ cwd: "/repo", watch: changesWatch });
      assert.deepEqual(result.reply, {
        url: "https://github.com/team/repo/pull/1#pullrequestreview-2",
        text: "",
        author: "someone",
      });
    }).pipe(
      Effect.provide(
        layer([
          reviews(
            [
              review("approval", "APPROVED"),
              review("existing", "CHANGES_REQUESTED", "someone", old),
            ],
            "older",
          ),
          reviews([review("draft-submitted-later")]),
          emptyReviewBody,
        ]),
      ),
    ),
);

it.effect(
  "captures all existing requested-changes reviews and preserves same-second novelty across restart",
  () =>
    Effect.gen(function* () {
      const setup = yield* Effect.gen(function* () {
        const reader = yield* GitHubReplyReader.GitHubReplyReader;
        return yield* reader.read({ cwd: "/repo", watch: changesWatch, captureBaseline: true });
      }).pipe(
        Effect.provide(
          layer([
            reviews([review("existing-2"), review("draft", "PENDING", "someone", null)], "older"),
            reviews([review("existing-1"), review("ancient", "CHANGES_REQUESTED", "someone", old)]),
          ]),
        ),
      );
      assert.isNull(setup.reply);
      assert.deepEqual(setup.baseline, { latestAt: recent, ids: ["existing-2", "existing-1"] });
      const restored = { ...changesWatch, viewer: setup.viewer, baseline: setup.baseline };
      const unchanged = yield* Effect.gen(function* () {
        const reader = yield* GitHubReplyReader.GitHubReplyReader;
        return yield* reader.read({ cwd: "/repo", watch: restored });
      }).pipe(Effect.provide(layer([reviews([review("existing-1"), review("existing-2")])])));
      assert.isNull(unchanged.reply);
      const result = yield* Effect.gen(function* () {
        const reader = yield* GitHubReplyReader.GitHubReplyReader;
        return yield* reader.read({ cwd: "/repo", watch: restored });
      }).pipe(
        Effect.provide(
          layer([
            reviews([review("existing-2")], "older"),
            reviews([review("existing-1"), review("draft")]),
            emptyReviewBody,
          ]),
        ),
      );
      assert.isNotNull(result.reply);
    }),
);

it.effect("rejects a discussion for changes-requested snooze without reading GitHub", () =>
  Effect.gen(function* () {
    const reader = yield* GitHubReplyReader.GitHubReplyReader;
    const error = yield* reader
      .read({
        cwd: "/repo",
        watch: { ...changesWatch, url: "https://github.com/team/repo/discussions/1" },
        captureBaseline: true,
      })
      .pipe(Effect.flip);
    assert.equal(error.reason, "unavailable");
  }).pipe(Effect.provide(layer([]))),
);

it.effect("does not reuse another credential's cached viewer", () =>
  Effect.gen(function* () {
    const fingerprint = yield* Ref.make("first-account");
    const queries: string[] = [];
    const reader = yield* GitHubReplyReader.GitHubReplyReader.pipe(
      Effect.provide(
        layer(
          [
            pr([]),
            emptyReviews,
            emptyThreads,
            { data: { ...pr([]).data, viewer: { login: "other-account" } } },
          ],
          queries,
          Ref.get(fingerprint),
        ),
      ),
    );
    const saved = { ...watch, viewer: "me" };
    assert.isNull((yield* reader.read({ cwd: "/repo", watch: saved })).reply);
    yield* Ref.set(fingerprint, "second-account");
    const error = yield* reader.read({ cwd: "/repo", watch: saved }).pipe(Effect.flip);
    assert.equal(error.reason, "account-changed");
    assert.lengthOf(queries, 4);
  }),
);

it.effect.each([
  new GitHubApi.GitHubApiRateLimitError({
    host: "github.com",
    operation: "readGitHubReplies",
    retryAt: 1_800_000_000_000,
  }),
  new SourceControlRateLimit.SourceControlRateLimitPausedError({
    provider: "github",
    host: "github.com",
    retryAt: 1_800_000_000_000,
  }),
])("preserves GitHub quota pauses: %s", (cause) =>
  Effect.gen(function* () {
    const reader = yield* GitHubReplyReader.GitHubReplyReader;
    const error = yield* reader.read({ cwd: "/repo", watch }).pipe(Effect.flip);
    assert.equal(error.reason, "rate-limited");
    assert.equal(error.retryAt, cause.retryAt);
  }).pipe(
    Effect.provide(
      GitHubReplyReader.layer.pipe(
        Layer.provide(
          Layer.mock(GitHubApi.GitHubApi)({
            credential: () =>
              Effect.succeed({
                token: Redacted.make("test-token"),
                fingerprint: "test-credential",
              }),
            graphql: () => Effect.fail(cause),
          }),
        ),
      ),
    ),
  ),
);
