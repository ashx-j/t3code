import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ServerCommand,
  PluginId,
  type Project,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";

import type * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import type * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import type * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import type * as ProjectService from "../../project/ProjectService.ts";
import type * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { makePluginActivation, type PluginPublication } from "../PluginApi.ts";
import { makeFacadeContext } from "./facade.ts";
import { makeProjectsApi, makeThreadsApi } from "./threads.ts";

const threadId = ThreadId.make("thread:workbench");
const projectId = ProjectId.make("project:workbench");
const defaultModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };
const project: Project = {
  id: projectId,
  title: "Workbench project",
  workspaceRoot: "/repo",
  defaultModelSelection: defaultModel,
  scripts: [],
  createdAt: "2026-10-31T00:00:00.000Z",
  updatedAt: "2026-10-31T00:00:00.000Z",
  deletedAt: null,
};

/** The threads and projects APIs of a plugin named Workbench, over services that record calls. */
const workbench = Effect.fn(function* (providers: ReadonlyArray<ServerProvider> = []) {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const launched: Array<ThreadLaunchService.ThreadLaunchInput> = [];
  const projectUpdates: Array<unknown> = [];
  const facade = makeFacadeContext({
    pluginId: PluginId.make("workbench"),
    activation: makePluginActivation(yield* PubSub.sliding<PluginPublication>(1)),
    context: yield* Effect.context<never>(),
  });
  const crypto = yield* Crypto.Crypto;
  const projectService = {
    getById: () => Effect.succeedSome(project),
    update: (input) =>
      Effect.sync(() => {
        projectUpdates.push(input);
        return { ...project, pinnedAt: "2026-10-31T00:00:00.000Z" };
      }),
  } as Partial<
    ProjectService.ProjectService["Service"]
  > as ProjectService.ProjectService["Service"];
  const threads = makeThreadsApi(
    facade,
    {
      threads: {
        getThreadShell: () =>
          Effect.succeed({ id: threadId, projectId, worktreePath: null, deletedAt: null } as never),
        settleThread: (input) =>
          Effect.sync(() => {
            dispatched.push({ type: "thread.settle", ...input } as never);
            return { sequence: 1 };
          }),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: 1, storedEvents: [] } as never;
          }),
      } as Partial<
        ThreadManagementService.ThreadManagementService["Service"]
      > as ThreadManagementService.ThreadManagementService["Service"],
      launches: {
        launch: (input) =>
          Effect.sync(() => {
            launched.push(input);
            return { threadId: input.threadId } as never;
          }),
      } as Partial<
        ThreadLaunchService.ThreadLaunchService["Service"]
      > as ThreadLaunchService.ThreadLaunchService["Service"],
      projectService,
      providers: {
        getProviders: Effect.succeed(providers),
      } as Partial<
        ProviderRegistry.ProviderRegistry["Service"]
      > as ProviderRegistry.ProviderRegistry["Service"],
      serverSettings: yield* Effect.provide(
        ServerSettings.ServerSettingsService,
        ServerSettings.layerTest(),
      ),
      crypto,
    },
    "Workbench",
  );
  const projects = makeProjectsApi(facade, {
    projects: {} as ProjectStore.ProjectStoreV2["Service"],
    projectService,
    crypto,
  });
  return { threads, projects, dispatched, launched, projectUpdates };
});

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

  it.effect("renames a thread and adds a note to it, named for the plugin", () =>
    Effect.gen(function* () {
      const { threads, dispatched } = yield* workbench();
      yield* Effect.promise(() => threads.rename(threadId, "Renamed by a plugin"));
      assert.strictEqual(yield* codeOf(threads.rename(threadId, "  ")), "SchemaError");
      yield* Effect.promise(() =>
        threads.notify({ threadId, summary: "Checked", outcome: "completed" }),
      );
      assert.lengthOf(dispatched, 2);
      assert.deepInclude(dispatched[0], {
        type: "thread.metadata.update",
        threadId,
        title: "Renamed by a plugin",
      });
      assert.deepInclude(dispatched[1], {
        type: "thread.notification.record",
        threadId,
        notification: {
          source: { kind: "system" },
          outcome: "completed",
          summary: "Workbench: Checked",
        },
      });
    }),
  );

  it.effect("organizes threads and projects through the commands and services clients use", () =>
    Effect.gen(function* () {
      const { threads, projects, dispatched, launched, projectUpdates } = yield* workbench();
      yield* Effect.promise(async () => {
        await threads.archive(threadId);
        await threads.unarchive(threadId);
        await threads.snooze(threadId, "2026-11-01T09:00:00.000Z");
        await threads.unsnooze(threadId);
        await threads.settle(threadId);
        await threads.unsettle(threadId);
        await threads.delete(threadId);
      });
      assert.deepStrictEqual(
        dispatched.map((command) => command.type),
        [
          "thread.archive",
          "thread.unarchive",
          "thread.snooze",
          "thread.unsnooze",
          "thread.settle",
          "thread.unsettle",
          "thread.delete",
        ],
      );
      assert.deepInclude(dispatched[2], { snoozedUntil: "2026-11-01T09:00:00.000Z" });

      // A new thread starts with the project's model, as the composer's would.
      const followUp = yield* Effect.promise(() =>
        threads.create({ projectId, title: "Follow-up", message: "Check the deploy." }),
      );
      assert.deepInclude(launched[0], {
        projectId,
        title: "Follow-up",
        modelSelection: defaultModel,
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        createdBy: "agent",
        creationSource: "server",
      });
      assert.strictEqual(launched[0]?.initialMessage?.text, "Check the deploy.");
      assert.strictEqual(followUp.threadId, launched[0]?.threadId);

      const pinned = yield* Effect.promise(() => projects.update(projectId, { pinned: true }));
      assert.deepInclude(projectUpdates[0], { projectId, pinned: true });
      assert.strictEqual(pinned.title, "Workbench project");
    }),
  );

  it.effect("starts a thread with the model options its provider lists, and refuses others", () =>
    Effect.gen(function* () {
      const effort = {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      } as const;
      const { threads, launched } = yield* workbench([
        {
          instanceId: defaultModel.instanceId,
          models: [{ slug: defaultModel.model, capabilities: { optionDescriptors: [effort] } }],
        } as never,
      ]);
      const create = (options: ReadonlyArray<{ id: string; value: string | boolean }>) =>
        threads.create({ projectId, title: "Review", model: { ...defaultModel, options } });

      yield* Effect.promise(() => create([{ id: "reasoningEffort", value: "high" }]));
      assert.deepStrictEqual(launched[0]?.modelSelection, {
        ...defaultModel,
        options: [{ id: "reasoningEffort", value: "high" }],
      });
      const refused = yield* Effect.promise(() =>
        create([{ id: "effort", value: "max" }]).then(
          () => undefined,
          (error: Error & { readonly code: string }) => error,
        ),
      );
      assert.strictEqual(refused?.code, "PluginThreadModelOptionsError");
      assert.strictEqual(
        refused?.message,
        "Model gpt-5.5 on codex rejected options: Unknown option effort; supported options: reasoningEffort.",
      );
      assert.strictEqual(
        yield* codeOf(create([{ id: "reasoningEffort", value: "max" }])),
        "PluginThreadModelOptionsError",
      );
      assert.lengthOf(launched, 1);
    }),
  );
});
