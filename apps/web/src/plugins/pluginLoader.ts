import {
  RegistryContext,
  useAtomMount,
  useAtomRefresh,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from "@effect/atom-react";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PluginState } from "@t3tools/contracts";
import type * as SdkAtom from "@t3tools/plugin-sdk/atom";
import {
  type HOST_ATOM_EXPORTS,
  type HOST_ATOM_REACT_EXPORTS,
  type HOST_UI_EXPORTS,
  type WebPluginApi,
  type WebPluginDefinition,
} from "@t3tools/plugin-sdk/web";
import { AsyncResult, Atom } from "effect/reactivity";
import * as React from "react";
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
import {
  registerPluginCommand,
  pluginPageKey,
  registerPluginPage,
  registerPluginRightPanel,
  registerPluginSidebarSection,
  registerPluginSettingsPanel,
  setPluginWebFailure,
  type PluginOwner,
} from "./pluginRegistry";
import { fetchPluginFile, withDownloadRetries } from "./pluginFiles";
import { pluginUiAtom } from "./pluginUi";
import { pluginUi } from "./pluginUiParts";
import { isLoadableWebPlugin } from "./pluginWatch";

const PANEL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const COMMAND_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TOAST_TYPES = new Set(["info", "success", "warning", "error"]);

/**
 * Bundles import React and the UI kit from here instead of shipping their own copies; the SDK's
 * Vite preset rewrites those imports to this object. `atomReact` and `atom` list only what the app
 * already bundles, because a namespace import would keep every export in the startup chunk.
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
    // The SDK declares these with T3's own types, so a plugin's atoms type as T3's.
    atom: {
      family: Atom.family,
      keepAlive: Atom.keepAlive,
      make: Atom.make,
      map: Atom.map,
      readable: Atom.readable,
      setIdleTTL: Atom.setIdleTTL,
      transform: Atom.transform,
      withLabel: Atom.withLabel,
      writable: Atom.writable,
    } satisfies { readonly [Name in (typeof HOST_ATOM_EXPORTS)[number]]: (typeof SdkAtom)[Name] },
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

// A plugin can throw anything; a thrown string is still its message.
const errorText = (error: unknown) =>
  (error instanceof Error
    ? error.message
    : typeof error === "string" && error !== ""
      ? error
      : "The plugin's web bundle failed."
  ).slice(0, 500);

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
  /**
   * Keeps a cleanup for unload, or runs it at once when the plugin is already unloaded. Returns the
   * function that forgets the cleanup without running it.
   */
  readonly track: (cleanup: () => void) => () => void;
  /** One dispatcher scope shared by every plugin; commands add and remove their own entries. */
  readonly shortcutHandlers: () => CommandHandlers;
  readonly navigate: (path: string) => void;
  /** False once the plugin unloaded: a timer or callback it left behind must change nothing. */
  readonly active: () => boolean;
}

function makeWebPluginApi({
  environmentId,
  plugin,
  track,
  shortcutHandlers,
  navigate,
  active,
}: WebPluginApiContext): WebPluginApi {
  const pluginId = plugin.id;
  const assetUrls = new Map<string, Promise<string>>();
  // Shared by everything the plugin draws, so a render failure reaches its row once.
  const owner: PluginOwner = { environmentId, pluginId, pluginName: plugin.name };
  return {
    version: 1,
    id: pluginId,
    environmentId,
    rpc: {
      invoke: async (method, input) => {
        // A leftover timer from an unloaded start must not keep calling the new server half.
        if (!active()) throw new Error(`${pluginId} is no longer loaded here.`);
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
        // The server's reason, so the plugin's UI can say why its own call failed.
        const failure = squashAtomCommandFailure(result);
        throw new Error(
          failure instanceof Error && failure.message !== ""
            ? failure.message
            : `${pluginId}.${method} failed.`,
        );
      },
      subscribe: (channel, onValue) => {
        const atom = pluginEnvironment.pluginChannel({
          environmentId,
          input: { pluginId, channel },
        });
        // `immediate` reads the atom, which starts its stream; a bare subscribe on an atom no one
        // has read yet waits for a change that never comes.
        const stop = appAtomRegistry.subscribe(
          atom,
          (result) => {
            if (AsyncResult.isSuccess(result)) onValue(result.value.value);
          },
          { immediate: true },
        );
        const untrack = track(stop);
        return () => {
          untrack();
          stop();
        };
      },
    },
    rightPanel: {
      register: (panel) => {
        if (!PANEL_NAME.test(panel.name) || typeof panel.title !== "string") {
          throw new TypeError(`"${panel.name}" needs a valid name and a text title.`);
        }
        track(
          registerPluginRightPanel({
            environmentId,
            pluginId,
            name: panel.name,
            title: panel.title,
            component: panel.component,
            owner,
          }),
        );
      },
    },
    settings: {
      registerPanel: (component) => {
        // A replaced start's late panel would take the current start's place, then remove it.
        if (!active()) return;
        track(registerPluginSettingsPanel({ component, owner }));
      },
    },
    commands: {
      register: (command) => {
        if (
          !COMMAND_ID.test(command.id) ||
          typeof command.title !== "string" ||
          (command.keywords !== undefined &&
            (!Array.isArray(command.keywords) ||
              !command.keywords.every((keyword) => typeof keyword === "string")))
        ) {
          throw new TypeError(
            `"${command.id}" needs an id of lowercase letters, digits and hyphens, up to 32, starting with a letter or digit, a text title, and keywords that are text.`,
          );
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
    pages: {
      register: (page) => {
        if (!COMMAND_ID.test(page.name) || typeof page.title !== "string") {
          throw new TypeError(`"${page.name}" needs a valid name and a text title.`);
        }
        track(
          registerPluginPage(pluginPageKey(pluginId, page.name), {
            title: page.title,
            component: page.component,
            owner,
          }),
        );
      },
    },
    sidebar: {
      addSection: (section) => {
        if (!COMMAND_ID.test(section.id) || typeof section.title !== "string") {
          throw new TypeError(`"${section.id}" needs a valid id and a text title.`);
        }
        track(
          registerPluginSidebarSection({
            key: `${environmentId}\u0000${pluginId}\u0000${section.id}`,
            title: section.title,
            component: section.component,
            owner,
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
      // A failed fetch is asked again next time instead of failing for the plugin's lifetime.
      url.catch(() => {
        if (assetUrls.get(name) === url) assetUrls.delete(name);
      });
      return url;
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
      if (active()) navigate(path);
    },
    toast: (message) => {
      if (
        typeof message.title !== "string" ||
        (message.description !== undefined && typeof message.description !== "string") ||
        (message.type !== undefined && !TOAST_TYPES.has(message.type))
      ) {
        throw new TypeError("A toast needs a text title, text description and a known type.");
      }
      if (!active()) return;
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
  readonly cleanups: Set<() => void>;
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

const runCleanups = (cleanups: Iterable<() => void>) => {
  for (const cleanup of [...cleanups].toReversed()) {
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
  // Stays once set: the registries empty out as plugins unload, so their readers draw nothing.
  appAtomRegistry.set(pluginUiAtom, pluginUi);
  const shortcutHandlers: CommandHandlers = {};
  // Registered with the first plugin command, so key presses pay nothing until one exists.
  let stopShortcuts: (() => void) | undefined;
  const claimShortcutHandlers = () => {
    // A command registered after stop (a slow `activate`) must not add a scope nobody removes.
    if (!stopped) stopShortcuts ??= registerCommands(shortcutHandlers);
    return shortcutHandlers;
  };
  const loaded = new Map<PluginState["id"], LoadedPlugin>();
  let stopped = false;

  const unload = (pluginId: PluginState["id"]) => {
    const plugin = loaded.get(pluginId);
    if (plugin === undefined) return;
    loaded.delete(pluginId);
    plugin.disposed = true;
    runCleanups(plugin.cleanups);
  };

  const load = async (plugin: PluginState) => {
    const entry: LoadedPlugin = { key: loadKey(plugin), cleanups: new Set(), disposed: false };
    loaded.set(plugin.id, entry);
    // Cleared here rather than once `activate` resolves, so a part that throws while it awaits
    // keeps its note.
    setPluginWebFailure(environmentId, plugin.id, undefined);
    // Registrations that arrive after unload, from a slow `activate` or a later callback, are
    // undone at once instead of outliving the plugin.
    const track = (cleanup: () => void) => {
      if (entry.disposed) runCleanups([cleanup]);
      else entry.cleanups.add(cleanup);
      return () => {
        entry.cleanups.delete(cleanup);
      };
    };
    let downloaded = false;
    const download = () =>
      withDeadline(
        fetchPluginFile(environmentId, plugin, "/web.js", plugin.webRevision).then((response) =>
          response.text(),
        ),
        "Loading the web bundle",
      );
    try {
      const bundle = await withDownloadRetries(download, () => entry.disposed);
      if (bundle === undefined) return;
      downloaded = true;
      if (entry.disposed) return;
      // A bundle's top-level `await` can hang too.
      const definition = await withDeadline(importBundle(bundle), "Loading the web bundle");
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
              active: () => !stopped && !entry.disposed,
            }),
          ),
        ),
        "Starting the web half",
      );
    } catch (error) {
      // A load that was replaced or stopped meanwhile has nothing to report.
      if (entry.disposed) return;
      entry.disposed = true;
      runCleanups(entry.cleanups);
      entry.cleanups.clear();
      // A download that still fails after its retries is tried again on the next plugin update. A
      // bundle that downloaded and then failed stays in `loaded`, so it waits for the plugin to
      // restart instead of failing again on every change.
      if (!downloaded) loaded.delete(plugin.id);
      setPluginWebFailure(environmentId, plugin.id, errorText(error));
    }
  };

  const reconcile = (plugins: ReadonlyArray<PluginState>) => {
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
    // Not awaited, so a plugin that hangs until its deadline holds back neither the others nor
    // the next change, such as turning another plugin off.
    for (const plugin of wanted.values()) {
      if (!loaded.has(plugin.id)) void load(plugin);
    }
  };

  const stopFollowing = appAtomRegistry.subscribe(
    pluginEnvironment.pluginsLive({ environmentId, input: {} }),
    (result) => {
      if (!stopped && AsyncResult.isSuccess(result)) reconcile(result.value.plugins);
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
