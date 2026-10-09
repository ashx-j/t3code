import {
  DiscussionOperationError,
  TrimmedNonEmptyString,
  parseGitHubConversationUrl,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as GitHubCli from "./GitHubCli.ts";

const SummaryResponse = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        discussion: Schema.NullOr(Schema.Struct({ title: TrimmedNonEmptyString })),
      }),
    ),
  }),
});
const decodeSummary = Schema.decodeUnknownEffect(Schema.fromJsonString(SummaryResponse));

export class GitHubDiscussions extends Context.Service<
  GitHubDiscussions,
  {
    readonly summary: (input: {
      readonly cwd: string;
      readonly url: string;
    }) => Effect.Effect<{ readonly title: string }, DiscussionOperationError>;
  }
>()("t3/sourceControl/GitHubDiscussions") {}

const make = Effect.gen(function* () {
  const cli = yield* GitHubCli.GitHubCli;
  const summary = Effect.fn("GitHubDiscussions.summary")(function* ({
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
  return GitHubDiscussions.of({ summary });
});

export const layer = Layer.effect(GitHubDiscussions, make);
