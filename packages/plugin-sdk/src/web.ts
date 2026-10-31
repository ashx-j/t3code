import type { JsonValue } from "./shared.ts";

/**
 * A React function component. Typed without React so the SDK has no dependencies. Build with
 * `@t3tools/plugin-sdk/vite` so the bundle uses T3's React instead of its own copy.
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
  /** Adds a stylesheet until the plugin unloads. Scope its selectors to the plugin's own classes. */
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
