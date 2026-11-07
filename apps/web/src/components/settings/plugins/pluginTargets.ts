import type { EnvironmentId, PluginState } from "@t3tools/contracts";

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

/** The environment this browser loads plugin styles from, and its name in the page's text. */
export function usePluginUiSource() {
  return { environmentId: usePrimaryEnvironmentId(), name: "your main environment" };
}
