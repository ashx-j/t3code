import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PluginState } from "@t3tools/contracts";
import { RotateCwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { pluginWebFailuresAtom } from "../../../plugins/pluginRegistry";
import { pluginEnvironment } from "../../../state/plugins";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Switch } from "../../ui/switch";
import { SettingsRow } from "../settingsLayout";

const FAILURE_STAGES = {
  discovery: "Not found",
  duplicate: "Duplicate id",
  manifest: "Invalid manifest",
  compatibility: "Incompatible",
} as const;

export function PluginRow({
  environmentId,
  plugin,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugin: PluginState;
}) {
  const canManage = useAtomValue(pluginEnvironment.setPluginEnabled.permissionAtom(environmentId));
  const setEnabled = useAtomCommand(pluginEnvironment.setPluginEnabled, "plugin enabled");
  const reload = useAtomCommand(pluginEnvironment.reloadPlugin, "plugin reload");
  const uninstall = useAtomCommand(pluginEnvironment.uninstallPlugin, "plugin removal");
  const [busy, setBusy] = useState(false);
  const webFailure = useAtomValue(pluginWebFailuresAtom(plugin.id)).get(environmentId);
  const whileBusy = async (action: () => Promise<unknown>) => {
    setBusy(true);
    await action();
    setBusy(false);
  };
  const unlink = plugin.source === "dev";
  // Other actions send only the id, which names the copy in use.
  const duplicate = plugin.failure?.stage === "duplicate";
  const { failure, folder } = plugin;
  const problems = [
    ...(failure === undefined ? [] : [`${FAILURE_STAGES[failure.stage]}: ${failure.message}`]),
    ...(webFailure === undefined ? [] : [`Styles failed: ${webFailure}`]),
  ];
  return (
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
        duplicate ? (
          folder !== undefined ? (
            <RemovePluginPopover
              name={plugin.name}
              unlink={unlink}
              folder={folder}
              disabled={busy || !canManage}
              onRemove={() =>
                whileBusy(() =>
                  uninstall({ environmentId, input: { pluginId: plugin.id, folder } }),
                )
              }
            />
          ) : undefined
        ) : (
          <>
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
              unlink={unlink}
              folder={unlink ? folder : undefined}
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
}

/** The remove button and the popup that confirms it, or Unlink for a plugin loaded from a folder. */
function RemovePluginPopover({
  name,
  unlink,
  folder,
  disabled,
  onRemove,
}: {
  readonly name: string;
  readonly unlink: boolean;
  /** Named in the popup: the folder unlinked, or the duplicate's folder deleted. */
  readonly folder: string | undefined;
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
          {folder === undefined ? null : (
            <p className="text-muted-foreground text-xs">
              {unlink ? "Stops loading " : "Deletes "}
              <span className="break-all font-mono">{folder}</span>
              {unlink ? ". The folder stays." : "."}
            </p>
          )}
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
