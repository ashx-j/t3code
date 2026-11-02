import { USAGE_LIMITS_COMMAND } from "./usageLimits.ts";

/** Slash commands the composer runs itself instead of sending them to the agent. */
const COMPOSER_SLASH_COMMANDS = ["model", "plan", "default", "side", "btw"] as const;
export type ComposerSlashCommand = (typeof COMPOSER_SLASH_COMMANDS)[number];

/**
 * Every slash command name T3 Code handles itself, in the composer or on the server, so plugins
 * cannot register one. `skill` is the prefix of `/skill:<name>` items.
 */
export const T3_SLASH_COMMAND_NAMES: ReadonlySet<string> = new Set([
  ...COMPOSER_SLASH_COMMANDS,
  "compact",
  "goal",
  "logout",
  "skill",
  USAGE_LIMITS_COMMAND.name,
]);
