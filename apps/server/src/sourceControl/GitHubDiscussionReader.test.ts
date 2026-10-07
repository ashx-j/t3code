import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as GitHubCli from "./GitHubCli.ts";
import * as GitHubDiscussionReader from "./GitHubDiscussionReader.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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
});
const page = <T>(nodes: ReadonlyArray<T>, cursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
});
const discussion = (comments: ReturnType<typeof page>) => ({
  data: {
    repository: {
      discussion: {
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
        comments,
      },
    },
  },
});

function layer(
  responses: ReadonlyArray<unknown>,
  queries: Array<Parameters<GitHubCli.GitHubCli["Service"]["query"]>[0]> = [],
) {
  let index = 0;
  return GitHubDiscussionReader.layer.pipe(
    Layer.provide(
      Layer.mock(GitHubCli.GitHubCli)({
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
      const reader = yield* GitHubDiscussionReader.GitHubDiscussionReader;
      const result = yield* reader.read({ cwd: "/worktree", url });
      assert.equal(result.body, "**Body**");
      assert.equal(result.isAnswered, false);
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

it.effect("links with a title-only read without fetching discussion comments", () => {
  const queries: Array<Parameters<GitHubCli.GitHubCli["Service"]["query"]>[0]> = [];
  return Effect.gen(function* () {
    const reader = yield* GitHubDiscussionReader.GitHubDiscussionReader;
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
    const reader = yield* GitHubDiscussionReader.GitHubDiscussionReader;
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
    const reader = yield* GitHubDiscussionReader.GitHubDiscussionReader;
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
