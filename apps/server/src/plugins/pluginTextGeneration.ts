import { PullRequestReviewGuideStop } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "@t3tools/provider-core/server/textGenerationUtils";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PluginHooksRegistry, PluginTextGenerationKind } from "./PluginHooks.ts";

const NonEmpty = Schema.String.check(Schema.isNonEmpty());
const decodeTitle = Schema.decodeUnknownOption(Schema.Struct({ title: NonEmpty }));
const decodeCommit = Schema.decodeUnknownOption(
  Schema.Struct({ subject: NonEmpty, body: Schema.String, branch: Schema.optional(NonEmpty) }),
);
const decodePr = Schema.decodeUnknownOption(
  Schema.Struct({ title: NonEmpty, body: Schema.String }),
);
const decodeBranch = Schema.decodeUnknownOption(Schema.Struct({ branch: NonEmpty }));
const decodeGuide = Schema.decodeUnknownOption(
  Schema.toCodecJson(Schema.Struct({ stops: Schema.Array(PullRequestReviewGuideStop) })),
);

const omitUndefined = (input: Record<string, Schema.Json | undefined>): Schema.JsonObject => {
  const request: Record<string, Schema.Json> = {};
  for (const [key, value] of Object.entries(input)) if (value !== undefined) request[key] = value;
  return request;
};

/**
 * Asks plugins for each generated text before T3's own generator, in the order they registered.
 * Their answers get the cleanup T3 gives model output; with no usable answer T3 generates as usual.
 */
export const withPluginTextGeneration = (
  hooks: PluginHooksRegistry,
  base: ProviderTextGeneration,
): ProviderTextGeneration => {
  const fromPlugins = <A, E>(
    kind: PluginTextGenerationKind,
    input: Record<string, Schema.Json | undefined>,
    decode: (answer: unknown) => Option.Option<A>,
    fallback: Effect.Effect<A, E>,
  ) =>
    hooks.textGenerators(kind).pipe(
      Effect.flatMap((generators) =>
        generators.length === 0
          ? fallback
          : Effect.gen(function* () {
              const request = omitUndefined(input);
              for (const generate of generators) {
                const answer = decode(yield* generate(request));
                if (Option.isSome(answer)) return answer.value;
              }
              return yield* fallback;
            }),
      ),
    );
  return {
    generateThreadTitle: (input) =>
      fromPlugins(
        "threadTitle",
        {
          cwd: input.cwd,
          message: input.message,
          previousTitle: input.previousTitle,
          instructions: input.instructions,
        },
        (answer) =>
          decodeTitle(answer).pipe(
            Option.map(({ title }) => ({ title: sanitizeThreadTitle(title) })),
          ),
        base.generateThreadTitle(input),
      ),
    generateCommitMessage: (input) =>
      fromPlugins(
        "commitMessage",
        {
          cwd: input.cwd,
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
          instructions: input.policy?.commitInstructions,
          branchInstructions:
            input.includeBranch === true ? input.policy?.branchInstructions : undefined,
        },
        (answer) =>
          decodeCommit(answer).pipe(
            Option.map((commit) => ({
              subject: sanitizeCommitSubject(commit.subject),
              body: commit.body.trim(),
              ...(input.includeBranch === true && commit.branch !== undefined
                ? { branch: sanitizeFeatureBranchName(commit.branch) }
                : {}),
            })),
          ),
        base.generateCommitMessage(input),
      ),
    generatePrContent: (input) =>
      fromPlugins(
        "prContent",
        {
          cwd: input.cwd,
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          commitSummary: input.commitSummary,
          diffSummary: input.diffSummary,
          diffPatch: input.diffPatch,
          template: input.changeRequestTemplate,
          threadContext: input.threadContext,
          instructions: input.policy?.changeRequestInstructions,
        },
        (answer) =>
          decodePr(answer).pipe(
            Option.map((pr) => ({ title: sanitizePrTitle(pr.title), body: pr.body.trim() })),
          ),
        base.generatePrContent(input),
      ),
    generateBranchName: (input) =>
      fromPlugins(
        "branchName",
        {
          cwd: input.cwd,
          message: input.message,
          naming:
            input.naming === undefined
              ? undefined
              : {
                  mode: input.naming.mode,
                  prefix: input.naming.prefix,
                  instructions: input.naming.instructions,
                },
        },
        (answer) =>
          decodeBranch(answer).pipe(
            Option.map(({ branch }) => ({
              branch: formatGeneratedBranchName(branch, input.naming),
            })),
          ),
        base.generateBranchName(input),
      ),
    generateReviewGuide: (input) =>
      fromPlugins(
        "reviewGuide",
        {
          cwd: input.cwd,
          number: input.number,
          title: input.title,
          description: input.description,
          baseBranch: input.baseBranch,
          baseCommit: input.baseCommit,
          instructions: input.instructions,
        },
        decodeGuide,
        base.generateReviewGuide(input),
      ),
  };
};
