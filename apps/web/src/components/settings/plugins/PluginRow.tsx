import { useAtomValue } from "@effect/atom-react";
import { pluginSettingsForm } from "@t3tools/client-runtime/plugins/settings-form";
import type { EnvironmentId, PluginState } from "@t3tools/contracts";
import {
  ChevronUpIcon,
  InfoIcon,
  RotateCwIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import { useId, useState } from "react";

import {
  pluginContributionKey,
  pluginSettingsPanelAtom,
  pluginWebFailureAtom,
} from "../../../plugins/pluginRegistry";
import { pluginEnvironment } from "../../../state/plugins";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Collapsible, CollapsiblePanel } from "../../ui/collapsible";
import { Label } from "../../ui/label";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Switch } from "../../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { SettingsRow } from "../settingsLayout";
import { PluginSettingsRows } from "./PluginSettingsRows";
import type { PluginCopy } from "./pluginTargets";

const FAILURE_STAGES = {
  discovery: "Not found",
  manifest: "Invalid manifest",
  compatibility: "Incompatible",
  load: "Failed to load",
  activate: "Failed to start",
} as const;

/**
 * Where a plugin that changes the app runs, as the installer decides: with no server code it goes
 * only to the environment plugin UI loads from, named by `source`.
 */
const webReach = (plugin: PluginState, source: string) =>
  !plugin.hasServer
    ? `Changes only this app. It runs from ${source} and isn't installed on other servers.`
    : plugin.hasWeb
      ? `Its web part runs in this app from ${source} only. Other servers get just its server side.`
      : null;

export function PluginRow({
  environmentId,
  first,
  copies,
  shadowed,
  labelled,
  uiSourceName,
}: {
  /** The main environment in view. Its permissions decide which actions are offered. */
  readonly environmentId: EnvironmentId;
  readonly first: PluginCopy;
  readonly copies: ReadonlyArray<PluginCopy>;
  /** Another copy of this plugin is used instead, so the row only explains why. */
  readonly shadowed: boolean;
  /** Problems name their environment, because several are in view. */
  readonly labelled: boolean;
  /**
   * How the page names the environment plugin UI loads from, set while another server is in view
   * so the row says where app changes run.
   */
  readonly uiSourceName: string | null;
}) {
  const { plugin } = first;
  const canManage = useAtomValue(pluginEnvironment.setPluginEnabled.permissionAtom(environmentId));
  const setEnabled = useAtomCommand(pluginEnvironment.setPluginEnabled, "plugin enabled");
  const reload = useAtomCommand(pluginEnvironment.reloadPlugin, "plugin reload");
  const uninstall = useAtomCommand(pluginEnvironment.uninstallPlugin, "plugin removal");
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Plugin UI loads from one environment, which comes first, so its settings panel and web failure
  // do too.
  const contributionKey = pluginContributionKey(environmentId, plugin.id);
  const customSettings = useAtomValue(pluginSettingsPanelAtom(contributionKey));
  const webFailure = useAtomValue(pluginWebFailureAtom(contributionKey));
  const hasGeneratedForm = pluginSettingsForm(plugin.settingsSchema).kind !== "none";
  const hasSettings = customSettings !== undefined || hasGeneratedForm;
  const runOn = async (
    on: ReadonlyArray<PluginCopy>,
    action: (copy: PluginCopy) => Promise<unknown>,
  ) => {
    setBusy(true);
    await Promise.all(on.map(action));
    setBusy(false);
  };
  // A plugin loaded from its own folder is unlinked instead; the folder stays.
  const removeLabel = copies.every((copy) => copy.plugin.source === "dev") ? "Unlink" : "Remove";
  // Only a shadowed link can be dropped on its own, by its folder; see `pluginRows`.
  const shadowedLink = shadowed && plugin.source === "dev" ? plugin.linkedFolder : undefined;
  const problems = [
    ...copies.flatMap(({ label, plugin: { failure } }) =>
      failure === undefined
        ? []
        : [
            `${labelled ? `${label}: ` : ""}${shadowed ? "Not used" : FAILURE_STAGES[failure.stage]}: ${failure.message}`,
          ],
    ),
    ...copies.flatMap(({ label, plugin: { serverFailure } }) =>
      serverFailure === undefined
        ? []
        : [`${labelled ? `${label}: ` : ""}Failed while running: ${serverFailure}`],
    ),
    ...(webFailure === undefined ? [] : [`Web part failed: ${webFailure}`]),
  ];
  const reach = uiSourceName === null ? null : webReach(plugin, uiSourceName);
  const row = (
    <SettingsRow
      title={
        reach === null ? (
          plugin.name
        ) : (
          <span className="inline-flex items-center gap-1">
            {plugin.name}
            <Tooltip>
              <TooltipTrigger
                delay={200}
                render={
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label={`Where ${plugin.name} runs`}
                  >
                    <InfoIcon className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup side="top">{reach}</TooltipPopup>
            </Tooltip>
          </span>
        )
      }
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
              offerDataRemoval={false}
              disabled={busy || !canManage}
              onRemove={() =>
                runOn([first], (copy) =>
                  uninstall({
                    environmentId: copy.environmentId,
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
                void runOn(copies, (copy) =>
                  reload({ environmentId: copy.environmentId, input: { pluginId: plugin.id } }),
                )
              }
            >
              <RotateCwIcon className="size-4" />
            </Button>
            <RemovePluginPopover
              name={plugin.name}
              unlink={removeLabel === "Unlink"}
              linkedFolder={plugin.linkedFolder}
              offerDataRemoval
              disabled={busy || !canManage}
              onRemove={(removeData) =>
                runOn(copies, (copy) =>
                  uninstall({
                    environmentId: copy.environmentId,
                    input: { pluginId: plugin.id, removeData },
                  }),
                )
              }
            />
            <Switch
              checked={copies.every((copy) => copy.plugin.enabled)}
              disabled={busy || !canManage}
              aria-label={`Enable ${plugin.name}`}
              onCheckedChange={(enabled) =>
                void runOn(copies, (copy) =>
                  setEnabled({
                    environmentId: copy.environmentId,
                    input: { pluginId: plugin.id, enabled },
                  }),
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
              first={first}
              copies={copies}
              labelled={labelled}
              customSettings={customSettings}
              hasGeneratedForm={hasGeneratedForm}
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
  offerDataRemoval,
  disabled,
  onRemove,
}: {
  readonly name: string;
  readonly unlink: boolean;
  readonly linkedFolder: string | undefined;
  readonly offerDataRemoval: boolean;
  readonly disabled: boolean;
  readonly onRemove: (removeData: boolean) => Promise<unknown>;
}) {
  const [removeData, setRemoveData] = useState(false);
  const checkboxId = useId();
  const label = unlink ? "Unlink" : "Remove";
  return (
    // Each opening starts unticked, so a cancelled choice to delete data can't carry over.
    <Popover onOpenChange={(open) => open && setRemoveData(false)}>
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
          {offerDataRemoval ? (
            <div className="flex items-center gap-2">
              <Checkbox
                id={checkboxId}
                checked={removeData}
                onCheckedChange={(checked) => setRemoveData(checked === true)}
              />
              <Label htmlFor={checkboxId}>Also delete its settings and stored data</Label>
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <PopoverClose render={<Button size="sm" variant="ghost" disabled={disabled} />}>
              Cancel
            </PopoverClose>
            <Button
              size="sm"
              variant="destructive"
              disabled={disabled}
              onClick={() => void onRemove(removeData)}
            >
              {label} {name}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
