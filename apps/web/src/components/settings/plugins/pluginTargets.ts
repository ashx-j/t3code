import type { EnvironmentId, PluginInstallSource, PluginState } from "@t3tools/contracts";

export interface PluginTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** A plugin as one environment in view has it. */
export interface PluginCopy extends PluginTarget {
  readonly plugin: PluginState;
}

/** A git commit is shown short, an npm version as it is. */
export const updateLabel = (version: string) =>
  /^[0-9a-f]{40,64}$/.test(version) ? version.slice(0, 7) : version;

export const installSourceLabel = (source: PluginInstallSource) =>
  source.type === "path" ? source.path : source.type === "git" ? source.url : `npm ${source.name}`;
