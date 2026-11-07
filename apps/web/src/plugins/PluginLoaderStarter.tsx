import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerConfigAtom } from "../state/server";
import { chosenPluginUiEnvironmentAtom, followedPluginEnvironmentAtom } from "./pluginFollow";

// A new or reloaded window has no plugin commands yet, while the desktop main process still holds
// the last page's menu items. Plugins that load send theirs again.
if (typeof window !== "undefined") {
  void window.desktopBridge?.setPluginCommands([]).catch(() => undefined);
}

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
 * downloads the web plugin runtime only when an active plugin has a web part. Without a primary
 * environment it does the same for the one the user picked in Settings, and nothing until then.
 */
export function PluginLoaderStarter() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const chosenEnvironmentId = useAtomValue(chosenPluginUiEnvironmentAtom);
  const chosen = useEnvironment(primaryEnvironmentId === null ? chosenEnvironmentId : null);
  const router = useRouter();
  const primarySupported =
    useAtomValue(primaryServerConfigAtom)?.environment.capabilities.plugins === true;
  const environmentId = primaryEnvironmentId ?? chosen?.environmentId ?? null;
  const supported =
    primaryEnvironmentId === null
      ? chosen?.serverConfig?.environment.capabilities.plugins === true
      : primarySupported;
  const setFollowed = useAtomSet(followedPluginEnvironmentAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts and stops a runtime that lives outside React
  useEffect(() => {
    if (!supported || environmentId === null) return;
    let cancelled = false;
    let stopWatching: (() => void) | undefined;
    let stopLoader: (() => void) | undefined;
    const cancelIdle = whenIdle(() => {
      setFollowed(environmentId);
      void loadPluginWatch().then(({ watchForWebPlugins }) => {
        if (cancelled) return;
        stopWatching = watchForWebPlugins(environmentId, () => {
          void loadPluginLoader().then((module) => {
            if (cancelled) return;
            stopLoader = module.startPluginLoader(environmentId, (path) =>
              router.history.push(path),
            );
          });
        });
      });
    });
    return () => {
      cancelled = true;
      cancelIdle();
      setFollowed(null);
      stopWatching?.();
      stopLoader?.();
    };
  }, [supported, environmentId, router, setFollowed]);
  return null;
}
