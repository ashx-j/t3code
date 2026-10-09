import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubDiscussions from "./GitHubDiscussions.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const url = "https://github.com/team/repo/discussions/1";

function layer(
  responses: ReadonlyArray<unknown>,
  queries: Array<Parameters<GitHubApi.GitHubApi["Service"]["graphql"]>[0]>,
) {
  let index = 0;
  return GitHubDiscussions.layer.pipe(
    Layer.provide(
      Layer.mock(GitHubApi.GitHubApi)({
        graphql: (input) =>
          Effect.sync(() => {
            queries.push(input);
            assert.isBelow(index, responses.length, "unexpected GitHub request");
            return encode(responses[index++]);
          }),
      }),
    ),
  );
}

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
