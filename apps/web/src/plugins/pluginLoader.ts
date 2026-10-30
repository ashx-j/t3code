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
import { pluginEnvironment } from "../state/plugins";
import { readPreparedConnection } from "../state/session";
import {
  registerPluginRightPanel,
  registerPluginSettingsPanel,
  setPluginWebFailure,
} from "./pluginRegistry";
import { isLoadableWebPlugin } from "./pluginWatch";

const PANEL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

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
    },
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
    },
  });

const isWebPluginDefinition = (value: unknown): value is WebPluginDefinition =>
  typeof value === "object" &&
  value !== null &&
  "activate" in value &&
  typeof value.activate === "function";

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : "The plugin's web bundle failed.").slice(0, 500);

// Bearer and cookie sessions can fetch a bundle directly. A DPoP proof needs the relay signer,
// which only the client runtime holds.
async function fetchBundle(environmentId: EnvironmentId, plugin: PluginState) {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("The environment is not connected.");
  const authorization = connection.httpAuthorization;
  if (authorization?._tag === "Dpop") {
    throw new Error("Plugin web bundles cannot load over a T3 Connect link yet.");
  }
  const url = new URL(
    `/api/plugins/${encodeURIComponent(plugin.id)}/web.js`,
    connection.httpBaseUrl,
  );
  url.searchParams.set("v", plugin.version ?? "0");
  const response = await fetch(
    url,
    authorization === null
      ? { credentials: "include" }
      : { headers: { authorization: `Bearer ${authorization.token}` } },
  );
  if (!response.ok) throw new Error(`The web bundle request failed with ${response.status}.`);
  return response.text();
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

function makeWebPluginApi(
  environmentId: EnvironmentId,
  pluginId: PluginState["id"],
  cleanups: Array<() => void>,
): WebPluginApi {
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
export function startPluginLoader(environmentId: EnvironmentId): () => void {
  installHostModules();
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
      const definition = await importBundle(await fetchBundle(environmentId, plugin));
      if (stopped || loaded.get(plugin.id)?.cleanups !== cleanups) return;
      await definition.activate(makeWebPluginApi(environmentId, plugin.id, cleanups));
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
  };
}
