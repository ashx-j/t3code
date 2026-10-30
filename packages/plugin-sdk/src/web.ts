import type { JsonValue } from "./shared.ts";

/**
 * A React function component. Typed without React so the SDK has no dependencies; write it with
 * the host's React from `globalThis.__t3PluginHost.react`, never a bundled copy.
 */
export type WebPluginComponent<Props = Record<string, never>> = (props: Props) => unknown;

export interface WebPluginRightPanel {
  /** Unique within the plugin. Letters, digits, `_` and `-`. */
  readonly name: string;
  /** Shown on the panel's tab and in the panel's add menu. */
  readonly title: string;
  /** Rendered in the right panel of the thread the user opened it in. */
  readonly component: WebPluginComponent<{ readonly threadId: string }>;
}

/** What a web plugin's `activate` receives. Everything is released when the plugin unloads. */
export interface WebPluginApi {
  readonly version: 1;
  readonly id: string;
  /** The environment whose server this plugin was loaded from. */
  readonly environmentId: string;
  readonly rpc: {
    /** Calls a method the plugin's server half registered. */
    readonly invoke: (method: string, input?: JsonValue) => Promise<JsonValue>;
    /** Follows a channel the plugin's server half publishes to; returns the unsubscribe function. */
    readonly subscribe: (channel: string, onValue: (value: JsonValue) => void) => () => void;
  };
  readonly rightPanel: {
    readonly register: (panel: WebPluginRightPanel) => void;
  };
  readonly settings: {
    /** Replaces the generated settings form on the Plugins page. */
    readonly registerPanel: (component: WebPluginComponent) => void;
  };
  readonly toast: (message: {
    readonly title: string;
    readonly description?: string;
    readonly type?: "info" | "success" | "warning" | "error";
  }) => void;
  /** Runs when the plugin is disabled, reloaded or unloaded. */
  readonly onDeactivate: (cleanup: () => void) => void;
}

export interface WebPluginDefinition {
  readonly activate: (api: WebPluginApi) => void | Promise<void>;
}

/** Types a web plugin. The ESM bundle's default export is the result. */
export const defineWebPlugin = (definition: WebPluginDefinition): WebPluginDefinition => definition;
