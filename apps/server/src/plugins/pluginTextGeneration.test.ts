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
    const textGeneration = makeTextGenerationApi(
      makeFacadeContext({
        pluginId: PluginId.make("writer"),
        activation: makePluginActivation(yield* PubSub.sliding<PluginPublication>(1)),
        context: yield* Effect.context<never>(),
      }),
      { hooks },
    );
    const generation = withPluginTextGeneration(hooks, own);
    const asked = Promise.withResolvers<void>();
    textGeneration.register("branchName", () => {
      asked.resolve();
      return new Promise(() => undefined);
    });
    textGeneration.register("branchName", () => ({ branch: "" }));
    textGeneration.register("branchName", ({ message }) => ({ branch: `Fix ${message}` }));

    const naming = yield* generation
      .generateBranchName({ cwd: "/repo", message: "the login bug", modelSelection })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.promise(() => asked.promise);
    yield* TestClock.adjust("30 seconds");
    const { branch } = yield* Fiber.join(naming);
    assert.strictEqual(branch, "fix-the-login-bug");

    // No plugin generates titles, so T3 does.
    assert.deepStrictEqual(
      yield* generation.generateThreadTitle({ cwd: "/repo", message: "Hi", modelSelection }),
      { title: "T3 title" },
    );
  }).pipe(Effect.provide(PluginHooks.layer)),
);
