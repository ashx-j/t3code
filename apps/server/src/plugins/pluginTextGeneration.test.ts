import { assert, it } from "@effect/vitest";
import { PluginId, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";

import { makeFacadeContext } from "./api/facade.ts";
import { makeTextGenerationApi } from "./api/textGeneration.ts";
import { makePluginActivation, type PluginPublication } from "./PluginApi.ts";
import * as PluginHooks from "./PluginHooks.ts";
import { withPluginTextGeneration } from "./pluginTextGeneration.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };
const unavailable = (operation: string) =>
  Effect.fail(new TextGenerationError({ operation, detail: "T3's generator was asked." }));
const own = {
  generateThreadTitle: () => Effect.succeed({ title: "T3 title" }),
  generateCommitMessage: () => unavailable("generateCommitMessage"),
  generatePrContent: () => unavailable("generatePrContent"),
  generateBranchName: () => unavailable("generateBranchName"),
  generateReviewGuide: () => unavailable("generateReviewGuide"),
} satisfies ProviderTextGeneration;

it.effect("asks plugins before T3, skipping slow or unusable answers, and cleans up theirs", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.PluginHooks;
    const textGenerationOf = Effect.fn(function* (pluginId: string) {
      return makeTextGenerationApi(
        makeFacadeContext({
          pluginId: PluginId.make(pluginId),
          activation: makePluginActivation(yield* PubSub.sliding<PluginPublication>(1)),
          context: yield* Effect.context<never>(),
        }),
        { hooks },
      );
    });
    const textGeneration = yield* textGenerationOf("writer");
    const generation = withPluginTextGeneration(hooks, own);
    const asked = Promise.withResolvers<void>();
    textGeneration.register("branchName", () => {
      asked.resolve();
      return new Promise(() => undefined);
    });
    textGeneration.register("branchName", () => ({ branch: "" }));
    // Plugins get the user's branch naming, and their answer is formatted with it like T3's.
    textGeneration.register("branchName", ({ message, naming }) => ({
      branch: `${naming?.instructions} ${message}`,
    }));

    const naming = yield* generation
      .generateBranchName({
        cwd: "/repo",
        message: "the login bug",
        naming: { mode: "static", prefix: "ash", instructions: "Fix" },
        modelSelection,
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.promise(() => asked.promise);
    yield* TestClock.adjust("30 seconds");
    const { branch } = yield* Fiber.join(naming);
    assert.strictEqual(branch, "ash/fix-the-login-bug");

    // No plugin generates titles, so T3 does.
    assert.deepStrictEqual(
      yield* generation.generateThreadTitle({ cwd: "/repo", message: "Hi", modelSelection }),
      { title: "T3 title" },
    );

    // The plugin whose id sorts first is asked first, whichever registered first.
    textGeneration.register("threadTitle", () => ({ title: "Writer title" }));
    (yield* textGenerationOf("a-titler")).register("threadTitle", () => ({
      title: "Titler title",
    }));
    assert.deepStrictEqual(
      yield* generation.generateThreadTitle({ cwd: "/repo", message: "Hi", modelSelection }),
      { title: "Titler title" },
    );

    // Plugins get the commit style the user picked, as T3's own generator does.
    textGeneration.register("commitMessage", ({ instructions, branchInstructions }) => ({
      subject: `${instructions} ${branchInstructions}`,
      body: "",
    }));
    const commit = yield* generation.generateCommitMessage({
      cwd: "/repo",
      branch: null,
      stagedSummary: "M a.ts",
      stagedPatch: "",
      includeBranch: true,
      policy: {
        kind: "custom",
        commitInstructions: "Start with a verb.",
        branchInstructions: "Prefix with fix.",
        inferRepositoryConventions: false,
      },
      modelSelection,
    });
    assert.strictEqual(commit.subject, "Start with a verb. Prefix with fix");
  }).pipe(Effect.provide(PluginHooks.layer)),
);
