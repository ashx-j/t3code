import {
  type ChatAttachment,
  type CommandId,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2ServerCommand,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { isPluginCommand } from "./api/facade.ts";
import * as PluginHooks from "./PluginHooks.ts";

const attachmentsSeen = (attachments: ReadonlyArray<ChatAttachment>) =>
  attachments.map((attachment) => ({
    type: attachment.type,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  }));

const modelSeen = (selection: ModelSelection | undefined) =>
  selection === undefined
    ? {}
    : { model: { instanceId: selection.instanceId, model: selection.model } };

/** Messages and queued edits whose hooks run, by thread; nothing else waits on hooks. */
const orderedThread = (command: OrchestrationV2ServerCommand): ThreadId | undefined => {
  switch (command.type) {
    case "message.dispatch":
      // A plugin's own send skips the line: a command handler awaiting a send to its own thread
      // would wait on itself.
      return command.notification !== undefined ||
        command.guestMessageId !== undefined ||
        command.createdBy === "system" ||
        isPluginCommand(command.commandId)
        ? undefined
        : command.threadId;
    case "queued-run.edit":
      return command.threadId;
    default:
      return undefined;
  }
};

/**
 * Plugins see user and agent text before orchestration records it, may change or block it, and
 * handle their own slash commands: in new messages, edits of queued ones and delegated task
 * prompts. Notifications and guest messages are not the sender's own text, so they skip plugins.
 * Dispatches what the hooks return instead of `command`; a block rejects it with the reason.
 */
export const makePluginSendHooks = Effect.gen(function* () {
  const hooks = yield* PluginHooks.PluginHooks;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;

  const accepted = (commandId: CommandId) =>
    receipts.getByCommandId(commandId).pipe(
      Effect.map(Option.isSome),
      Effect.orElseSucceed(() => false),
    );
  // A steer that missed its turn sends the recorded message again under a new command id, and
  // that text already went through the hooks.
  const acceptedMessage = (commandId: CommandId, threadId: ThreadId, messageId: MessageId) =>
    accepted(commandId).pipe(
      Effect.flatMap((replay) =>
        replay
          ? Effect.succeed(true)
          : orchestrator.getThreadRecords(threadId, ["messages"], { messageIds: [messageId] }).pipe(
              Effect.map((records) => records.messages.some((message) => message.id === messageId)),
              Effect.orElseSucceed(() => false),
            ),
      ),
    );
  // The queued message as hooks see it; nothing when it is not the sender's own text, which the
  // orchestrator refuses to edit anyway.
  const queuedMessage = Effect.fnUntraced(function* (
    threadId: ThreadId,
    runId: RunId,
    attachments: ReadonlyArray<ChatAttachment> | undefined,
  ) {
    const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"], { runIds: [runId] });
    const run = runs.find((candidate) => candidate.id === runId);
    if (run?.userMessageId == null) return undefined;
    const messageId = run.userMessageId;
    const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"], {
      messageIds: [messageId],
    });
    const message = messages.find((candidate) => candidate.id === messageId);
    if (
      message === undefined ||
      message.createdBy === "system" ||
      message.notification !== undefined ||
      message.context?.guest !== undefined
    ) {
      return undefined;
    }
    return {
      threadId,
      messageId,
      text: message.text,
      createdBy: message.createdBy,
      creationSource: message.creationSource,
      attachments: attachmentsSeen(attachments ?? message.attachments),
      ...modelSeen(run.modelSelection),
    };
  });

  // The last message in line on each thread. A hook or command can take seconds, and the thread's
  // next message must not reach the orchestrator before it. Only the dispatch waits its turn: a
  // message's own hooks run at once, so slow hooks never add up across a thread's messages.
  const lines = new Map<ThreadId, Deferred.Deferred<void>>();
  const inThreadOrder = <B, E1, A, E2>(
    threadId: ThreadId,
    prepare: Effect.Effect<B, E1>,
    dispatch: (prepared: B) => Effect.Effect<A, E2>,
  ) =>
    Effect.uninterruptibleMask((restore) => {
      const done = Deferred.makeUnsafe<void>();
      const ahead = lines.get(threadId);
      lines.set(threadId, done);
      return restore(
        prepare.pipe(
          Effect.flatMap((prepared) =>
            ahead === undefined
              ? dispatch(prepared)
              : Deferred.await(ahead).pipe(Effect.andThen(dispatch(prepared))),
          ),
        ),
      ).pipe(
        // A sender that gives up or is blocked still lets the next one go only after its own.
        Effect.ensuring(
          Effect.suspend(() => {
            if (lines.get(threadId) === done) {
              if (ahead === undefined || Deferred.isDoneUnsafe(ahead)) lines.delete(threadId);
              else lines.set(threadId, ahead);
            }
            return Deferred.completeWith(
              done,
              ahead === undefined ? Effect.void : Deferred.await(ahead),
            );
          }),
        ),
      );
    });

  const withHooks = (
    command: OrchestrationV2ServerCommand,
  ): Effect.Effect<OrchestrationV2ServerCommand, Orchestrator.OrchestratorCommandRejectedError> => {
    // Every caller already handles a rejected command; its cause carries the plugin's reason,
    // which is what clients show.
    const rejected = (blocked: PluginHooks.PluginMessageBlockedError) =>
      new Orchestrator.OrchestratorCommandRejectedError({
        commandId: command.commandId,
        commandType: command.type,
        cause: blocked,
      });
    switch (command.type) {
      case "message.dispatch": {
        if (
          command.notification !== undefined ||
          command.guestMessageId !== undefined ||
          command.createdBy === "system"
        ) {
          return Effect.succeed(command);
        }
        return hooks
          .beforeDispatch(
            {
              threadId: command.threadId,
              messageId: command.messageId,
              text: command.text,
              createdBy: command.createdBy,
              creationSource: command.creationSource,
              attachments: attachmentsSeen(command.attachments),
              ...modelSeen(command.modelSelection),
            },
            acceptedMessage(command.commandId, command.threadId, command.messageId),
            command.modelSelection === undefined
              ? orchestrator.getThreadRecords(command.threadId, []).pipe(
                  Effect.map((projection) => projection.thread.modelSelection.instanceId),
                  Effect.orElseSucceed(() => undefined),
                )
              : Effect.succeed(command.modelSelection.instanceId),
          )
          .pipe(
            Effect.map((text) => (text === command.text ? command : { ...command, text })),
            Effect.mapError(rejected),
          );
      }
      case "queued-run.edit":
        return hooks
          .beforeRewrite(
            command.text,
            queuedMessage(command.threadId, command.runId, command.attachments).pipe(
              Effect.orElseSucceed(() => undefined),
            ),
            accepted(command.commandId),
          )
          .pipe(
            Effect.map((text) => (text === command.text ? command : { ...command, text })),
            Effect.mapError(rejected),
          );
      case "delegated_task.request": {
        if (command.createdBy === "system") return Effect.succeed(command);
        // The child thread and its first message take ids derived from the command.
        const message = {
          threadId: derive.delegatedTaskThread({ commandId: command.commandId }),
          messageId: derive.delegatedTaskMessage({ commandId: command.commandId }),
          text: command.task,
          createdBy: command.createdBy,
          creationSource: command.creationSource,
          attachments: [],
          ...modelSeen(command.modelSelection),
        };
        return hooks
          .beforeRewrite(command.task, Effect.succeed(message), accepted(command.commandId))
          .pipe(
            Effect.map((text) =>
              text === command.task ? command : { ...command, task: text.trim() },
            ),
            Effect.mapError(rejected),
          );
      }
      default:
        return Effect.succeed(command);
    }
  };

  return <A, E>(
    command: OrchestrationV2ServerCommand,
    dispatch: (next: OrchestrationV2ServerCommand) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | Orchestrator.OrchestratorCommandRejectedError> => {
    const send = withHooks(command).pipe(Effect.flatMap(dispatch));
    const threadId = orderedThread(command);
    return threadId === undefined
      ? send
      : hooks.handlesMessages.pipe(
          // A message still in line keeps the next one behind it after the last plugin stops.
          Effect.flatMap((handled) =>
            handled || lines.has(threadId)
              ? inThreadOrder(threadId, withHooks(command), dispatch)
              : send,
          ),
        );
  };
});
