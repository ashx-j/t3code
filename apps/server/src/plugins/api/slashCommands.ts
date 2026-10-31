import type { PluginApi, PluginSlashCommandResult } from "@t3tools/plugin-sdk/server";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as PluginHooks from "../PluginHooks.ts";
import type { FacadeContext } from "./facade.ts";

// The sender waits on the command, so it gets longer than a hook but still a bound.
const SLASH_COMMAND_DEADLINE = Duration.seconds(10);
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
// T3 handles these itself, on the server or in the composer.
const RESERVED = new Set([
  "btw",
  "compact",
  "default",
  "goal",
  "logout",
  "model",
  "plan",
  "side",
  "skill",
  "usage-limits",
]);
const MAX_TEXT_CHARS = 500;

const outcomeOf = (result: PluginSlashCommandResult, pluginName: string) => {
  if (typeof result !== "object" || result === null) return undefined;
  if ("block" in result && typeof result.block === "string") {
    return {
      block: result.block.trim().slice(0, MAX_TEXT_CHARS) || "Blocked this message.",
      pluginName,
    };
  }
  if ("text" in result && typeof result.text === "string" && result.text.trim().length > 0) {
    return { text: result.text };
  }
  return undefined;
};

const errorText = (error: unknown) => {
  let text = "Unknown error";
  try {
    text = error instanceof Error ? error.message : String(error);
  } catch {
    // Plugin code can throw values whose conversion to a string throws again.
  }
  return text.slice(0, MAX_TEXT_CHARS);
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
    if (!NAME.test(command.name) || RESERVED.has(command.name)) {
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
              Promise.resolve().then(() =>
                handler(
                  {
                    threadId: message.threadId,
                    messageId: message.messageId,
                    name: command.name,
                    args: message.args,
                    createdBy: message.createdBy,
                    attachments: message.attachments,
                  },
                  { signal: AbortSignal.any([signal, activation.controller.signal]) },
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
