import { useAtomValue } from "@effect/atom-react";
import { pluginSettingsForm } from "@t3tools/client-runtime/plugins/settings-form";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PluginInstallSource, PluginState } from "@t3tools/contracts";
import type * as Schema from "effect/Schema";
import {
  DownloadIcon,
  PuzzleIcon,
  RotateCwIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import { type ComponentType, useState } from "react";

import type { EnvironmentPresentation } from "../../state/environments";
import {
  pluginContributionKey,
  pluginSettingsPanelAtom,
  pluginWebFailureAtom,
} from "../../plugins/pluginRegistry";
import { pluginEnvironment } from "../../state/plugins";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { JsonSchemaSettingsForm } from "./JsonSchemaSettingsForm";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const STATUS_BADGES = {
  active: { variant: "success", label: "Active" },
  loading: { variant: "info", label: "Starting" },
  disabled: { variant: "secondary", label: "Disabled" },
  failed: { variant: "error", label: "Failed" },
} as const;

const FAILURE_STAGES = {
  discovery: "Not found",
  manifest: "Invalid manifest",
  compatibility: "Incompatible",
  load: "Failed to load",
  activate: "Failed to start",
} as const;

export function PluginsSettings() {
  const { scope, environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <SettingsSection title="Plugins" variant="plain">
        {scope.kind === "unavailable" ? (
          <SettingsRow title={scope.message} />
        ) : environment === null ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PuzzleIcon />
              </EmptyMedia>
              <EmptyTitle>No environment selected</EmptyTitle>
              <EmptyDescription>Connect an environment to manage its plugins.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <EnvironmentPlugins environment={environment} />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function EnvironmentPlugins({ environment }: { readonly environment: EnvironmentPresentation }) {
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const supported = environment.serverConfig?.environment.capabilities.plugins === true;
  const query = useEnvironmentQuery(
    connected && supported
      ? pluginEnvironment.pluginsLive({ environmentId: environment.environmentId, input: {} })
      : null,
  );
  if (!connected) {
    return (
      <SettingsRow
        title="Environment disconnected"
        description={`Reconnect ${environment.label} to manage its plugins.`}
      />
    );
  }
  if (!supported) {
    return (
      <SettingsRow
        title="Plugins are not available"
        description={`${environment.label} runs a T3 Code server without plugin support.`}
      />
    );
  }
  if (query.error) return <SettingsRow title="Could not load plugins" description={query.error} />;
  const plugins = query.data?.plugins;
  if (!plugins) return <SettingsRow title="Loading plugins…" role="status" />;
  return (
    <>
      <AddPlugin environmentId={environment.environmentId} />
      {plugins.some(
        (plugin) => plugin.installSource !== undefined && plugin.installSource.type !== "path",
      ) ? (
        <CheckPluginUpdates environmentId={environment.environmentId} plugins={plugins} />
      ) : null}
      {plugins.length === 0 ? (
        <SettingsRow
          title="No plugins installed"
          description="Plugins you add, and plugins in the plugins folder of this environment's T3 Code data directory, appear here."
        />
      ) : (
        // A shadowed copy of a plugin shares its id and is listed as failed during discovery.
        plugins.map((plugin) => (
          <PluginRow
            key={`${plugin.id}:${plugin.source}:${plugin.failure?.stage ?? "ok"}`}
            environmentId={environment.environmentId}
            plugin={plugin}
          />
        ))
      )}
    </>
  );
}

/** Checks plugins installed from git or npm now; the server also checks once a day. */
function CheckPluginUpdates({
  environmentId,
  plugins,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugins: ReadonlyArray<PluginState>;
}) {
  const canCheck = useAtomValue(pluginEnvironment.checkPluginUpdates.permissionAtom(environmentId));
  const check = useAtomCommand(pluginEnvironment.checkPluginUpdates, "plugin update check");
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  const updates = plugins.filter((plugin) => plugin.availableUpdate !== undefined).length;
  return (
    <SettingsRow
      title="Updates"
      description={
        updates > 0
          ? `${updates === 1 ? "1 plugin has" : `${updates} plugins have`} an update.`
          : checked
            ? "Plugins installed from git or npm are up to date."
            : "T3 Code checks plugins installed from git or npm once a day."
      }
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !canCheck}
          onClick={async () => {
            setBusy(true);
            const result = await check({ environmentId, input: {} });
            setBusy(false);
            setChecked(result._tag === "Success");
          }}
        >
          {busy ? "Checking…" : "Check for updates"}
        </Button>
      }
    />
  );
}

/** A git commit is shown short, an npm version as it is. */
const updateLabel = (version: string) =>
  /^[0-9a-f]{40,64}$/.test(version) ? version.slice(0, 7) : version;

const installSourceLabel = (source: PluginInstallSource) =>
  source.type === "path" ? source.path : source.type === "git" ? source.url : `npm ${source.name}`;

const INSTALL_SOURCES = {
  path: { label: "Folder on the server", placeholder: "/home/me/my-plugin" },
  git: { label: "Git repository", placeholder: "https://github.com/me/my-plugin.git" },
  npm: { label: "npm package", placeholder: "t3-plugin-example" },
} as const;

/** Installs a plugin into this environment; it runs with the same access as T3 Code itself. */
function AddPlugin({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canInstall = useAtomValue(pluginEnvironment.installPlugin.permissionAtom(environmentId));
  const install = useAtomCommand(pluginEnvironment.installPlugin, {
    label: "plugin install",
    reportFailure: false,
  });
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<keyof typeof INSTALL_SOURCES>("path");
  const [location, setLocation] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!open) {
    return (
      <SettingsRow
        title="Add a plugin"
        description="Plugins run with the same access as T3 Code, so install only code you trust."
        control={
          <Button size="sm" variant="outline" disabled={!canInstall} onClick={() => setOpen(true)}>
            Add plugin
          </Button>
        }
      />
    );
  }
  const submit = async () => {
    setBusy(true);
    setProblem(null);
    const extra = ref.trim();
    const source =
      kind === "path"
        ? { type: "path" as const, path: location.trim() }
        : kind === "git"
          ? { type: "git" as const, url: location.trim(), ...(extra === "" ? {} : { ref: extra }) }
          : {
              type: "npm" as const,
              name: location.trim(),
              ...(extra === "" ? {} : { version: extra }),
            };
    const result = await install({ environmentId, input: { source } });
    setBusy(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setProblem(error instanceof Error ? error.message : "Could not install the plugin.");
      return;
    }
    setOpen(false);
    setLocation("");
    setRef("");
  };
  return (
    <SettingsRow
      title="Add a plugin"
      description="Plugins run with the same access as T3 Code, so install only code you trust."
    >
      <form
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="plugin-install-source">Source</Label>
          <Select
            value={kind}
            onValueChange={(value) => setKind(value === "git" || value === "npm" ? value : "path")}
          >
            <SelectTrigger id="plugin-install-source">
              <SelectValue>{INSTALL_SOURCES[kind].label}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="path">{INSTALL_SOURCES.path.label}</SelectItem>
              <SelectItem value="git">{INSTALL_SOURCES.git.label}</SelectItem>
              <SelectItem value="npm">{INSTALL_SOURCES.npm.label}</SelectItem>
            </SelectPopup>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="plugin-install-location">
            {kind === "path" ? "Folder path" : kind === "git" ? "Repository URL" : "Package name"}
          </Label>
          <Input
            id="plugin-install-location"
            value={location}
            placeholder={INSTALL_SOURCES[kind].placeholder}
            onChange={(event) => setLocation(event.target.value)}
          />
        </div>
        {kind === "path" ? null : (
          <div className="space-y-1.5">
            <Label htmlFor="plugin-install-ref">
              {kind === "git"
                ? "Branch or tag (optional)"
                : "Version (optional, latest by default)"}
            </Label>
            <Input
              id="plugin-install-ref"
              value={ref}
              onChange={(event) => setRef(event.target.value)}
            />
          </div>
        )}
        {problem === null ? null : <p className="text-destructive text-xs">{problem}</p>}
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy || location.trim() === ""}>
            {busy ? "Installing…" : "Install"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              setProblem(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    </SettingsRow>
  );
}

function PluginRow({
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
  const update = useAtomCommand(pluginEnvironment.updatePlugin, "plugin update");
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeData, setRemoveData] = useState(false);
  const contributionKey = pluginContributionKey(environmentId, plugin.id);
  const customSettings = useAtomValue(pluginSettingsPanelAtom(contributionKey));
  const webFailure = useAtomValue(pluginWebFailureAtom(contributionKey));
  const hasSettings =
    customSettings !== undefined || pluginSettingsForm(plugin.settingsSchema).kind !== "none";
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    await action();
    setBusy(false);
  };
  const badge = STATUS_BADGES[plugin.status];
  return (
    <SettingsRow
      title={plugin.name}
      description={
        <>
          {plugin.description}
          {plugin.permissions.length > 0 ? (
            <span className="block">Permissions: {plugin.permissions.join(", ")}</span>
          ) : null}
        </>
      }
      status={
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={badge.variant}>{badge.label}</Badge>
          {plugin.availableUpdate === undefined ? null : (
            <Badge variant="info">
              Update available: {updateLabel(plugin.availableUpdate.version)}
            </Badge>
          )}
          <span>
            {plugin.version === undefined ? plugin.id : `${plugin.id} ${plugin.version}`}
            {plugin.source === "dev" ? " · dev folder" : ""}
          </span>
          {plugin.failure ? (
            <span className="text-destructive">
              {FAILURE_STAGES[plugin.failure.stage]}: {plugin.failure.message}
            </span>
          ) : null}
          {webFailure === undefined ? null : (
            <span className="text-destructive">Web part failed: {webFailure}</span>
          )}
        </div>
      }
      control={
        <>
          {hasSettings ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Settings for ${plugin.name}`}
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <SlidersHorizontalIcon className="size-4" />
            </Button>
          ) : null}
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={busy || !canManage}
            aria-label={`Reload ${plugin.name}`}
            onClick={() =>
              void run(() => reload({ environmentId, input: { pluginId: plugin.id } }))
            }
          >
            <RotateCwIcon className="size-4" />
          </Button>
          {plugin.installSource === undefined ? null : (
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy || !canManage}
              aria-label={`Update ${plugin.name}`}
              title={
                plugin.availableUpdate === undefined
                  ? `Update from ${installSourceLabel(plugin.installSource)}`
                  : `Update to ${updateLabel(plugin.availableUpdate.version)} from ${installSourceLabel(plugin.installSource)}`
              }
              onClick={() =>
                void run(() => update({ environmentId, input: { pluginId: plugin.id } }))
              }
            >
              <DownloadIcon className="size-4" />
            </Button>
          )}
          {plugin.source === "installed" ? (
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy || !canManage}
              aria-label={`Remove ${plugin.name}`}
              aria-expanded={removing}
              onClick={() => setRemoving((open) => !open)}
            >
              <Trash2Icon className="size-4" />
            </Button>
          ) : null}
          <Switch
            checked={plugin.enabled}
            disabled={busy || !canManage}
            aria-label={`Enable ${plugin.name}`}
            onCheckedChange={(enabled) =>
              void run(() => setEnabled({ environmentId, input: { pluginId: plugin.id, enabled } }))
            }
          />
        </>
      }
    >
      {removing ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t pt-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id={`plugin-remove-data-${plugin.id}`}
              checked={removeData}
              onCheckedChange={(checked) => setRemoveData(checked === true)}
            />
            <Label htmlFor={`plugin-remove-data-${plugin.id}`}>
              Also delete its settings and stored data
            </Label>
          </div>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() =>
              void run(() =>
                uninstall({ environmentId, input: { pluginId: plugin.id, removeData } }),
              )
            }
          >
            Remove {plugin.name}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {settingsOpen ? (
        customSettings === undefined ? (
          <PluginSettingsEditor environmentId={environmentId} plugin={plugin} />
        ) : (
          <PluginCustomSettings panel={customSettings} />
        )
      ) : null}
    </SettingsRow>
  );
}

/** A settings panel the plugin's web bundle drew instead of the generated form. */
function PluginCustomSettings(props: { readonly panel: ComponentType }) {
  const Panel = props.panel;
  return (
    <div className="border-t py-3">
      <RenderErrorBoundary
        resetKeys={[Panel]}
        fallback={
          <p className="text-xs text-destructive">
            This plugin's settings panel stopped with an error.
          </p>
        }
      >
        <Panel />
      </RenderErrorBoundary>
    </div>
  );
}

function PluginSettingsEditor({
  environmentId,
  plugin,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugin: PluginState;
}) {
  const query = useEnvironmentQuery(
    pluginEnvironment.pluginSettings({ environmentId, input: { pluginId: plugin.id } }),
  );
  if (query.error) return <p className="py-2 text-xs text-destructive">{query.error}</p>;
  if (!query.data) return <p className="py-2 text-xs text-muted-foreground">Loading settings…</p>;
  return (
    <PluginSettingsFormView
      environmentId={environmentId}
      plugin={plugin}
      initialSettings={query.data.settings}
    />
  );
}

function PluginSettingsFormView({
  environmentId,
  plugin,
  initialSettings,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugin: PluginState;
  readonly initialSettings: Schema.JsonObject;
}) {
  const update = useAtomCommand(pluginEnvironment.updatePluginSettings, {
    label: "plugin settings",
    reportFailure: false,
  });
  const canSave = useAtomValue(
    pluginEnvironment.updatePluginSettings.permissionAtom(environmentId),
  );
  return (
    <JsonSchemaSettingsForm
      idPrefix={`plugin-setting-${plugin.id}`}
      label={plugin.name}
      schema={plugin.settingsSchema}
      settings={initialSettings}
      canSave={canSave}
      onSave={async (patch) => {
        const result = await update({ environmentId, input: { pluginId: plugin.id, patch } });
        if (result._tag === "Success") return { settings: result.value.settings };
        const error = squashAtomCommandFailure(result);
        return {
          problem: error instanceof Error ? error.message : "Could not save the settings.",
        };
      }}
    />
  );
}
