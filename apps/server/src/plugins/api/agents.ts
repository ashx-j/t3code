import type { PluginApi } from "@t3tools/plugin-sdk/server";
import * as Effect from "effect/Effect";

import type * as PluginHooks from "../PluginHooks.ts";
import type { FacadeContext } from "./facade.ts";

// Codex truncates a context entry past this, and every turn pays for the text.
const MAX_INSTRUCTION_BYTES = 4_000;

export const makeAgentsApi = (
  facade: FacadeContext,
  services: { readonly hooks: PluginHooks.PluginHooksRegistry },
  pluginName: string,
): PluginApi["agents"] => ({
  addInstructions: (text) => {
    const { activation } = facade;
    if (activation.controller.signal.aborted) {
      throw new Error("This plugin activation has ended.");
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new TypeError("Instructions need some text.");
    }
    if (new TextEncoder().encode(text).byteLength > MAX_INSTRUCTION_BYTES) {
      throw new RangeError(`Instructions are limited to ${MAX_INSTRUCTION_BYTES} bytes.`);
    }
    const remove = Effect.runSyncWith(facade.context)(
      services.hooks.addAgentInstructions(
        facade.pluginId,
        `<t3_code_plugin name="${pluginName.replaceAll('"', "'")}">\n${text.trim()}\n</t3_code_plugin>`,
      ),
    );
    // Removing is a synchronous update, so the next turn after a disable no longer sees the text.
    activation.controller.signal.addEventListener(
      "abort",
      () => Effect.runSyncWith(facade.context)(remove),
      { once: true },
    );
  },
});
