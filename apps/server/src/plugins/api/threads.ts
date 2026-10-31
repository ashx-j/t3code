import {
  CommandId,
  MessageId,
  OrchestrationProjectShell,
  OrchestrationV2Notification,
  OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type { PluginApi } from "@t3tools/plugin-sdk/server";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import type * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import type { FacadeContext } from "./facade.ts";

const encodeThreadShell = Schema.encodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2ThreadShell),
);
const encodeProjectShell = Schema.encodeUnknownEffect(
  Schema.toCodecJson(OrchestrationProjectShell),
);
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);
const decodeNotification = Schema.decodeUnknownEffect(OrchestrationV2Notification);
const decodeProjectId = Schema.decodeUnknownEffect(ProjectId);
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

export const makeThreadsApi = (
  facade: FacadeContext,
  services: {
    readonly threads: ThreadManagementService.ThreadManagementService["Service"];
    readonly crypto: Crypto.Crypto;
  },
  pluginName: string,
): PluginApi["threads"] => {
  const { threads, crypto } = services;
  const newId = crypto.randomUUIDv4().pipe(Effect.orDie);
  const shellOf = Effect.fnUntraced(function* (threadId: string) {
    const id = yield* decodeThreadId(threadId);
    const shell = yield* threads.getThreadShell(id);
    if (shell === null) return yield* new PluginThreadNotFoundError({ threadId });
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
          const shells = yield* threads.listProjectThreads({ projectId, includeSubagents: false });
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
          yield* threads.sendToThread({
            projectId: shell.projectId,
            commandId: CommandId.make(`command:plugin:${facade.pluginId}:${yield* newId}`),
            threadId: shell.id,
            messageId: MessageId.make(yield* newId),
            text: input.text,
            attachments: [],
            mode: input.mode ?? "auto",
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
            commandId: CommandId.make(`command:plugin:${facade.pluginId}:${yield* newId}`),
            threadId: shell.id,
            turnItemId: TurnItemId.make(`turn-item:plugin:${facade.pluginId}:${yield* newId}`),
            notification: { ...notification, summary: `${pluginName}: ${notification.summary}` },
          });
        }),
      ),
    interrupt: (threadId) =>
      facade.call(
        Effect.gen(function* () {
          const shell = yield* shellOf(threadId);
          yield* threads.interruptThread({
            projectId: shell.projectId,
            commandId: CommandId.make(`command:plugin:${facade.pluginId}:${yield* newId}`),
            threadId: shell.id,
          });
        }),
      ),
    rename: (threadId, title) =>
      facade.call(
        Effect.gen(function* () {
          const shell = yield* shellOf(threadId);
          yield* threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`command:plugin:${facade.pluginId}:${yield* newId}`),
            threadId: shell.id,
            title,
          });
        }),
      ),
  };
};

export const makeProjectsApi = (
  facade: FacadeContext,
  services: { readonly projects: ProjectStore.ProjectStoreV2["Service"] },
): PluginApi["projects"] => ({
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
    facade
      .call(
        decodeProjectId(projectId).pipe(
          Effect.flatMap(services.projects.getShell),
          Effect.flatMap((shell) =>
            Option.isNone(shell)
              ? Effect.succeedNone
              : encodeProjectShell(shell.value).pipe(
                  Effect.map((encoded) => Option.some(asJsonObject(encoded))),
                ),
          ),
        ),
      )
      .then(Option.getOrUndefined),
});
