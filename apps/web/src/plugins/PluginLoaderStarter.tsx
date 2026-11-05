import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerConfigAtom } from "../state/server";
import { followedPluginEnvironmentAtom } from "./pluginFollow";

// The desktop main process outlives the page and keeps the last page's menu items, tray icon and
// global shortcuts. The loader replaces them once its first plugins have loaded; with no web
// plugins to load, they are cleared here, once.
let desktopCommandsSettled = false;
const clearDesktopPluginCommands = () => {
  if (desktopCommandsSettled || typeof window === "undefined") return;
  desktopCommandsSettled = true;
  void window.desktopBridge?.setPluginCommands([]).catch(() => undefined);
};

// Module level: React Compiler cannot compile a component that calls import() itself.
const loadPluginWatch = () => import("./pluginWatch");
const loadPluginLoader = () => import("./pluginLoader");

const whenIdle = (run: () => void) => {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(run);
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(run, 1);
  return () => window.clearTimeout(handle);
};

/**
 * Once the app is idle, follows the primary environment's plugins if it advertises them, and
 * downloads the web plugin runtime only when an active plugin has a web part.
 */
export function PluginLoaderStarter() {
  const environmentId = usePrimaryEnvironmentId();
  const router = useRouter();
  const config = useAtomValue(primaryServerConfigAtom);
  const configKnown = config !== null && config !== undefined;
  const supported = config?.environment.capabilities.plugins === true;
  const setFollowed = useAtomSet(followedPluginEnvironmentAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts and stops a runtime that lives outside React
  useEffect(() => {
    if (!supported || environmentId === null) {
      if (configKnown) clearDesktopPluginCommands();
      return;
    }
    let cancelled = false;
    let stopWatching: (() => void) | undefined;
    let stopLoader: (() => void) | undefined;
    const cancelIdle = whenIdle(() => {
      setFollowed(environmentId);
      void loadPluginWatch().then(({ watchForWebPlugins }) => {
        if (cancelled) return;
        stopWatching = watchForWebPlugins(
          environmentId,
          () => {
            desktopCommandsSettled = true;
            void loadPluginLoader().then((module) => {
              if (cancelled) return;
              stopLoader = module.startPluginLoader(environmentId, (path) =>
                router.history.push(path),
              );
            });
          },
          clearDesktopPluginCommands,
        );
      });
    });
    return () => {
      cancelled = true;
      cancelIdle();
      setFollowed(null);
      stopWatching?.();
      stopLoader?.();
    };
  }, [supported, environmentId, router, configKnown, setFollowed]);
  return null;
}
