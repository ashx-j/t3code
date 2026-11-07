import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PluginState } from "@t3tools/contracts";

import { chosenPluginUiEnvironmentAtom } from "../../../plugins/pluginFollow";
import { type EnvironmentPresentation, usePrimaryEnvironmentId } from "../../../state/environments";

export interface PluginTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** A plugin as one environment in view has it. */
export interface PluginCopy extends PluginTarget {
  readonly plugin: PluginState;
}

export const runsPlugins = (environment: EnvironmentPresentation) =>
  environment.connection.phase === "connected" &&
  environment.serverConfig?.environment.capabilities.plugins === true;

/**
 * The environment this browser loads plugin UI from, and its name in the page's text: the main
 * environment, else the one picked under "Load plugin UI from".
 */
export function usePluginUiSource() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const chosenEnvironmentId = useAtomValue(chosenPluginUiEnvironmentAtom);
  return {
    environmentId: primaryEnvironmentId ?? chosenEnvironmentId,
    name:
      primaryEnvironmentId === null
        ? "the environment you load plugin UI from"
        : "your main environment",
  };
}
