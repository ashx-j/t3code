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

export interface WebPluginCommand {
  /**
   * Unique within the plugin: lowercase letters, digits and hyphens. Keybindings name the command
   * `plugin.<pluginId>.<id>`.
   */
  readonly id: string;
  /** Shown in the command palette. */
  readonly title: string;
  /** Extra words the command palette matches. */
  readonly keywords?: ReadonlyArray<string>;
  readonly run: () => void | Promise<void>;
}

export interface WebPluginSlashCommand {
  /** Typed after `/` in the composer: lowercase letters, digits and hyphens. */
  readonly name: string;
  readonly description: string;
  /**
   * Runs when the user picks the command; the typed `/name` is removed from the composer first.
   * `threadId` is null in a new thread, which the server doesn't know until its first message.
   */
  readonly run: (context: { readonly threadId: string | null }) => void | Promise<void>;
}

export interface WebPluginBanner {
  readonly title: string;
  readonly description?: string;
  readonly variant?: "info" | "success" | "warning" | "error";
}

export interface WebPluginToolRenderer {
  /** The name the server half passed to `mcp.registerTool`. */
  readonly tool: string;
  /** Replaces the tool call's details in the timeline. `output` is the tool's text result. */
  readonly component: WebPluginComponent<{
    readonly input: unknown;
    readonly output: string | null;
    readonly status: string;
  }>;
}

export interface WebPluginCodeBlockRenderer {
  /** The fence language, such as `chart` for ```chart blocks. `mermaid` and `math` are T3's own. */
  readonly language: string;
  /** Draws a closed fence in chat messages; while the fence is still streaming, it shows as code. */
  readonly component: WebPluginComponent<{ readonly code: string }>;
}

export interface WebPluginPage {
  /** Lowercase letters, digits and hyphens. The page opens at `/plugins/<pluginId>/<name>`. */
  readonly name: string;
  /** Shown in the page's header. */
  readonly title: string;
  readonly component: WebPluginComponent;
}

export interface WebPluginSidebarSection {
  /** Unique within the plugin: lowercase letters, digits and hyphens. */
  readonly id: string;
  /** Shown above the section. */
  readonly title: string;
  /** Drawn between the thread list and the sidebar's footer buttons. Keep it short. */
  readonly component: WebPluginComponent;
}

/** A button or menu item a plugin adds to one of T3's own toolbars or menus. */
export interface WebPluginAction<Context> {
  /** Unique within the plugin and the place it is added: lowercase letters, digits and hyphens. */
  readonly id: string;
  /** The menu item's label, or the button's tooltip and accessible name. */
  readonly title: string;
  /** The button's icon, about 16px. Buttons without one show T3's plugin icon. Menus ignore it. */
  readonly icon?: WebPluginComponent;
  readonly run: (context: Context) => void | Promise<void>;
}

/** The message a message action was used on. */
export interface WebPluginMessage {
  readonly threadId: string;
  readonly messageId: string;
  readonly role: "user" | "assistant";
  /** The message's text as shown, in Markdown. */
  readonly text: string;
}

/**
 * What a web plugin's `activate` receives. Everything is released when the plugin unloads. `Rpc`
 * types the calls into the plugin's server half.
 */
export interface WebPluginApi<Rpc extends PluginRpcMap = PluginRpcMap> {
  readonly version: 1;
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
  readonly settings: {
    /**
     * Shows on the Plugins page in place of the generated settings form. On a plugin installed in
     * several environments it changes the copy plugin UI loads from, and the generated form, when
     * the schema has fields, stays below it for every copy.
     */
    readonly registerPanel: (component: WebPluginComponent) => void;
  };
  readonly commands: {
    /** Adds a command to the command palette that users can also bind to a key. */
    readonly register: (command: WebPluginCommand) => void;
  };
  readonly composer: {
    /**
     * Shows a banner above the composer in every thread of this environment until it is hidden,
     * the user dismisses it, or the plugin unloads. Returns the function that hides it.
     */
    readonly showBanner: (banner: WebPluginBanner) => () => void;
    /** Adds a command to the composer's `/` menu. */
    readonly registerSlashCommand: (command: WebPluginSlashCommand) => void;
    /**
     * Offers items in the composer's `@` menu, matched against what the user types. A picked item
     * shows as a chip, and the agent gets its `text`, as it is when the message is sent, beside
     * the message. Each call replaces the plugin's list; past 500 items the rest are left out.
     */
    readonly setMentionItems: (
      items: ReadonlyArray<{
        /** Unique within the plugin. */
        readonly id: string;
        readonly label: string;
        readonly description?: string;
        /**
         * What the agent reads for the chip, up to 30,000 characters, or fewer when much of it
         * is control characters such as ANSI codes. The rest is cut.
         */
        readonly text: string;
      }>,
    ) => void;
    /** Adds a button beside the composer's attach button. `threadId` is null in a new thread. */
    readonly addButton: (button: WebPluginAction<{ readonly threadId: string | null }>) => void;
  };
  readonly threads: {
    /** Adds an item to the thread's actions menu, in its header and on right-click in the sidebar. */
    readonly addMenuItem: (item: WebPluginAction<{ readonly threadId: string }>) => void;
    /** Adds an icon button to the thread's header, after its title. */
    readonly addHeaderButton: (button: WebPluginAction<{ readonly threadId: string }>) => void;
    /**
     * Shows a short badge on the thread's sidebar row and in its header, or removes it with
     * `null`. Each plugin has one badge per thread; badges go away when the plugin unloads.
     */
    readonly setBadge: (
      threadId: string,
      badge: {
        readonly label: string;
        readonly tone?: "info" | "success" | "warning" | "error";
      } | null,
    ) => void;
  };
  readonly pages: {
    /**
     * Adds a full page beside the sidebar, in place of the thread, until the plugin unloads.
     * Open it with `navigate("/plugins/<pluginId>/<name>")`, or from outside the app with a
     * `t3code://plugins/<pluginId>/<name>` link, which opens the desktop app on it.
     */
    readonly register: (page: WebPluginPage) => void;
  };
  readonly sidebar: {
    /** Adds a titled section to the sidebar, under the thread list. */
    readonly addSection: (section: WebPluginSidebarSection) => void;
  };
  readonly messages: {
    /** Adds a button to the actions shown under each user and assistant message. */
    readonly addAction: (action: WebPluginAction<WebPluginMessage>) => void;
  };
  /**
   * A URL for a file in the plugin's `assets/` folder, such as `icon.svg`, usable in `src` and
   * `href`. It stays valid until the plugin unloads.
   */
  readonly assetUrl: (name: string) => Promise<string>;
  readonly markdown: {
    readonly registerCodeBlock: (renderer: WebPluginCodeBlockRenderer) => void;
  };
  readonly timeline: {
    /** Draws this plugin's agent tool calls in the timeline instead of the generic view. */
    readonly registerToolRenderer: (renderer: WebPluginToolRenderer) => void;
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

/** `@effect/atom-react` exports T3 shares with web plugins. Other exports are not available. */
export const HOST_ATOM_REACT_EXPORTS = [
  "RegistryContext",
  "useAtomMount",
  "useAtomRefresh",
  "useAtomSet",
  "useAtomSubscribe",
  "useAtomValue",
] as const;

/** `Atom` functions T3 shares with web plugins through `@t3tools/plugin-sdk/atom`. */
export const HOST_ATOM_EXPORTS = [
  "family",
  "keepAlive",
  "make",
  "map",
  "readable",
  "setIdleTTL",
  "transform",
  "withLabel",
  "writable",
] as const;

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
