import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { type ReactNode, useContext, useEffect } from "react";

import { pluginEnvironment } from "../../../state/plugins";
import { formatEnvironmentQueryError } from "../../../state/query";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { PluginRow } from "./PluginRow";
import { type PluginCopy, type PluginTarget, usePluginUiSource } from "./pluginTargets";

// Keyed by the JSON list of environment ids, so one value holds every environment's plugins.
const pluginListsAtom = Atom.family((environmentIdsKey: string) => {
  const environmentIds = JSON.parse(environmentIdsKey) as ReadonlyArray<EnvironmentId>;
  return Atom.make((get) =>
    environmentIds.map((environmentId) =>
      get(pluginEnvironment.pluginsLive({ environmentId, input: {} })),
    ),
  ).pipe(Atom.withLabel(`web-plugin-lists:${environmentIdsKey}`));
});

/**
 * Copies of a plugin on different environments share a row. A copy that failed discovery keeps its
 * own. One that another copy with its id shadows is `shadowed`: actions send only the id, so they
 * would reach the copy that is used instead.
 */
function pluginRows(copies: ReadonlyArray<PluginCopy>) {
  const rows = new Map<
    string,
    { readonly first: PluginCopy; readonly copies: Array<PluginCopy>; readonly shadowed: boolean }
  >();
  copies.forEach((copy, index) => {
    const failedDiscovery = copy.plugin.failure?.stage === "discovery";
    const key = failedDiscovery
      ? `${copy.environmentId}:${index}`
      : `${copy.plugin.id}:${copy.plugin.source}`;
    const shadowed =
      failedDiscovery &&
      copies.some(
        (other) =>
          other !== copy &&
          other.environmentId === copy.environmentId &&
          other.plugin.id === copy.plugin.id,
      );
    const row = rows.get(key);
    if (row === undefined) rows.set(key, { first: copy, copies: [copy], shadowed });
    else row.copies.push(copy);
  });
  return Array.from(rows, ([key, row]) => ({ key, ...row }));
}

/**
 * The page's own settings, with `children` first, then each plugin once, however many of `targets`
 * have it. Actions on a row apply to every copy. `main` comes first in `targets` and decides which
 * actions are offered.
 */
export function PluginList({
  main,
  targets,
  children,
}: {
  readonly main: PluginTarget;
  readonly targets: ReadonlyArray<PluginTarget>;
  readonly children: ReactNode;
}) {
  const lists = useAtomValue(
    pluginListsAtom(JSON.stringify(targets.map((target) => target.environmentId))),
  );
  const several = targets.length > 1;
  const uiSource = usePluginUiSource();
  const remoteInView = targets.some((target) => target.environmentId !== uiSource.environmentId);
  const loaded = targets.map((target, index) => {
    const result = lists[index] ?? AsyncResult.initial(true);
    return {
      target,
      plugins: AsyncResult.getOrElse(result, () => null)?.plugins ?? null,
      error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    };
  });
  const copies = loaded.flatMap(({ target, plugins }) =>
    (plugins ?? []).map((plugin): PluginCopy => ({ ...target, plugin })),
  );
  const rows = pluginRows(copies);
  const errors = loaded.flatMap(({ target, error }) =>
    error === null ? [] : [several ? `${target.label}: ${error}` : error],
  );
  return (
    <>
      <SettingsSection title="Plugins">{children}</SettingsSection>
      {targets.map((target) => (
        <ScanPluginsFolder key={target.environmentId} environmentId={target.environmentId} />
      ))}
      <SettingsSection title="Installed plugins">
        {errors.map((error) => (
          <SettingsRow key={error} title="Could not load plugins" description={error} />
        ))}
        {loaded.every(({ plugins, error }) => plugins === null && error === null) ? (
          <SettingsRow title="Loading plugins…" role="status" />
        ) : rows.length === 0 && errors.length === 0 ? (
          <SettingsRow
            title="No plugins installed"
            description="Drop a plugin folder here to add it."
          />
        ) : (
          rows.map((row) => (
            <PluginRow
              key={row.key}
              environmentId={main.environmentId}
              first={row.first}
              copies={row.copies}
              shadowed={row.shadowed}
              labelled={several}
              uiSourceName={remoteInView ? uiSource.name : null}
            />
          ))
        )}
      </SettingsSection>
    </>
  );
}

/** Has the server look at its plugins folder again, so folders copied there by hand are listed. */
function ScanPluginsFolder({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const canRescan = useAtomValue(pluginEnvironment.rescanPlugins.permissionAtom(environmentId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The server reads its plugins folder only when asked, so opening the page asks it.
  useEffect(() => {
    if (!canRescan) return;
    void runAtomCommand(
      registry,
      pluginEnvironment.rescanPlugins,
      { environmentId, input: {} },
      { label: "plugin folder scan", reportFailure: false, reportDefect: false },
    );
  }, [registry, environmentId, canRescan]);
  return null;
}
