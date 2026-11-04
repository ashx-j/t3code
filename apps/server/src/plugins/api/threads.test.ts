import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PluginId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";

import type * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import type * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import type * as ProjectService from "../../project/ProjectService.ts";
import type * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import type * as ServerSettings from "../../serverSettings.ts";
import { makePluginActivation, type PluginPublication } from "../PluginApi.ts";
import { makeFacadeContext } from "./facade.ts";
import { makeThreadsApi } from "./threads.ts";

const codeOf = (promise: Promise<unknown>) =>
  Effect.promise(() =>
    promise.then(
      () => "resolved",
      (error: { readonly code: string }) => error.code,
    ),
  );

it.layer(NodeServices.layer)("plugin threads", (it) => {
  it.effect("treats a deleted thread as gone and refuses a blank title", () =>
    Effect.gen(function* () {
      const deletedId = ThreadId.make("thread:deleted");
      const launched: Array<unknown> = [];
      const threads = makeThreadsApi(
        makeFacadeContext({
          pluginId: PluginId.make("threads"),
          activation: makePluginActivation(yield* PubSub.sliding<PluginPublication>(1)),
          context: yield* Effect.context<never>(),
        }),
        {
          threads: {
            getThreadShell: () =>
              Effect.succeed({ id: deletedId, deletedAt: DateTime.makeUnsafe(0) } as never),
          } as Partial<
            ThreadManagementService.ThreadManagementService["Service"]
          > as ThreadManagementService.ThreadManagementService["Service"],
          launches: {
            launch: (input) => Effect.sync(() => launched.push(input) as never),
          } as Partial<
            ThreadLaunchService.ThreadLaunchService["Service"]
          > as ThreadLaunchService.ThreadLaunchService["Service"],
          projectService: {} as ProjectService.ProjectService["Service"],
          providers: {} as ProviderRegistry.ProviderRegistry["Service"],
          serverSettings: {} as ServerSettings.ServerSettingsService["Service"],
          crypto: yield* Crypto.Crypto,
        },
        "Threads",
      );

      assert.strictEqual(yield* codeOf(threads.read(deletedId)), "PluginThreadNotFoundError");
      assert.strictEqual(yield* codeOf(threads.archive(deletedId)), "PluginThreadNotFoundError");
      assert.strictEqual(
        yield* codeOf(threads.create({ projectId: ProjectId.make("project:p"), title: "  " })),
        "SchemaError",
      );
      assert.deepStrictEqual(launched, []);
    }),
  );
});
