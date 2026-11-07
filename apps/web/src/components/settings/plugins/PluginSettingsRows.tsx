import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type * as Schema from "effect/Schema";

import { pluginEnvironment } from "../../../state/plugins";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";
import { JsonSchemaSettingsForm } from "../JsonSchemaSettingsForm";
import { SettingsRow } from "../settingsLayout";
import type { PluginCopy } from "./pluginTargets";

/** Shows the first copy's settings. Saving writes the same change to every copy. */
export function PluginSettingsEditor({
  first,
  copies,
  labelled,
}: {
  readonly first: PluginCopy;
  readonly copies: ReadonlyArray<PluginCopy>;
  readonly labelled: boolean;
}) {
  const query = useEnvironmentQuery(
    pluginEnvironment.pluginSettings({
      environmentId: first.environmentId,
      input: { pluginId: first.plugin.id },
    }),
  );
  if (query.error) return <SettingsRow title="Could not load settings" description={query.error} />;
  if (!query.data) return <SettingsRow title="Loading settings…" role="status" />;
  return (
    <PluginSettingsFormView
      first={first}
      copies={copies}
      labelled={labelled}
      initialSettings={query.data.settings}
    />
  );
}

function PluginSettingsFormView({
  first,
  copies,
  labelled,
  initialSettings,
}: {
  readonly first: PluginCopy;
  readonly copies: ReadonlyArray<PluginCopy>;
  readonly labelled: boolean;
  readonly initialSettings: Schema.JsonObject;
}) {
  const { plugin } = first;
  const update = useAtomCommand(pluginEnvironment.updatePluginSettings, {
    label: "plugin settings",
    reportFailure: false,
  });
  const canSave = useAtomValue(
    pluginEnvironment.updatePluginSettings.permissionAtom(first.environmentId),
  );
  return (
    <JsonSchemaSettingsForm
      idPrefix={`plugin-setting-${plugin.id}`}
      label={plugin.name}
      schema={plugin.settingsSchema}
      settings={initialSettings}
      canSave={canSave}
      onSave={async (patch) => {
        const saved = await Promise.all(
          copies.map(async (copy) => ({
            copy,
            result: await update({
              environmentId: copy.environmentId,
              input: { pluginId: plugin.id, patch },
            }),
          })),
        );
        const problems = saved.flatMap(({ copy, result }) => {
          if (result._tag === "Success") return [];
          const error = squashAtomCommandFailure(result);
          const message = error instanceof Error ? error.message : "Could not save the settings.";
          return [labelled ? `${copy.label}: ${message}` : message];
        });
        const [mine] = saved;
        return problems.length === 0 && mine?.result._tag === "Success"
          ? { settings: mine.result.value.settings }
          : { problem: problems.join(" ") };
      }}
    />
  );
}
