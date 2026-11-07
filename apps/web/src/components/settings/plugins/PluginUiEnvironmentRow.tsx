import { useAtom } from "@effect/atom-react";

import { chosenPluginUiEnvironmentAtom } from "../../../plugins/pluginFollow";
import { useEnvironments, usePrimaryEnvironmentId } from "../../../state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { settingsScopeEnvironmentLabel } from "../settingsScopeAxis";
import { SettingsRow } from "../settingsLayout";
import { runsPlugins } from "./pluginTargets";

const NONE = "none";

/**
 * Picks the one environment this browser loads plugin UI from. Offered only without a main
 * environment, which always supplies it; nothing is picked until the user picks.
 */
export function PluginUiEnvironmentRow() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [chosenEnvironmentId, choose] = useAtom(chosenPluginUiEnvironmentAtom);
  if (primaryEnvironmentId !== null) return null;
  // The current pick stays listed while it is offline, so the menu can show it.
  const options = environments.filter(
    (environment) => runsPlugins(environment) || environment.environmentId === chosenEnvironmentId,
  );
  const labelOf = (environmentId: string) => {
    const environment = environments.find((option) => option.environmentId === environmentId);
    return environment === undefined
      ? "A removed environment"
      : settingsScopeEnvironmentLabel(environment, environments);
  };
  return (
    <SettingsRow
      title="Load plugin UI from"
      description="The chosen server's plugins run code in this window."
      control={
        <Select
          value={chosenEnvironmentId ?? NONE}
          onValueChange={(value) =>
            choose(options.find((option) => option.environmentId === value)?.environmentId ?? null)
          }
        >
          <SelectTrigger size="sm" className="w-full sm:w-48" aria-label="Load plugin UI from">
            <SelectValue>
              {chosenEnvironmentId === null ? "None" : labelOf(chosenEnvironmentId)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value={NONE}>
              None
            </SelectItem>
            {options.map((option) => (
              <SelectItem hideIndicator key={option.environmentId} value={option.environmentId}>
                {labelOf(option.environmentId)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
