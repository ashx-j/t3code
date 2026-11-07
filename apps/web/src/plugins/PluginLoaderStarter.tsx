import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerConfigAtom } from "../state/server";

// Module level: React Compiler cannot compile a component that calls import() itself.
const loadPluginWatch = () => import("./pluginWatch");
const loadPluginStyles = () => import("./pluginStyles");

const whenIdle = (run: () => void) => {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(run);
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(run, 1);
  return () => window.clearTimeout(handle);
};

/**
 * Once the app is idle, follows the primary environment's plugins if it advertises them. It
 * downloads the small stylesheet runtime only when an active plugin has a `styles` folder.
 */
export function PluginLoaderStarter() {
  const environmentId = usePrimaryEnvironmentId();
  const supported =
    useAtomValue(primaryServerConfigAtom)?.environment.capabilities.plugins === true;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts and stops a runtime that lives outside React
  useEffect(() => {
    if (!supported || environmentId === null) return;
    let cancelled = false;
    const stops: Array<() => void> = [];
    const cancelIdle = whenIdle(() => {
      void loadPluginWatch().then(({ watchForPlugins, hasLoadableStyles }) => {
        if (cancelled) return;
        stops.push(
          watchForPlugins(environmentId, hasLoadableStyles, () => {
            void loadPluginStyles().then((module) => {
              if (cancelled) return;
              stops.push(module.startPluginStyles(environmentId));
            });
          }),
        );
      });
    });
    return () => {
      cancelled = true;
      cancelIdle();
      for (const stop of stops) stop();
    };
  }, [supported, environmentId]);
  return null;
}
