import {
  type CommandId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  OrchestrationProjectShell,
  OrchestrationV2Notification,
  type OrchestrationV2ServerCommand,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestrationV2ThreadShell,
  Project,
  ProjectCreatePayload,
  ProjectId,
  ProjectUpdatePayload,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "@t3tools/contracts";
import type { PluginApi } from "@t3tools/plugin-sdk/server";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveRuntimeMode } from "../../mcp/delegatedTaskModes.ts";
import type * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import type * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import type * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import type * as ProjectService from "../../project/ProjectService.ts";
import type * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import type * as ServerSettings from "../../serverSettings.ts";
import { type FacadeContext, newCommandId } from "./facade.ts";

const encodeThreadShell = Schema.encodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2ThreadShell),
);
const encodeProjectShell = Schema.encodeUnknownEffect(
  Schema.toCodecJson(OrchestrationProjectShell),
);
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);
const decodeNotification = Schema.decodeUnknownEffect(OrchestrationV2Notification);
const decodeProjectId = Schema.decodeUnknownEffect(ProjectId);
const decodeLaunch = Schema.decodeUnknownEffect(
  Schema.Struct({
    projectId: ProjectId,
    title: TrimmedNonEmptyString,
    message: Schema.optional(Schema.String),
    model: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    workspace: Schema.optional(OrchestrationV2ThreadLaunchWorkspaceStrategy),
  }),
);
const decodeSnoozedUntil = Schema.decodeUnknownEffect(IsoDateTime);
const decodeTitle = Schema.decodeUnknownEffect(TrimmedNonEmptyString);
const decodeSend = Schema.decodeUnknownEffect(
  Schema.Struct({
    text: TrimmedNonEmptyString,
    mode: Schema.optional(Schema.Literals(["auto", "queue", "steer"])),
  }),
);
const MAX_NOTE_SUMMARY_CHARS = 200;
const MAX_NOTE_DETAIL_CHARS = 20_000;
const decodeProjectCreate = Schema.decodeUnknownEffect(Schema.toCodecJson(ProjectCreatePayload));
const decodeProjectUpdate = Schema.decodeUnknownEffect(Schema.toCodecJson(ProjectUpdatePayload));
const encodeProject = Schema.encodeUnknownEffect(Schema.toCodecJson(Project));
const isJsonObject = Schema.is(Schema.JsonObject);

const asJsonObject = (value: unknown): Schema.JsonObject => (isJsonObject(value) ? value : {});

export class PluginThreadNotFoundError extends Schema.TaggedError<PluginThreadNotFoundError>()(
  "PluginThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} does not exist.`;
  }
}

export class PluginProjectNotFoundError extends Schema.TaggedError<PluginProjectNotFoundError>()(
  "PluginProjectNotFoundError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Project ${this.projectId} does not exist.`;
  }
}

export class PluginThreadModelMissingError extends Schema.TaggedError<PluginThreadModelMissingError>()(
  "PluginThreadModelMissingError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Project ${this.projectId} has no default model; pass one.`;
  }
}

export const makeThreadsApi = (
  facade: FacadeContext,
  services: {
    readonly threads: ThreadManagementService.ThreadManagementService["Service"];
    readonly launches: ThreadLaunchService.ThreadLaunchService["Service"];
    readonly projectService: ProjectService.ProjectService["Service"];
    readonly providers: ProviderRegistry.ProviderRegistry["Service"];
    readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
    readonly crypto: Crypto.Crypto;
  },
  pluginName: string,
): PluginApi["threads"] => {
  const { threads, crypto } = services;
  const newId = crypto.randomUUIDv4().pipe(Effect.orDie);
  const commandId = newCommandId(facade.pluginId, crypto);
  /** Dispatches the command clients send for the same change, after checking the thread exists. */
  const organize = (
    threadId: string,
    command: (common: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<OrchestrationV2ServerCommand, Schema.SchemaError>,
  ) =>
    facade.call(
      Effect.gen(function* () {
        const shell = yield* shellOf(threadId);
        yield* threads.dispatch(
          yield* command({ commandId: yield* commandId, threadId: shell.id }),
        );
      }),
    );
  const shellOf = Effect.fnUntraced(function* (threadId: string) {
    const id = yield* decodeThreadId(threadId);
    const shell = yield* threads.getThreadShell(id);
    // A deleted thread keeps its shell, but agents and clients treat it as gone.
    if (shell === null || shell.deletedAt !== null) {
      return yield* new PluginThreadNotFoundError({ threadId });
    }
    return shell;
  });
  return {
    list: (options) =>
      facade.call(
        Effect.gen(function* () {
          const projectId =
            options?.projectId === undefined
              ? undefined
              : yield* decodeProjectId(options.projectId);
          const shells = yield* threads.listProjectThreads({
            projectId,
            includeSubagents: false,
            archived: options?.archived === true,
          });
          return yield* Effect.forEach(shells, (shell) =>
            encodeThreadShell(shell).pipe(Effect.map(asJsonObject)),
          );
        }),
      ),
    read: (threadId) =>
      facade.call(
        shellOf(threadId).pipe(Effect.flatMap(encodeThreadShell), Effect.map(asJsonObject)),
      ),
    sendMessage: (input) =>
      facade.call(
        Effect.gen(function* () {
          const shell = yield* shellOf(input.threadId);
          const { text, mode } = yield* decodeSend(input);
          yield* threads.sendToThread({
            projectId: shell.projectId,
            commandId: yield* commandId,
            threadId: shell.id,
            messageId: MessageId.make(yield* newId),
            text,
            attachments: [],
            mode: mode ?? "auto",
            createdBy: "agent",
            creationSource: "server",
          });
        }),
      ),
    notify: (input) =>
      facade.call(
        Effect.gen(function* () {
          const shell = yield* shellOf(input.threadId);
          const notification = yield* decodeNotification({
            source: { kind: "system" },
            outcome: input.outcome ?? "updated",
            summary: input.summary,
            ...(input.detail === undefined ? {} : { detail: input.detail }),
          });
          yield* threads.dispatch({
            type: "thread.notification.record",
            commandId: yield* commandId,
            threadId: shell.id,
            turnItemId: TurnItemId.make(`turn-item:plugin:${facade.pluginId}:${yield* newId}`),
            // Every client keeps a thread's notes in memory, so a note stays a note.
            notification: {
              ...notification,
              summary: `${pluginName}: ${notification.summary.slice(0, MAX_NOTE_SUMMARY_CHARS)}`,
              ...(notification.detail === undefined
                ? {}
                : { detail: notification.detail.slice(0, MAX_NOTE_DETAIL_CHARS) }),
            },
          });
        }),
      ),
    interrupt: (threadId) =>
      facade.call(
        Effect.gen(function* () {
          const shell = yield* shellOf(threadId);
          yield* threads.interruptThread({
            projectId: shell.projectId,
            commandId: yield* commandId,
            threadId: shell.id,
          });
        }),
      ),
    create: (input) =>
      facade.call(
        Effect.gen(function* () {
          const launch = yield* decodeLaunch(input);
          const project = yield* services.projectService.getById(launch.projectId);
          if (Option.isNone(project)) {
            return yield* new PluginProjectNotFoundError({ projectId: launch.projectId });
          }
          // The project's defaults, as the composer and an agent outside a thread start with.
          const defaults = resolveProjectSettings(
            yield* services.serverSettings.getSettings,
            launch.projectId,
            project.value,
          ).settings;
          const providers = yield* services.providers.getProviders;
          const modelSelection =
            launch.model ??
            resolveNewThreadModelSelection({
              defaultSelection: defaults.defaultModelSelection,
              fallbackSelection: defaults.fallbackModelSelection,
              providers,
              settings: defaults,
              projectId: launch.projectId,
              now: DateTime.toEpochMillis(yield* DateTime.now),
            }).selection;
          if (modelSelection == null) {
            return yield* new PluginThreadModelMissingError({ projectId: launch.projectId });
          }
          // A mode the provider does not offer steps down to the broadest one it does.
          const runtimeMode = yield* resolveRuntimeMode(
            launch.runtimeMode ?? defaults.defaultRuntimeMode,
            undefined,
            {
              modelSelection,
              supportedRuntimeModes: providers.find(
                (provider) => provider.instanceId === modelSelection.instanceId,
              )?.supportedRuntimeModes,
            },
          );
          const launchCommandId = yield* commandId;
          const result = yield* services.launches.launch({
            commandId: launchCommandId,
            threadId: ThreadId.make(launchCommandId),
            projectId: launch.projectId,
            title: launch.title,
            modelSelection,
            runtimeMode,
            interactionMode: launch.interactionMode ?? "default",
            workspaceStrategy: launch.workspace ?? { type: "root" },
            ...(launch.message === undefined || launch.message.trim().length === 0
              ? {}
              : {
                  initialMessage: {
                    messageId: MessageId.make(yield* newId),
                    text: launch.message,
                    attachments: [],
                  },
                }),
            createdBy: "agent",
            creationSource: "server",
          });
          return { threadId: result.threadId };
        }),
      ),
    archive: (threadId) =>
      organize(threadId, (common) => Effect.succeed({ ...common, type: "thread.archive" })),
    unarchive: (threadId) =>
      organize(threadId, (common) => Effect.succeed({ ...common, type: "thread.unarchive" })),
    delete: (threadId) =>
      organize(threadId, (common) => Effect.succeed({ ...common, type: "thread.delete" })),
    settle: (threadId) =>
      facade.call(
        Effect.gen(function* () {
          const shell = yield* shellOf(threadId);
          yield* threads.settleThread({
            commandId: yield* commandId,
            threadId: shell.id,
            byOwnAgent: false,
          });
        }),
      ),
    unsettle: (threadId) =>
      organize(threadId, (common) =>
        Effect.succeed({ ...common, type: "thread.unsettle", reason: "user" }),
      ),
    snooze: (threadId, until) =>
      organize(threadId, (common) =>
        decodeSnoozedUntil(until instanceof Date ? until.toISOString() : until).pipe(
          Effect.map((snoozedUntil) => ({ ...common, type: "thread.snooze", snoozedUntil })),
        ),
      ),
    unsnooze: (threadId) =>
      organize(threadId, (common) =>
        Effect.succeed({ ...common, type: "thread.unsnooze", reason: "user" }),
      ),
    rename: (threadId, title) =>
      facade.call(
        Effect.gen(function* () {
          const shell = yield* shellOf(threadId);
          yield* threads.dispatch({
            type: "thread.metadata.update",
            commandId: yield* commandId,
            threadId: shell.id,
            title: yield* decodeTitle(title),
          });
        }),
      ),
  };
};

export const makeProjectsApi = (
  facade: FacadeContext,
  services: {
    readonly projects: ProjectStore.ProjectStoreV2["Service"];
    readonly projectService: ProjectService.ProjectService["Service"];
    readonly crypto: Crypto.Crypto;
  },
): PluginApi["projects"] => ({
  create: (input) =>
    facade.call(
      Effect.gen(function* () {
        const payload = yield* decodeProjectCreate(input);
        const commandId = yield* newCommandId(facade.pluginId, services.crypto);
        const project = yield* services.projectService.create({
          ...payload,
          commandId,
          projectId: ProjectId.make(commandId),
        });
        return asJsonObject(yield* encodeProject(project));
      }),
    ),
  update: (projectId, patch) =>
    facade.call(
      Effect.gen(function* () {
        const payload = yield* decodeProjectUpdate(patch);
        const project = yield* services.projectService.update({
          ...payload,
          projectId: yield* decodeProjectId(projectId),
          commandId: yield* newCommandId(facade.pluginId, services.crypto),
        });
        return asJsonObject(yield* encodeProject(project));
      }),
    ),
  list: () =>
    facade.call(
      services.projects
        .listShells()
        .pipe(
          Effect.flatMap((shells) =>
            Effect.forEach(shells, (shell) =>
              encodeProjectShell(shell).pipe(Effect.map(asJsonObject)),
            ),
          ),
        ),
    ),
  read: (projectId) =>
    facade.call(
      decodeProjectId(projectId).pipe(
        Effect.flatMap(services.projects.getShell),
        Effect.flatMap((shell) =>
          Option.isNone(shell)
            ? Effect.succeedNone
            : encodeProjectShell(shell.value).pipe(
                Effect.map((encoded) => Option.some(asJsonObject(encoded))),
              ),
        ),
        Effect.map(Option.getOrUndefined),
      ),
    ),
});
