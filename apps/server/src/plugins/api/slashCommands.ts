import type { PluginApi, PluginSlashCommandResult } from "@t3tools/plugin-sdk/server";
import { T3_SLASH_COMMAND_NAMES } from "@t3tools/shared/slashCommands";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as PluginHooks from "../PluginHooks.ts";
import { errorText, type FacadeContext } from "./facade.ts";

// The sender waits on the command, so it gets longer than a hook but still a bound.
const SLASH_COMMAND_DEADLINE = Duration.seconds(10);
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_TEXT_CHARS = 500;
// Every client holds a thread's messages in memory, so one reply stays a message, not a document.
const MAX_REPLY_CHARS = 20_000;

const outcomeOf = (result: PluginSlashCommandResult, pluginName: string) => {
  if (typeof result !== "object" || result === null) return undefined;
  if ("block" in result && typeof result.block === "string") {
    return {
      block: result.block.trim().slice(0, MAX_TEXT_CHARS) || "Blocked this message.",
      pluginName,
    };
  }
  if ("reply" in result && typeof result.reply === "string" && result.reply.trim().length > 0) {
    return { reply: result.reply.slice(0, MAX_REPLY_CHARS) };
  }
  if ("text" in result && typeof result.text === "string" && result.text.trim().length > 0) {
    return { text: result.text };
  }
  return undefined;
};

class PluginSlashCommandError extends Schema.TaggedError<PluginSlashCommandError>()(
  "PluginSlashCommandError",
  { reason: Schema.String },
) {}

export const makeSlashCommandsApi = (
  facade: FacadeContext,
  services: { readonly hooks: PluginHooks.PluginHooksRegistry },
  pluginName: string,
): PluginApi["slashCommands"] => ({
  register: (command, handler) => {
    const { activation, pluginId } = facade;
    if (activation.controller.signal.aborted) {
      throw new Error("This plugin activation has ended.");
    }
    if (!NAME.test(command.name) || T3_SLASH_COMMAND_NAMES.has(command.name)) {
      throw new TypeError(
        `"/${command.name}" is not available. Use lowercase letters, digits and "-", and none of T3 Code's own commands.`,
      );
    }
    const added = Effect.runSyncExitWith(facade.context)(
      services.hooks.addSlashCommand(
        {
          pluginId,
          pluginName,
          name: command.name,
          ...(typeof command.description === "string" ? { description: command.description } : {}),
          ...(typeof command.inputHint === "string" ? { inputHint: command.inputHint } : {}),
        },
        // The sender asked this plugin by name, so a failure stops the message with the reason
        // instead of sending `/name` to the agent.
        (message) =>
          Effect.tryPromise({
            try: (signal) =>
              facade.asPlugin(() =>
                Promise.resolve().then(() =>
                  handler(
                    {
                      threadId: message.threadId,
                      messageId: message.messageId,
                      name: command.name,
                      args: message.args,
                      createdBy: message.createdBy,
                      creationSource: message.creationSource,
                      attachments: message.attachments,
                    },
                    { signal: AbortSignal.any([signal, activation.controller.signal]) },
                  ),
                ),
              ),
            catch: (error) => new PluginSlashCommandError({ reason: errorText(error) }),
          }).pipe(
            Effect.timeoutOption(SLASH_COMMAND_DEADLINE),
            Effect.map(
              Option.match({
                onNone: () => ({ block: `/${command.name} took too long.`, pluginName }),
                onSome: (result) => outcomeOf(result, pluginName),
              }),
            ),
            Effect.catchTags({
              PluginSlashCommandError: (error) =>
                Effect.succeed({ block: `/${command.name} failed: ${error.reason}`, pluginName }),
            }),
            // Whatever a plugin turned off mid-command answered no longer counts.
            Effect.map((outcome) =>
              activation.controller.signal.aborted
                ? {
                    block: `/${command.name} stopped because the plugin was turned off.`,
                    pluginName,
                  }
                : outcome,
            ),
          ),
      ),
    );
    if (Exit.isFailure(added)) throw Cause.squash(added.cause);
    activation.controller.signal.addEventListener(
      "abort",
      () => Effect.runForkWith(facade.context)(added.value),
      { once: true },
    );
  },
});
