import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PluginState } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { usePrimaryEnvironmentId } from "../state/environments";
import { pluginEnvironment } from "../state/plugins";
import { useAtomCommand } from "../state/use-atom-command";
import { followedPluginEnvironmentAtom } from "./pluginFollow";

export type PluginUpdateOutcome =
  | { readonly environmentId: EnvironmentId; readonly status: "updated" }
  | { readonly environmentId: EnvironmentId; readonly status: "failed"; readonly line: string };

const NO_UPDATES = Atom.make<ReadonlyArray<PluginState>>([]);
const NO_PERMISSION = Atom.make(false);

const updatablePluginsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    (
      AsyncResult.getOrElse(
        get(pluginEnvironment.pluginsLive({ environmentId, input: {} })),
        () => null,
      )?.plugins ?? []
    ).filter((plugin) => plugin.availableUpdate !== undefined),
  ).pipe(Atom.withLabel(`web-plugin-updates:${environmentId}`)),
);

/**
 * Plugin updates for the global update button. Only the main environment's, read once the plugin
 * starter follows its list after startup, so this opens no stream of its own.
 */
export function usePluginUpdates(labelOf: (environmentId: EnvironmentId) => string) {
  const environmentId = usePrimaryEnvironmentId();
  const followed = useAtomValue(followedPluginEnvironmentAtom);
  const follows = environmentId !== null && followed === environmentId;
  const plugins = useAtomValue(follows ? updatablePluginsAtom(environmentId) : NO_UPDATES);
  const canUpdate = useAtomValue(
    follows ? pluginEnvironment.updatePlugin.permissionAtom(environmentId) : NO_PERMISSION,
  );
  const update = useAtomCommand(pluginEnvironment.updatePlugin, {
    label: "plugin update",
    reportFailure: false,
  });
  const machines =
    environmentId === null || !canUpdate || plugins.length === 0
      ? []
      : [{ environmentId, label: labelOf(environmentId), plugins }];

  const updateAll = () =>
    Promise.all(
      machines.flatMap(({ environmentId, plugins }) =>
        plugins.map(async (plugin): Promise<PluginUpdateOutcome> => {
          const result = await update({ environmentId, input: { pluginId: plugin.id } });
          if (result._tag === "Success") return { environmentId, status: "updated" };
          const error = squashAtomCommandFailure(result);
          const message = error instanceof Error ? error.message : "Could not update it.";
          return { environmentId, status: "failed", line: `${plugin.name}: ${message}` };
        }),
      ),
    );

  return { machines, updateAll };
}
