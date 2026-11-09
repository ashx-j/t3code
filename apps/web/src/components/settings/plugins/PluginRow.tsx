import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PluginState } from "@t3tools/contracts";
import { RotateCwIcon } from "lucide-react";
import { useState } from "react";

import { pluginWebFailuresAtom } from "../../../plugins/pluginRegistry";
import { pluginEnvironment } from "../../../state/plugins";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../ui/button";
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
  const [busy, setBusy] = useState(false);
  const webFailure = useAtomValue(pluginWebFailuresAtom(plugin.id)).get(environmentId);
  const whileBusy = async (action: () => Promise<unknown>) => {
    setBusy(true);
    await action();
    setBusy(false);
  };
  // Actions send only the id, which names the copy in use.
  const duplicate = plugin.failure?.stage === "duplicate";
  const { failure } = plugin;
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
        duplicate ? undefined : (
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
