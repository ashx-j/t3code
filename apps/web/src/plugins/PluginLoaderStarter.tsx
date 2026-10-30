import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerConfigAtom } from "../state/server";

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
  const supported =
    useAtomValue(primaryServerConfigAtom)?.environment.capabilities.plugins === true;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts and stops a runtime that lives outside React
  useEffect(() => {
    if (!supported || environmentId === null) return;
    let cancelled = false;
    let stopWatching: (() => void) | undefined;
    let stopLoader: (() => void) | undefined;
    const cancelIdle = whenIdle(() => {
      void loadPluginWatch().then(({ watchForWebPlugins }) => {
        if (cancelled) return;
        stopWatching = watchForWebPlugins(environmentId, () => {
          void loadPluginLoader().then((module) => {
            if (!cancelled) stopLoader = module.startPluginLoader(environmentId);
          });
        });
      });
    });
    return () => {
      cancelled = true;
      cancelIdle();
      stopWatching?.();
      stopLoader?.();
    };
  }, [supported, environmentId]);
  return null;
}
