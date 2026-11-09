import type { ReactNode } from "react";

import type { PluginRpcMap } from "./shared.ts";

/** `invoke`'s input: optional when the method's input may be undefined. */
type RpcInputArgs<Input> = undefined extends Input ? [input?: Input] : [input: Input];

/** Anything React can draw: an element, text, or null for nothing. */
export type WebPluginNode = ReactNode;

/**
 * A React function component. Only React's types are needed: build with
 * `@t3tools/plugin-sdk/vite` so the bundle uses T3's React instead of its own copy.
 */
export type WebPluginComponent<Props = Record<string, never>> = (props: Props) => WebPluginNode;

export interface WebPluginRightPanel {
  /** Unique within the plugin. Letters, digits, `_` and `-`. */
  readonly name: string;
  /** Shown on the panel's tab and in the panel's add menu. */
  readonly title: string;
  /** Rendered in the right panel of the thread the user opened it in. */
  readonly component: WebPluginComponent<{ readonly threadId: string }>;
}

/**
 * What a web plugin's `activate` receives. Everything is released when the plugin unloads. `Rpc`
 * types the calls into the plugin's server half.
 */
export interface WebPluginApi<Rpc extends PluginRpcMap = PluginRpcMap> {
  /**
   * This API's version, 1 so far. T3 raises it when the API gains a member, whose doc then names
   * the version that added it, so a plugin can check it before using a member an older T3 lacks.
   * To refuse older T3 releases outright, set `engines.t3` in the manifest.
   */
  readonly version: number;
  readonly id: string;
  /** The environment whose server this plugin was loaded from. */
  readonly environmentId: string;
  readonly rpc: {
    /**
     * Calls a method the plugin's server half registered. A failure rejects with the server's
     * reason, such as the message the handler threw.
     */
    readonly invoke: <Method extends Extract<keyof Rpc["methods"], string>>(
      method: Method,
      ...input: RpcInputArgs<Rpc["methods"][Method]["input"]>
    ) => Promise<Rpc["methods"][Method]["output"]>;
    /** Follows a channel the plugin's server half publishes to; returns the unsubscribe function. */
    readonly subscribe: <Channel extends Extract<keyof Rpc["channels"], string>>(
      channel: Channel,
      onValue: (value: Rpc["channels"][Channel]) => void,
    ) => () => void;
  };
  readonly rightPanel: {
    readonly register: (panel: WebPluginRightPanel) => void;
  };
  /**
   * Adds a stylesheet until the plugin unloads. Rules that reach T3's own elements restyle the app
   * and can stop matching when T3 changes its markup.
   */
  readonly injectStyles: (css: string) => void;
  /** Opens a path in the app, such as `/settings/plugins`. */
  readonly navigate: (path: string) => void;
  readonly toast: (message: {
    readonly title: string;
    readonly description?: string;
    readonly type?: "info" | "success" | "warning" | "error";
  }) => void;
  /** Runs when the plugin is disabled, reloaded or unloaded. */
  readonly onDeactivate: (cleanup: () => void) => void;
}

export interface WebPluginDefinition<Rpc extends PluginRpcMap = PluginRpcMap> {
  readonly activate: (api: WebPluginApi<Rpc>) => void | Promise<void>;
}

/** Components T3 shares with web plugins through `@t3tools/plugin-sdk/ui`. */
export const HOST_UI_EXPORTS = [
  "Badge",
  "Button",
  "Empty",
  "EmptyContent",
  "EmptyDescription",
  "EmptyHeader",
  "EmptyMedia",
  "EmptyTitle",
  "Input",
  "Label",
  "Switch",
  "Textarea",
] as const;

/**
 * Types a web plugin. The ESM bundle's default export is the result. Pass the plugin's
 * `PluginRpcMap`, as in `defineWebPlugin<NotesRpc>({ ... })`, to type `api.rpc`.
 */
export const defineWebPlugin = <Rpc extends PluginRpcMap = PluginRpcMap>(
  definition: WebPluginDefinition<Rpc>,
): WebPluginDefinition<Rpc> => definition;
