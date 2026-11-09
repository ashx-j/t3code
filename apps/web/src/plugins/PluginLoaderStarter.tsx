import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { pluginUiEnvironmentsAtom } from "./pluginFollow";

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
 * Follows the plugins of each environment this browser loads plugin UI from, the main one unless
 * the user turned it off.
 */
export function PluginLoaderStarter() {
  const environmentIds = useAtomValue(pluginUiEnvironmentsAtom);
  return environmentIds.map((environmentId) => (
    <PluginEnvironmentLoader key={environmentId} environmentId={environmentId} />
  ));
}

/**
 * Once the app is idle, downloads the small stylesheet runtime only when an active plugin of the
 * environment has a `styles` folder.
 */
function PluginEnvironmentLoader({ environmentId }: { readonly environmentId: EnvironmentId }) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts and stops a runtime that lives outside React
  useEffect(() => {
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
  }, [environmentId]);
  return null;
}
