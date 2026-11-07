import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { BlocksIcon } from "lucide-react";
import { type DragEvent, useState } from "react";

import { cn } from "../../../lib/utils";
import { droppedFolders } from "../../../plugins/pluginFolders";
import type { EnvironmentPresentation } from "../../../state/environments";
import { pluginEnvironment } from "../../../state/plugins";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../../ui/empty";
import { useSettingsScope } from "../SettingsScopeContext";
import { settingsScopeEnvironmentLabel } from "../settingsScopeAxis";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settingsLayout";
import {
  AddPluginButton,
  AddPluginDialog,
  InstallProblems,
  usePluginInstaller,
} from "./PluginInstallControls";
import { PluginList } from "./PluginList";
import { type PluginTarget, runsPlugins, usePluginUiSource } from "./pluginTargets";

export function PluginsSettings() {
  const { scope, environment, environments } = useSettingsScope();
  const uiSource = usePluginUiSource();
  if (scope.kind === "unavailable") {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Plugins">
          <SettingsRow title={scope.message} />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  // The environment plugin styles load from comes first: installs start there, see
  // `usePluginInstaller`.
  const shown =
    scope.kind === "all"
      ? environments.toSorted(
          (a, b) =>
            Number(b.environmentId === uiSource.environmentId) -
            Number(a.environmentId === uiSource.environmentId),
        )
      : environment === null
        ? []
        : [environment];
  if (shown.length === 0) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Plugins" variant="plain">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BlocksIcon />
              </EmptyMedia>
              <EmptyTitle>No environment selected</EmptyTitle>
              <EmptyDescription>Connect an environment to manage its plugins.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return <PluginsPage environments={shown} />;
}

const NO_INSTALL_PERMISSION = Atom.make(false);

/** Lists the plugins in view. Plugin folders dropped anywhere on it are installed. */
function PluginsPage({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  // Labels tell apart environments with the same name, as the scope picker does.
  const labelOf = (environment: EnvironmentPresentation) =>
    settingsScopeEnvironmentLabel(environment, environments);
  const targets = environments.filter(runsPlugins).map((environment): PluginTarget => ({
    environmentId: environment.environmentId,
    label: labelOf(environment),
  }));
  const uiSource = usePluginUiSource();
  const installer = usePluginInstaller(targets, uiSource);
  const [adding, setAdding] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [main] = targets;
  const canInstall = useAtomValue(
    main === undefined
      ? NO_INSTALL_PERMISSION
      : pluginEnvironment.installPluginFiles.permissionAtom(main.environmentId),
  );
  const isFileDrag = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  return (
    <SettingsPageContainer>
      {/* Drops on the Add plugin dialog land here too: React bubbles events out of portals. */}
      <div
        className={cn(
          "-m-3 flex flex-col gap-8 rounded-xl p-3",
          dragActive &&
            "bg-primary/5 outline-2 -outline-offset-2 outline-primary/60 outline-dashed",
        )}
        onDragEnter={(event) => {
          if (!isFileDrag(event)) return;
          event.preventDefault();
          setDragActive(canInstall);
        }}
        onDragOver={(event) => {
          if (!isFileDrag(event)) return;
          // Taken even without permission, so the browser doesn't open the folder instead.
          event.preventDefault();
          event.dataTransfer.dropEffect = canInstall ? "copy" : "none";
          setDragActive(canInstall);
        }}
        onDragLeave={(event) => {
          if (!isFileDrag(event)) return;
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          ) {
            return;
          }
          setDragActive(false);
        }}
        onDrop={(event) => {
          if (!isFileDrag(event)) return;
          event.preventDefault();
          setDragActive(false);
          if (!canInstall) return;
          void installer
            .installFolders(droppedFolders(event.dataTransfer))
            .then((installed) => installed && setAdding(false));
        }}
      >
        {main === undefined ? (
          <SettingsSection title="Plugins">
            <PluginsUnavailable environments={environments} />
          </SettingsSection>
        ) : (
          <PluginList main={main} targets={targets}>
            <SettingsRow
              title="Add a plugin"
              description={
                installer.installing === null
                  ? "Drop a plugin folder here or use Add plugin. Install only plugins you trust."
                  : `Installing ${installer.installing}…`
              }
              control={
                <AddPluginButton
                  environmentId={main.environmentId}
                  disabled={installer.installing !== null}
                  onClick={() => {
                    installer.clearProblems();
                    setAdding(true);
                  }}
                />
              }
            >
              <InstallProblems problems={installer.problems} />
            </SettingsRow>
          </PluginList>
        )}
        {main === undefined ? null : (
          <AddPluginDialog
            open={adding}
            onOpenChange={setAdding}
            installer={installer}
            dragActive={dragActive}
            scopeNote={
              main.environmentId !== uiSource.environmentId
                ? `Installs on ${targets.length > 1 ? "every environment here that runs plugins" : main.label}. ${main.label} isn't ${uiSource.name}, and the app shows plugin changes only from that one, so a plugin with no server code does nothing here.`
                : targets.length > 1
                  ? `Installs on every environment that runs plugins. A plugin with no server code only changes the app, so it goes to ${main.label} only.`
                  : `Installs on ${main.label}.`
            }
          />
        )}
      </div>
    </SettingsPageContainer>
  );
}

function PluginsUnavailable({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const [only, ...others] = environments;
  if (only === undefined || others.length > 0) {
    return (
      <SettingsRow
        title="Plugins are not available"
        description="None of these environments runs a T3 Code server with plugin support."
      />
    );
  }
  if (only.connection.phase !== "connected" || only.serverConfig === null) {
    return (
      <SettingsRow
        title="Environment disconnected"
        description={`Reconnect ${only.label} to manage its plugins.`}
      />
    );
  }
  return (
    <SettingsRow
      title="Plugins are not available"
      description={`${only.label} runs a T3 Code server without plugin support.`}
    />
  );
}
