import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PluginState } from "@t3tools/contracts";
import { ChevronUpIcon, RotateCwIcon, SlidersHorizontalIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import {
  pluginContributionKey,
  pluginSettingsPanelAtom,
  pluginWebFailuresAtom,
} from "../../../plugins/pluginRegistry";
import { pluginEnvironment } from "../../../state/plugins";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel } from "../../ui/collapsible";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Switch } from "../../ui/switch";
import { SettingsRow } from "../settingsLayout";
import { PluginSettingsRows } from "./PluginSettingsRows";
import { pluginSettingsForm } from "./pluginSettingsForm";

const FAILURE_STAGES = {
  discovery: "Not found",
  manifest: "Invalid manifest",
  compatibility: "Incompatible",
  load: "Failed to load",
  activate: "Failed to start",
  crash: "Stopped the server",
} as const;

export function PluginRow({
  environmentId,
  plugin,
  shadowed,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugin: PluginState;
  /** Another copy of this plugin is used instead, so the row only explains why. */
  readonly shadowed: boolean;
}) {
  const canManage = useAtomValue(pluginEnvironment.setPluginEnabled.permissionAtom(environmentId));
  const setEnabled = useAtomCommand(pluginEnvironment.setPluginEnabled, "plugin enabled");
  const reload = useAtomCommand(pluginEnvironment.reloadPlugin, "plugin reload");
  const uninstall = useAtomCommand(pluginEnvironment.uninstallPlugin, "plugin removal");
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const customSettings = useAtomValue(
    pluginSettingsPanelAtom(pluginContributionKey(environmentId, plugin.id)),
  );
  const webFailure = useAtomValue(pluginWebFailuresAtom(plugin.id)).get(environmentId);
  const hasGeneratedForm = pluginSettingsForm(plugin.settingsSchema).kind !== "none";
  const hasSettings = customSettings !== undefined || hasGeneratedForm;
  const whileBusy = async (action: () => Promise<unknown>) => {
    setBusy(true);
    await action();
    setBusy(false);
  };
  // A plugin loaded from its own folder through `devPaths` is unlinked instead; the folder stays.
  const removeLabel = plugin.source === "dev" ? "Unlink" : "Remove";
  // Only a shadowed link can be dropped on its own, by its folder; see `isShadowed`.
  const shadowedLink = shadowed && plugin.source === "dev" ? plugin.linkedFolder : undefined;
  const { failure, serverFailure } = plugin;
  const problems = [
    ...(failure === undefined
      ? []
      : [`${shadowed ? "Not used" : FAILURE_STAGES[failure.stage]}: ${failure.message}`]),
    ...(serverFailure === undefined
      ? []
      : [
          `Failed while running: ${serverFailure}`,
          // Turning a plugin off clears its failures on the server, so this one came after.
          ...(plugin.enabled
            ? []
            : ["Some of its code is still running. Restarting T3 Code stops it."]),
        ]),
    ...(webFailure === undefined ? [] : [`Web part failed: ${webFailure}`]),
  ];
  const row = (
    <SettingsRow
      title={plugin.name}
      description={
        <>
          {plugin.description}
          {plugin.permissions.length > 0 ? (
            <span className="block">
              Says it uses: {plugin.permissions.join(", ")}. T3 Code doesn't enforce this.
            </span>
          ) : null}
        </>
      }
      status={
        problems.length === 0 ? undefined : (
          <div className="flex flex-wrap items-center gap-2">
            {problems.map((problem) => (
              <span key={problem} className="text-destructive">
                {problem}
              </span>
            ))}
          </div>
        )
      }
      control={
        shadowed ? (
          shadowedLink !== undefined ? (
            <RemovePluginPopover
              name={plugin.name}
              unlink
              linkedFolder={shadowedLink}
              deletesData={false}
              disabled={busy || !canManage}
              onRemove={() =>
                whileBusy(() =>
                  uninstall({
                    environmentId,
                    input: { pluginId: plugin.id, linkedFolder: shadowedLink },
                  }),
                )
              }
            />
          ) : undefined
        ) : (
          <>
            {hasSettings ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Settings for ${plugin.name}`}
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen((open) => !open)}
              >
                {settingsOpen ? (
                  <ChevronUpIcon className="size-4" />
                ) : (
                  <SlidersHorizontalIcon className="size-4" />
                )}
              </Button>
            ) : null}
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy || !canManage}
              aria-label={`Reload ${plugin.name}`}
              onClick={() =>
                void whileBusy(() => reload({ environmentId, input: { pluginId: plugin.id } }))
              }
            >
              <RotateCwIcon className="size-4" />
            </Button>
            <RemovePluginPopover
              name={plugin.name}
              unlink={removeLabel === "Unlink"}
              linkedFolder={plugin.linkedFolder}
              deletesData
              disabled={busy || !canManage}
              onRemove={() =>
                whileBusy(() => uninstall({ environmentId, input: { pluginId: plugin.id } }))
              }
            />
            <Switch
              checked={plugin.enabled}
              disabled={busy || !canManage}
              aria-label={`Enable ${plugin.name}`}
              onCheckedChange={(enabled) =>
                void whileBusy(() =>
                  setEnabled({ environmentId, input: { pluginId: plugin.id, enabled } }),
                )
              }
            />
          </>
        )
      }
    />
  );
  if (shadowed || !hasSettings) return row;
  return (
    <>
      {row}
      {/* `contents`, so the card's line between rows falls inside the panel and slides in with it. */}
      <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen} className="contents">
        <CollapsiblePanel>
          <div className="border-t border-border/50 [&>*+*]:border-t [&>*+*]:border-border/50">
            <PluginSettingsRows
              environmentId={environmentId}
              plugin={plugin}
              customSettings={customSettings}
            />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </>
  );
}

/** The remove button and the popup that confirms it, or Unlink for a plugin loaded from a folder. */
function RemovePluginPopover({
  name,
  unlink,
  linkedFolder,
  deletesData,
  disabled,
  onRemove,
}: {
  readonly name: string;
  readonly unlink: boolean;
  readonly linkedFolder: string | undefined;
  /** False for a link that isn't in use: the copy in use keeps the data. */
  readonly deletesData: boolean;
  readonly disabled: boolean;
  readonly onRemove: () => Promise<unknown>;
}) {
  const label = unlink ? "Unlink" : "Remove";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={disabled}
            aria-label={`${label} ${name}`}
          />
        }
      >
        <Trash2Icon className="size-4" />
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" width="md">
        <div className="flex flex-col gap-3">
          {unlink && linkedFolder !== undefined ? (
            <p className="text-muted-foreground text-xs">
              Stops loading <span className="break-all font-mono">{linkedFolder}</span>. The folder
              stays.
            </p>
          ) : null}
          {deletesData ? (
            <p className="text-muted-foreground text-xs">
              This also deletes its settings, secrets and stored data, and can't be undone.
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <PopoverClose render={<Button size="sm" variant="ghost" disabled={disabled} />}>
              Cancel
            </PopoverClose>
            <Button
              size="sm"
              variant="destructive"
              disabled={disabled}
              onClick={() => void onRemove()}
            >
              {label} {name}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
