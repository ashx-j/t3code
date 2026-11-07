import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { type ReactNode, useContext, useEffect, useState } from "react";

import { pluginEnvironment } from "../../../state/plugins";
import { formatEnvironmentQueryError } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { LeftoverPluginData } from "./LeftoverPluginData";
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

const fromGitOrNpm = (copy: PluginCopy) =>
  copy.plugin.installSource !== undefined && copy.plugin.installSource.type !== "path";

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
  const updatable = copies.filter(fromGitOrNpm);
  const agentTools = loaded.flatMap(({ target }, index) => {
    const value = AsyncResult.getOrElse(
      lists[index] ?? AsyncResult.initial(true),
      () => null,
    )?.agentTools;
    // Servers from before the switch leave it out.
    return value === undefined ? [] : [{ environmentId: target.environmentId, value }];
  });
  return (
    <>
      <SettingsSection title="Plugins">
        {children}
        {agentTools.length === 0 ? null : (
          <AgentToolsRow environmentId={main.environmentId} environments={agentTools} />
        )}
        {updatable.length === 0 ? null : (
          <CheckPluginUpdates environmentId={main.environmentId} copies={updatable} />
        )}
      </SettingsSection>
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
      <LeftoverPluginData targets={targets} installed={copies} labelled={several} />
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

/** Checks plugins installed from git or npm now; the server also checks once a day. */
function CheckPluginUpdates({
  environmentId,
  copies,
}: {
  readonly environmentId: EnvironmentId;
  /** Plugins installed from git or npm. */
  readonly copies: ReadonlyArray<PluginCopy>;
}) {
  const canCheck = useAtomValue(pluginEnvironment.checkPluginUpdates.permissionAtom(environmentId));
  const canUpdate = useAtomValue(pluginEnvironment.updatePlugin.permissionAtom(environmentId));
  const check = useAtomCommand(pluginEnvironment.checkPluginUpdates, "plugin update check");
  const update = useAtomCommand(pluginEnvironment.updatePlugin, "plugin update");
  const [busy, setBusy] = useState<"checking" | "updating" | null>(null);
  const [checked, setChecked] = useState(false);
  const outdated = copies.filter((copy) => copy.plugin.availableUpdate !== undefined);
  const updates = new Set(outdated.map((copy) => copy.plugin.id)).size;
  return (
    <SettingsRow
      title="Updates"
      description={
        updates > 0
          ? `${updates === 1 ? "1 plugin has" : `${updates} plugins have`} an update.`
          : checked
            ? "Plugins from git or npm are up to date."
            : "Plugins from git or npm are checked once a day."
      }
      control={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || !canCheck}
            onClick={async () => {
              setBusy("checking");
              const results = await Promise.all(
                [...new Set(copies.map((copy) => copy.environmentId))].map((target) =>
                  check({ environmentId: target, input: {} }),
                ),
              );
              setBusy(null);
              setChecked(results.every((result) => result._tag === "Success"));
            }}
          >
            {busy === "checking" ? "Checking…" : "Check for updates"}
          </Button>
          {updates > 0 ? (
            <Button
              size="sm"
              disabled={busy !== null || !canUpdate}
              onClick={async () => {
                setBusy("updating");
                await Promise.all(
                  outdated.map((copy) =>
                    update({
                      environmentId: copy.environmentId,
                      input: { pluginId: copy.plugin.id },
                    }),
                  ),
                );
                setBusy(null);
              }}
            >
              {busy === "updating" ? "Updating…" : "Update all"}
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

/** Whether agents get the tools that list, install, check and change plugins. Off by default. */
function AgentToolsRow(props: {
  readonly environmentId: EnvironmentId;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly value: boolean;
  }>;
}) {
  const canChange = useAtomValue(
    pluginEnvironment.setAgentTools.permissionAtom(props.environmentId),
  );
  const setAgentTools = useAtomCommand(pluginEnvironment.setAgentTools, "plugin tools for agents");
  const [busy, setBusy] = useState(false);
  return (
    <SettingsRow
      title="Plugin tools for agents"
      description="Lets agents manage plugins. Changes need a thread in Full access."
      control={
        <Switch
          checked={props.environments.every((environment) => environment.value)}
          disabled={busy || !canChange}
          aria-label="Plugin tools for agents"
          onCheckedChange={(enabled) => {
            setBusy(true);
            void Promise.all(
              props.environments.map((environment) =>
                setAgentTools({ environmentId: environment.environmentId, input: { enabled } }),
              ),
            ).finally(() => setBusy(false));
          }}
        />
      }
    />
  );
}
