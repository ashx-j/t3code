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
  registerPluginCommand,
  registerPluginRightPanel,
  registerPluginSlashCommand,
  registerPluginSettingsPanel,
  setPluginWebFailure,
} from "./pluginRegistry";
import { isLoadableWebPlugin } from "./pluginWatch";

const PANEL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const COMMAND_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

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
  readonly cleanups: Array<() => void>;
  /** One dispatcher scope shared by every plugin; commands add and remove their own entries. */
  readonly shortcutHandlers: CommandHandlers;
  readonly navigate: (path: string) => void;
}

function makeWebPluginApi({
  environmentId,
  plugin,
  cleanups,
  shortcutHandlers,
  navigate,
}: WebPluginApiContext): WebPluginApi {
  const pluginId = plugin.id;
  const assetUrls = new Map<string, Promise<string>>();
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
        cleanups.push(stop);
        return stop;
      },
    },
    rightPanel: {
      register: (panel) => {
        if (!PANEL_NAME.test(panel.name)) {
          throw new TypeError(`"${panel.name}" is not a valid panel name.`);
        }
        cleanups.push(
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
        cleanups.push(
          registerPluginSettingsPanel(environmentId, pluginId, component as ComponentType),
        );
      },
    },
    commands: {
      register: (command) => {
        if (!COMMAND_ID.test(command.id)) {
          throw new TypeError(`"${command.id}" is not a valid command id.`);
        }
        const keybindingCommand = `plugin.${pluginId}.${command.id}` as const;
        const run = () => runReportingFailure(command.title, command.run);
        cleanups.push(
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
        shortcutHandlers[keybindingCommand] = (event) => {
          event.preventDefault();
          run();
        };
        cleanups.push(() => {
          delete shortcutHandlers[keybindingCommand];
        });
      },
    },
    composer: {
      registerSlashCommand: (command) => {
        if (!COMMAND_ID.test(command.name)) {
          throw new TypeError(`"${command.name}" is not a valid slash command name.`);
        }
        cleanups.push(
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
          cleanups.push(() => URL.revokeObjectURL(objectUrl));
          return objectUrl;
        });
      assetUrls.set(name, url);
      return url;
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
      cleanups.push(cleanup);
    },
  };
}

interface LoadedPlugin {
  readonly version: string | undefined;
  readonly cleanups: Array<() => void>;
}

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
  const stopShortcuts = registerCommands(shortcutHandlers);
  const loaded = new Map<PluginState["id"], LoadedPlugin>();
  let queue = Promise.resolve();
  let stopped = false;

  const unload = (pluginId: PluginState["id"]) => {
    const plugin = loaded.get(pluginId);
    if (plugin === undefined) return;
    loaded.delete(pluginId);
    runCleanups(plugin.cleanups);
  };

  const load = async (plugin: PluginState) => {
    const cleanups: Array<() => void> = [];
    loaded.set(plugin.id, { version: plugin.version, cleanups });
    try {
      const bundle = await fetchPluginFile(environmentId, plugin, "/web.js");
      const definition = await importBundle(await bundle.text());
      if (stopped || loaded.get(plugin.id)?.cleanups !== cleanups) return;
      await definition.activate(
        makeWebPluginApi({ environmentId, plugin, cleanups, shortcutHandlers, navigate }),
      );
      setPluginWebFailure(environmentId, plugin.id, undefined);
    } catch (error) {
      unload(plugin.id);
      setPluginWebFailure(environmentId, plugin.id, errorText(error));
    }
  };

  const reconcile = async (plugins: ReadonlyArray<PluginState>) => {
    const wanted = new Map(
      plugins.filter(isLoadableWebPlugin).map((plugin) => [plugin.id, plugin] as const),
    );
    for (const [pluginId, plugin] of loaded) {
      if (wanted.get(pluginId)?.version !== plugin.version) unload(pluginId);
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
    stopShortcuts();
  };
}
