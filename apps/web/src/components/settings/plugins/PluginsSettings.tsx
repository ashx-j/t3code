import { BlocksIcon } from "lucide-react";

import type { EnvironmentPresentation } from "../../../state/environments";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../../ui/empty";
import { useSettingsScope } from "../SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settingsLayout";
import { PluginList } from "./PluginList";
import { runsPlugins } from "./pluginTargets";
import { PluginUiEnvironmentRow } from "./PluginUiEnvironmentRow";

export function PluginsSettings() {
  const { scope, environment } = useSettingsScope();
  if (scope.kind === "unavailable") {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Plugins">
          <SettingsRow title={scope.message} />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  if (environment === null) {
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
  return <PluginsPage environment={environment} />;
}

/** Lists the environment's plugins. */
function PluginsPage({ environment }: { readonly environment: EnvironmentPresentation }) {
  const runs = runsPlugins(environment);
  return (
    <SettingsPageContainer>
      {runs ? (
        <PluginList environmentId={environment.environmentId}>
          <PluginUiEnvironmentRow />
        </PluginList>
      ) : (
        <SettingsSection title="Plugins">
          <SettingsRow
            title="Plugins are not available"
            description={`${environment.label} runs a T3 Code server without plugin support.`}
          />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
