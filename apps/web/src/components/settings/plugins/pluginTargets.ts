import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PluginState } from "@t3tools/contracts";

import { pluginUiEnvironmentsAtom } from "../../../plugins/pluginFollow";
import type { EnvironmentPresentation } from "../../../state/environments";

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
 * The environments this browser loads plugin UI from, those that run plugins. The first one also
 * supplies commands, and gets plugins that only change the app.
 */
export function usePluginUiSource() {
  const environmentIds = useAtomValue(pluginUiEnvironmentsAtom);
  return { environmentId: environmentIds[0] ?? null, environmentIds };
}
