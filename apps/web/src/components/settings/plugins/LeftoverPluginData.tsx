import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PluginLeftoverData } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";

import { pluginEnvironment } from "../../../state/plugins";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import type { PluginCopy, PluginTarget } from "./pluginTargets";

// Keyed by the JSON list of environment ids, like the plugin lists.
const leftoverListsAtom = Atom.family((environmentIdsKey: string) => {
  const environmentIds = JSON.parse(environmentIdsKey) as ReadonlyArray<EnvironmentId>;
  return Atom.make((get) =>
    environmentIds.map((environmentId) =>
      get(pluginEnvironment.leftoverPluginData({ environmentId, input: {} })),
    ),
  ).pipe(Atom.withLabel(`web-plugin-leftovers:${environmentIdsKey}`));
});

const describeLeftover = (leftover: PluginLeftoverData) => {
  const parts = [
    ...(leftover.settings ? ["Settings and secrets"] : []),
    ...(leftover.storageKeys > 0
      ? [`${leftover.storageKeys} stored ${leftover.storageKeys === 1 ? "item" : "items"}`]
      : []),
  ];
  return `${parts.length === 0 ? "Stored data" : parts.join(", ")}. Installing it again uses this.`;
};

/**
 * What plugins removed without their data left on `targets`, each with a way to delete it. Nothing
 * while none did. `installed` hides a plugin installed again since the list was read.
 */
export function LeftoverPluginData(props: {
  readonly targets: ReadonlyArray<PluginTarget>;
  readonly installed: ReadonlyArray<PluginCopy>;
  readonly labelled: boolean;
}) {
  const lists = useAtomValue(
    leftoverListsAtom(JSON.stringify(props.targets.map((target) => target.environmentId))),
  );
  // An environment that fails to list them, such as an older server, shows none.
  const rows = props.targets.flatMap((target, index) =>
    (AsyncResult.getOrElse(lists[index] ?? AsyncResult.initial(true), () => null)?.leftovers ?? [])
      .filter(
        (leftover) =>
          !props.installed.some(
            (copy) =>
              copy.environmentId === target.environmentId && copy.plugin.id === leftover.pluginId,
          ),
      )
      .map((leftover) => ({ target, leftover })),
  );
  if (rows.length === 0) return null;
  return (
    <SettingsSection title="Data from removed plugins">
      {rows.map(({ target, leftover }) => (
        <LeftoverPluginRow
          key={`${target.environmentId}:${leftover.pluginId}`}
          target={target}
          leftover={leftover}
          labelled={props.labelled}
        />
      ))}
    </SettingsSection>
  );
}

function LeftoverPluginRow(props: {
  readonly target: PluginTarget;
  readonly leftover: PluginLeftoverData;
  readonly labelled: boolean;
}) {
  const { target, leftover } = props;
  const canDelete = useAtomValue(
    pluginEnvironment.deleteLeftoverPluginData.permissionAtom(target.environmentId),
  );
  const deleteData = useAtomCommand(
    pluginEnvironment.deleteLeftoverPluginData,
    "plugin leftover data deletion",
  );
  const [busy, setBusy] = useState(false);
  return (
    <SettingsRow
      title={props.labelled ? `${target.label}: ${leftover.pluginId}` : leftover.pluginId}
      description={describeLeftover(leftover)}
      control={
        <Popover>
          <PopoverTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={busy || !canDelete}
                aria-label={`Delete the data ${leftover.pluginId} left`}
              />
            }
          >
            <Trash2Icon className="size-4" />
          </PopoverTrigger>
          <PopoverPopup side="top" align="end" width="md">
            <div className="flex flex-col gap-3">
              <p className="text-muted-foreground text-xs">
                Deletes its settings, secrets and stored data. This can't be undone.
              </p>
              <div className="flex justify-end gap-2">
                <PopoverClose render={<Button size="sm" variant="ghost" disabled={busy} />}>
                  Cancel
                </PopoverClose>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    await deleteData({
                      environmentId: target.environmentId,
                      input: { pluginId: leftover.pluginId },
                    });
                    setBusy(false);
                  }}
                >
                  Delete data
                </Button>
              </div>
            </div>
          </PopoverPopup>
        </Popover>
      }
    />
  );
}
