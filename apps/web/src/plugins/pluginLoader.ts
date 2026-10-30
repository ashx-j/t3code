import {
  RegistryContext,
  useAtomMount,
  useAtomRefresh,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PluginState } from "@t3tools/contracts";
import {
  defineWebPlugin,
  type HOST_ATOM_REACT_EXPORTS,
  type HOST_UI_EXPORTS,
  type WebPluginApi,
  type WebPluginDefinition,
} from "@t3tools/plugin-sdk/web";
import { AsyncResult } from "effect/reactivity";
import * as React from "react";
import type { ComponentType } from "react";
import * as ReactDOM from "react-dom";
import * as jsxRuntime from "react/jsx-runtime";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { registerCommands, type CommandHandlers } from "../shortcuts/dispatcher";
import { pluginEnvironment } from "../state/plugins";
import { readPreparedConnection } from "../state/session";
import {
  registerPluginBanner,
  registerPluginCodeBlock,
  registerPluginCommand,
  registerPluginRightPanel,
  registerPluginSlashCommand,
  registerPluginToolRenderer,
  registerPluginSettingsPanel,
  setPluginWebFailure,
  type PluginToolRendererProps,
} from "./pluginRegistry";
import { isLoadableWebPlugin } from "./pluginWatch";

const PANEL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const COMMAND_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CODE_LANGUAGE = /^[a-z0-9][a-z0-9+#.-]{0,31}$/;
// Languages the app already draws itself.
const BUILT_IN_LANGUAGES = new Set(["mermaid", "math"]);

/**
 * Bundles import React and the UI kit from here instead of shipping their own copies; the SDK's
 * Vite preset rewrites those imports to this object. `atomReact` lists only hooks the app already
 * bundles, because a namespace import would keep every export in the startup chunk.
 */
const installHostModules = () =>
  Reflect.set(globalThis, "__t3PluginHost", {
    react: React,
    reactDom: ReactDOM,
    jsxRuntime,
    atomReact: {
      RegistryContext,
      useAtomMount,
      useAtomRefresh,
      useAtomSet,
      useAtomSubscribe,
      useAtomValue,
    } satisfies Record<(typeof HOST_ATOM_REACT_EXPORTS)[number], unknown>,
    sdk: { defineWebPlugin },
    ui: {
      Badge,
      Button,
      Empty,
      EmptyContent,
      EmptyDescription,
      EmptyHeader,
      EmptyMedia,
      EmptyTitle,
      Input,
      Label,
      Switch,
      Textarea,
    } satisfies Record<(typeof HOST_UI_EXPORTS)[number], unknown>,
  });

const isWebPluginDefinition = (value: unknown): value is WebPluginDefinition =>
  typeof value === "object" &&
  value !== null &&
  "activate" in value &&
  typeof value.activate === "function";

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : "The plugin's web bundle failed.").slice(0, 500);

// Bearer and cookie sessions can fetch plugin files directly. A DPoP proof needs the relay
// signer, which only the client runtime holds.
async function fetchPluginFile(
  environmentId: EnvironmentId,
  plugin: PluginState,
  filePath: string,
): Promise<Response> {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("The environment is not connected.");
  const authorization = connection.httpAuthorization;
  if (authorization?._tag === "Dpop") {
    throw new Error("Plugin web bundles cannot load over a T3 Connect link yet.");
  }
  const url = new URL(
    `/api/plugins/${encodeURIComponent(plugin.id)}${filePath}`,
    connection.httpBaseUrl,
  );
  url.searchParams.set("v", plugin.version ?? "0");
  const response = await fetch(
    url,
    authorization === null
      ? { credentials: "include" }
      : { headers: { authorization: `Bearer ${authorization.token}` } },
  );
  if (!response.ok) throw new Error(`The request for ${filePath} failed with ${response.status}.`);
  return response;
}

// A bare import() cannot send credentials, so the bundle runs from an object URL.
async function importBundle(code: string) {
  const objectUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try {
    const module: unknown = await import(/* @vite-ignore */ objectUrl);
    const definition =
      typeof module === "object" && module !== null && "default" in module
        ? module.default
        : undefined;
    if (!isWebPluginDefinition(definition)) {
      throw new Error("The web bundle does not export a plugin with an activate function.");
    }
    return definition;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Runs plugin code from a user action; a failure becomes an error toast. */
const runReportingFailure = (label: string, run: () => void | Promise<void>) => {
  void Promise.resolve()
    .then(run)
    .catch((error: unknown) => {
      toastManager.add({ type: "error", title: `${label} failed`, description: errorText(error) });
    });
};

interface WebPluginApiContext {
  readonly environmentId: EnvironmentId;
  readonly plugin: PluginState;
  /** Keeps a cleanup for unload, or runs it at once when the plugin is already unloaded. */
  readonly track: (cleanup: () => void) => void;
  /** One dispatcher scope shared by every plugin; commands add and remove their own entries. */
  readonly shortcutHandlers: () => CommandHandlers;
  readonly navigate: (path: string) => void;
}

function makeWebPluginApi({
  environmentId,
  plugin,
  track,
  shortcutHandlers,
  navigate,
}: WebPluginApiContext): WebPluginApi {
  const pluginId = plugin.id;
  const assetUrls = new Map<string, Promise<string>>();
  let bannerCount = 0;
  return {
    version: 1,
    id: pluginId,
    environmentId,
    rpc: {
      invoke: async (method, input) => {
        const result = await runAtomCommand(
          appAtomRegistry,
          pluginEnvironment.invokePlugin,
          {
            environmentId,
            input: { pluginId, method, ...(input === undefined ? {} : { input }) },
          },
          { reportFailure: false },
        );
        if (result._tag === "Success") return result.value.output;
        throw new Error(`${pluginId}.${method} failed.`);
      },
      subscribe: (channel, onValue) => {
        const atom = pluginEnvironment.pluginChannel({
          environmentId,
          input: { pluginId, channel },
        });
        const stop = appAtomRegistry.subscribe(atom, (result) => {
          if (AsyncResult.isSuccess(result)) onValue(result.value.value);
        });
        track(stop);
        return stop;
      },
    },
    rightPanel: {
      register: (panel) => {
        if (!PANEL_NAME.test(panel.name)) {
          throw new TypeError(`"${panel.name}" is not a valid panel name.`);
        }
        track(
          registerPluginRightPanel({
            environmentId,
            pluginId,
            name: panel.name,
            title: panel.title,
            // The SDK types components without React; they are React function components.
            component: panel.component as ComponentType<{ readonly threadId: string }>,
          }),
        );
      },
    },
    settings: {
      registerPanel: (component) => {
        track(registerPluginSettingsPanel(environmentId, pluginId, component as ComponentType));
      },
    },
    commands: {
      register: (command) => {
        if (!COMMAND_ID.test(command.id)) {
          throw new TypeError(`"${command.id}" is not a valid command id.`);
        }
        const keybindingCommand = `plugin.${pluginId}.${command.id}` as const;
        const run = () => runReportingFailure(command.title, command.run);
        track(
          registerPluginCommand({
            environmentId,
            pluginId,
            pluginName: plugin.name,
            command: keybindingCommand,
            title: command.title,
            keywords: command.keywords ?? [],
            run,
          }),
        );
        const handlers = shortcutHandlers();
        handlers[keybindingCommand] = (event) => {
          event.preventDefault();
          run();
        };
        track(() => {
          delete handlers[keybindingCommand];
        });
      },
    },
    composer: {
      showBanner: (banner) => {
        bannerCount += 1;
        const hide: () => void = registerPluginBanner({
          key: `${pluginId}:${bannerCount}`,
          environmentId,
          pluginId,
          variant: banner.variant ?? "info",
          title: banner.title,
          ...(banner.description === undefined ? {} : { description: banner.description }),
          dismiss: () => hide(),
        });
        track(hide);
        return hide;
      },
      registerSlashCommand: (command) => {
        if (!COMMAND_ID.test(command.name)) {
          throw new TypeError(`"${command.name}" is not a valid slash command name.`);
        }
        track(
          registerPluginSlashCommand({
            environmentId,
            pluginId,
            pluginName: plugin.name,
            name: command.name,
            description: command.description,
            run: (context) => runReportingFailure(`/${command.name}`, () => command.run(context)),
          }),
        );
      },
    },
    assetUrl: (name) => {
      const cached = assetUrls.get(name);
      if (cached !== undefined) return cached;
      const url = fetchPluginFile(
        environmentId,
        plugin,
        `/assets/${name.split("/").map(encodeURIComponent).join("/")}`,
      )
        .then((response) => response.blob())
        .then((blob) => {
          const objectUrl = URL.createObjectURL(blob);
          track(() => URL.revokeObjectURL(objectUrl));
          return objectUrl;
        });
      assetUrls.set(name, url);
      return url;
    },
    markdown: {
      registerCodeBlock: (renderer) => {
        if (!CODE_LANGUAGE.test(renderer.language) || BUILT_IN_LANGUAGES.has(renderer.language)) {
          throw new TypeError(`"${renderer.language}" is not a language plugins can draw.`);
        }
        track(
          registerPluginCodeBlock(
            renderer.language,
            renderer.component as ComponentType<{ readonly code: string }>,
          ),
        );
      },
    },
    timeline: {
      registerToolRenderer: (renderer) => {
        track(
          registerPluginToolRenderer({
            environmentId,
            toolName: `plg_${pluginId}_${renderer.tool}`,
            // The SDK types components without React; they are React function components.
            component: renderer.component as ComponentType<PluginToolRendererProps>,
          }),
        );
      },
    },
    injectStyles: (css) => {
      const style = document.createElement("style");
      style.dataset.plugin = pluginId;
      style.textContent = css;
      document.head.append(style);
      track(() => style.remove());
    },
    navigate: (path) => {
      if (!path.startsWith("/")) throw new TypeError(`"${path}" is not an app path.`);
      navigate(path);
    },
    toast: (message) => {
      toastManager.add({
        type: message.type ?? "info",
        title: message.title,
        ...(message.description === undefined ? {} : { description: message.description }),
      });
    },
    onDeactivate: (cleanup) => {
      track(cleanup);
    },
  };
}

interface LoadedPlugin {
  /** Version and start revision: a change of either loads the bundle again. */
  readonly key: string;
  readonly cleanups: Array<() => void>;
  disposed: boolean;
}

// The server gives `activate` 30 seconds; a bundle that never loads or settles fails the same way
// instead of holding up every other plugin behind it.
const WEB_PLUGIN_DEADLINE_MS = 30_000;

const withDeadline = async <A>(work: Promise<A>, what: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} took longer than 30 seconds.`)),
      WEB_PLUGIN_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

const loadKey = (plugin: PluginState) => `${plugin.version ?? ""}:${plugin.revision ?? ""}`;

const runCleanups = (cleanups: ReadonlyArray<() => void>) => {
  for (const cleanup of cleanups.toReversed()) {
    try {
      cleanup();
    } catch {
      // A plugin's cleanup must not keep the others from running.
    }
  }
};

/**
 * Loads the environment's active web plugins and follows plugin state until stopped. Each plugin
 * fails alone: a failed fetch, import or activate is recorded for the Plugins page.
 */
export function startPluginLoader(
  environmentId: EnvironmentId,
  navigate: (path: string) => void,
): () => void {
  installHostModules();
  const shortcutHandlers: CommandHandlers = {};
  // Registered with the first plugin command, so key presses pay nothing until one exists.
  let stopShortcuts: (() => void) | undefined;
  const claimShortcutHandlers = () => {
    stopShortcuts ??= registerCommands(shortcutHandlers);
    return shortcutHandlers;
  };
  const loaded = new Map<PluginState["id"], LoadedPlugin>();
  let queue = Promise.resolve();
  let stopped = false;

  const unload = (pluginId: PluginState["id"]) => {
    const plugin = loaded.get(pluginId);
    if (plugin === undefined) return;
    loaded.delete(pluginId);
    plugin.disposed = true;
    runCleanups(plugin.cleanups);
  };

  const load = async (plugin: PluginState) => {
    const entry: LoadedPlugin = { key: loadKey(plugin), cleanups: [], disposed: false };
    loaded.set(plugin.id, entry);
    // Registrations that arrive after unload, from a slow `activate` or a later callback, are
    // undone at once instead of outliving the plugin.
    const track = (cleanup: () => void) => {
      if (entry.disposed) runCleanups([cleanup]);
      else entry.cleanups.push(cleanup);
    };
    try {
      const bundle = await withDeadline(
        fetchPluginFile(environmentId, plugin, "/web.js").then((response) => response.text()),
        "Loading the web bundle",
      );
      const definition = await importBundle(bundle);
      if (stopped || entry.disposed) return;
      await withDeadline(
        Promise.resolve(
          definition.activate(
            makeWebPluginApi({
              environmentId,
              plugin,
              track,
              shortcutHandlers: claimShortcutHandlers,
              navigate,
            }),
          ),
        ),
        "Starting the web half",
      );
      setPluginWebFailure(environmentId, plugin.id, undefined);
    } catch (error) {
      if (loaded.get(plugin.id) === entry) unload(plugin.id);
      setPluginWebFailure(environmentId, plugin.id, errorText(error));
    }
  };

  const reconcile = async (plugins: ReadonlyArray<PluginState>) => {
    const wanted = new Map(
      plugins.filter(isLoadableWebPlugin).map((plugin) => [plugin.id, plugin] as const),
    );
    for (const [pluginId, plugin] of loaded) {
      const want = wanted.get(pluginId);
      if (want === undefined || loadKey(want) !== plugin.key) unload(pluginId);
    }
    for (const plugin of plugins) {
      if (!wanted.has(plugin.id)) setPluginWebFailure(environmentId, plugin.id, undefined);
    }
    for (const plugin of wanted.values()) {
      if (!loaded.has(plugin.id)) await load(plugin);
    }
  };

  const stopFollowing = appAtomRegistry.subscribe(
    pluginEnvironment.pluginsLive({ environmentId, input: {} }),
    (result) => {
      if (!AsyncResult.isSuccess(result)) return;
      const plugins = result.value.plugins;
      queue = queue.then(() => (stopped ? undefined : reconcile(plugins)));
    },
    { immediate: true },
  );

  return () => {
    stopped = true;
    stopFollowing();
    for (const pluginId of loaded.keys()) unload(pluginId);
    stopShortcuts?.();
  };
}
