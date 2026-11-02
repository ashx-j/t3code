import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import type { ReactNode } from "react";

import type { JsonValue } from "./shared.ts";

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
  /** Desktop app only; ignored in a browser. */
  readonly desktop?: {
    /** Lists the command under Plugins in the app menu. */
    readonly menu?: boolean;
    /** Lists the command in a tray icon's menu. The icon shows only while some command asks for it. */
    readonly tray?: boolean;
    /**
     * Runs the command from anywhere, even while T3 Code is in the background, as an Electron
     * accelerator such as `CommandOrControl+Shift+Y`. Skipped when another app already holds it.
     */
    readonly globalShortcut?: string;
  };
  readonly run: () => void | Promise<void>;
}

export interface WebPluginSlashCommand {
  /** Typed after `/` in the composer: lowercase letters, digits and hyphens. */
  readonly name: string;
  readonly description: string;
  /** Runs when the user picks the command; the typed `/name` is removed from the composer first. */
  readonly run: (context: { readonly threadId: string }) => void | Promise<void>;
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
  /** The button's icon, about 16px. Buttons without one show a puzzle piece. Menus ignore it. */
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
 * T3's own parts a plugin can draw its own way with `ui.replace`. Each piece is a React element T3
 * has already wired up: place it, wrap it or leave it out. `original` is T3's own drawing.
 */
export interface WebPluginParts {
  /**
   * The row under the composer's text box. While no provider is available, `model` offers to open
   * provider settings and `effort` and `access` draw nothing.
   */
  readonly "composer.controls": {
    readonly original: WebPluginNode;
    /** The attach button, or null where the composer offers no attachments. */
    readonly attach: WebPluginNode;
    /** T3's grouped model, effort and permissions controls. */
    readonly controls: WebPluginNode;
    /** A picker that only chooses the model. */
    readonly model: WebPluginNode;
    /** The reasoning effort picker; draws nothing when the model has no options. */
    readonly effort: WebPluginNode;
    /** The permissions picker, always labelled, and the plan toggle when plan mode is on. */
    readonly access: WebPluginNode;
    /** Send, stop and the other primary actions. */
    readonly actions: WebPluginNode;
    /** Buttons plugins added with `composer.addButton`; draws nothing when there are none. */
    readonly buttons: WebPluginNode;
  };
  /** An assistant message's text in the timeline, drawn as Markdown. */
  readonly "message.assistant": {
    readonly original: WebPluginNode;
    /** The message's Markdown, growing while it streams. */
    readonly text: string;
    readonly messageId: string;
    /** Null outside a thread, such as in a shared guest view. */
    readonly threadId: string | null;
    readonly streaming: boolean;
  };
  /** A user message's text in the timeline, drawn as Markdown. */
  readonly "message.user": {
    readonly original: WebPluginNode;
    readonly text: string;
    readonly messageId: string;
    /** Null outside a thread, such as in a shared guest view. */
    readonly threadId: string | null;
  };
  /** The details shown when a tool call, command or other step of an agent's work is expanded. */
  readonly "timeline.item": {
    readonly original: WebPluginNode;
    /**
     * The step as T3 sends it to clients. `type` names the kind, such as `command_execution`,
     * `file_change`, `web_search` or `dynamic_tool`, and narrows the other fields.
     */
    readonly item: OrchestrationV2TurnItem;
    /** The step's text output, when it has one. */
    readonly output: string | null;
  };
  /** The file diffs in the diff panel. */
  readonly "diff.view": {
    readonly original: WebPluginNode;
    /** The selection's unified diff, or null while T3 loads it file by file. */
    readonly patch: string | null;
  };
  /** The frame Settings and Usage open in. T3 draws a large window over the thread. */
  readonly "app.pageFrame": {
    readonly original: WebPluginNode;
    /** The page itself, with its section list, header and close button. */
    readonly content: WebPluginNode;
    /**
     * The page in place of the thread, beside the sidebar, without its section list: draw `nav`
     * here, or `app.sidebar`'s `nav` in the sidebar. Esc goes back. Its header is the window's
     * title bar row, with room for the window controls, and its close button hides while the
     * sidebar beside it shows `app.sidebar`'s `back`.
     */
    readonly page: WebPluginNode;
    /** The page's section list, such as Settings' sections and search; null when it has none. */
    readonly nav: WebPluginNode;
    /** Which page this is. Compare this, not `label`, which is text for people. */
    readonly kind: "settings" | "usage";
    /** The page's name as shown, such as `Settings`. */
    readonly label: string;
    /** Goes back to where the page was opened. */
    readonly close: () => void;
  };
  /**
   * The sidebar's content, on wide screens and in the phone's sheet. To give a page shown through
   * `app.pageFrame`'s `page` its own sidebar, draw `nav` in place of `threads` and `back` in place
   * of `footer`.
   */
  readonly "app.sidebar": {
    readonly original: WebPluginNode;
    /** The top row: the T3 Code name, back and forward buttons, and the toggle on phones. */
    readonly header: WebPluginNode;
    /** The thread list with its search row, and the sections plugins added under it. */
    readonly threads: WebPluginNode;
    /** The bottom row: the Settings, Pull requests and Usage buttons, and T3's update button. */
    readonly footer: WebPluginNode;
    /** `footer` with a Back button in place of its Settings, Pull requests and Usage buttons. */
    readonly back: WebPluginNode;
    /** T3's update button and update notices alone; `footer` and `back` already have them. */
    readonly update: WebPluginNode;
    /** The open page's section list, made for the sidebar, while `page` is `settings`; else null. */
    readonly nav: WebPluginNode;
    /** The page shown through `app.pageFrame`'s `page` beside the sidebar, otherwise null. */
    readonly page: "settings" | "usage" | null;
  };
}

/** What a web plugin's `activate` receives. Everything is released when the plugin unloads. */
export interface WebPluginApi {
  readonly version: 1;
  readonly id: string;
  /** The environment whose server this plugin was loaded from. */
  readonly environmentId: string;
  readonly rpc: {
    /**
     * Calls a method the plugin's server half registered. A failure rejects with the server's
     * reason, such as the message the handler threw.
     */
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
     * the message. Each call replaces the plugin's list.
     */
    readonly setMentionItems: (
      items: ReadonlyArray<{
        /** Unique within the plugin. */
        readonly id: string;
        readonly label: string;
        readonly description?: string;
        /** What the agent reads for the chip, up to 30,000 characters; the rest is cut. */
        readonly text: string;
      }>,
    ) => void;
    /** Adds a button beside the composer's attach button. `threadId` is null in a new thread. */
    readonly addButton: (button: WebPluginAction<{ readonly threadId: string | null }>) => void;
    /**
     * While on, the composer on wide screens folds to one line, as it does on phones, when the
     * timeline scrolls up away from its end. Focusing it or scrolling back to the end unfolds it.
     */
    readonly setCollapseOnScroll: (enabled: boolean) => void;
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
  readonly ui: {
    /**
     * Draws one of T3's parts until the plugin unloads. When several plugins replace the same
     * part, the one loaded last wins. If the component throws, T3 draws its own part.
     */
    readonly replace: <Part extends keyof WebPluginParts>(
      part: Part,
      component: WebPluginComponent<WebPluginParts[Part]>,
    ) => void;
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

export interface WebPluginDefinition {
  readonly activate: (api: WebPluginApi) => void | Promise<void>;
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

/** Types a web plugin. The ESM bundle's default export is the result. */
export const defineWebPlugin = (definition: WebPluginDefinition): WebPluginDefinition => definition;
