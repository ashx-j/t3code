import { useAtomValue } from "@effect/atom-react";
import {
  type PluginSettingsField,
  pluginSettingsForm,
} from "@t3tools/client-runtime/plugins/settings-form";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PluginState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
import { Textarea } from "../ui/textarea";
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

const INSTALL_SOURCES = {
  path: { label: "Folder on the server", placeholder: "/home/me/my-plugin" },
  git: { label: "Git repository", placeholder: "https://github.com/me/my-plugin.git" },
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
    const source =
      kind === "path"
        ? { type: "path" as const, path: location.trim() }
        : {
            type: "git" as const,
            url: location.trim(),
            ...(ref.trim() === "" ? {} : { ref: ref.trim() }),
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
          <Select value={kind} onValueChange={(value) => setKind(value === "git" ? "git" : "path")}>
            <SelectTrigger id="plugin-install-source">
              <SelectValue>{INSTALL_SOURCES[kind].label}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="path">{INSTALL_SOURCES.path.label}</SelectItem>
              <SelectItem value="git">{INSTALL_SOURCES.git.label}</SelectItem>
            </SelectPopup>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="plugin-install-location">
            {kind === "path" ? "Folder path" : "Repository URL"}
          </Label>
          <Input
            id="plugin-install-location"
            value={location}
            placeholder={INSTALL_SOURCES[kind].placeholder}
            onChange={(event) => setLocation(event.target.value)}
          />
        </div>
        {kind === "git" ? (
          <div className="space-y-1.5">
            <Label htmlFor="plugin-install-ref">Branch or tag (optional)</Label>
            <Input
              id="plugin-install-ref"
              value={ref}
              onChange={(event) => setRef(event.target.value)}
            />
          </div>
        ) : null}
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
              title={`Update from ${
                plugin.installSource.type === "path"
                  ? plugin.installSource.path
                  : plugin.installSource.url
              }`}
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

type Draft = Readonly<Record<string, string | boolean>>;

const draftValue = (field: PluginSettingsField, value: Schema.Json | undefined) => {
  switch (field.kind) {
    case "boolean":
      return typeof value === "boolean" ? value : (field.defaultValue ?? false);
    case "secret":
      return "";
    case "list":
      return Array.isArray(value) ? value.join("\n") : "";
    default:
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
};

/** The changed fields as a settings patch, or the first problem a user can fix before saving. */
const toPatch = (
  fields: ReadonlyArray<PluginSettingsField>,
  saved: Draft,
  draft: Draft,
): { readonly patch: Schema.JsonObject } | { readonly problem: string } => {
  const patch: Record<string, Schema.Json> = {};
  for (const field of fields) {
    const value = draft[field.key];
    if (value === saved[field.key] || value === undefined) continue;
    if (typeof value === "boolean") {
      patch[field.key] = value;
    } else if (field.kind === "secret") {
      if (value !== "") patch[field.key] = value;
    } else if (value.trim() === "") {
      patch[field.key] = null;
    } else if (field.kind === "number") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return { problem: `${field.label} must be a number.` };
      patch[field.key] = parsed;
    } else if (field.kind === "select") {
      patch[field.key] = field.options.find((option) => String(option) === value) ?? value;
    } else if (field.kind === "list") {
      patch[field.key] = value
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } else {
      patch[field.key] = value;
    }
  }
  return { patch };
};

const parseJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject));

function PluginSettingsFormView({
  environmentId,
  plugin,
  initialSettings,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugin: PluginState;
  readonly initialSettings: Schema.JsonObject;
}) {
  const form = pluginSettingsForm(plugin.settingsSchema);
  const fields = form.kind === "fields" ? form.fields : [];
  const update = useAtomCommand(pluginEnvironment.updatePluginSettings, {
    label: "plugin settings",
    reportFailure: false,
  });
  const canSave = useAtomValue(
    pluginEnvironment.updatePluginSettings.permissionAtom(environmentId),
  );
  const toDraft = (settings: Schema.JsonObject): Draft =>
    Object.fromEntries(fields.map((field) => [field.key, draftValue(field, settings[field.key])]));
  const [savedSettings, setSavedSettings] = useState(initialSettings);
  const [saved, setSaved] = useState(() => toDraft(initialSettings));
  const [draft, setDraft] = useState(saved);
  const [json, setJson] = useState(() => JSON.stringify(initialSettings, null, 2));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const next =
      form.kind === "json"
        ? (() => {
            const parsed = parseJsonObject(json);
            return Option.isSome(parsed)
              ? { patch: parsed.value }
              : { problem: "Settings must be a JSON object." };
          })()
        : toPatch(fields, saved, draft);
    if ("problem" in next) return setProblem(next.problem);
    setBusy(true);
    const result = await update({
      environmentId,
      input: { pluginId: plugin.id, patch: next.patch },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      return setProblem(error instanceof Error ? error.message : "Could not save the settings.");
    }
    setProblem(null);
    setSavedSettings(result.value.settings);
    const savedDraft = toDraft(result.value.settings);
    setSaved(savedDraft);
    setDraft(savedDraft);
    setJson(JSON.stringify(result.value.settings, null, 2));
  };

  return (
    <div className="space-y-3 border-t py-3">
      {form.kind === "json" ? (
        <Textarea
          aria-label={`${plugin.name} settings JSON`}
          rows={8}
          value={json}
          onChange={(event) => setJson(event.target.value)}
        />
      ) : (
        fields.map((field) => (
          <PluginSettingsFieldView
            key={field.key}
            field={field}
            value={draft[field.key]}
            hasSecret={savedSettings[field.key] !== undefined}
            onChange={(value) => setDraft((current) => ({ ...current, [field.key]: value }))}
          />
        ))
      )}
      {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
      <div className="flex justify-end">
        <Button size="sm" disabled={busy || !canSave} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}

function PluginSettingsFieldView({
  field,
  value,
  hasSecret,
  onChange,
}: {
  readonly field: PluginSettingsField;
  readonly value: string | boolean | undefined;
  readonly hasSecret: boolean;
  readonly onChange: (value: string | boolean) => void;
}) {
  const id = `plugin-setting-${field.key}`;
  const text = typeof value === "string" ? value : "";
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>
        {field.label}
        {field.required ? " *" : ""}
      </Label>
      {field.description ? (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      ) : null}
      {field.kind === "boolean" ? (
        <Switch id={id} checked={value === true} onCheckedChange={onChange} />
      ) : field.kind === "select" ? (
        <Select value={text} onValueChange={(next) => typeof next === "string" && onChange(next)}>
          <SelectTrigger id={id} size="sm" aria-label={field.label}>
            <SelectValue>{text}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {field.options.map((option) => (
              <SelectItem key={String(option)} value={String(option)}>
                {String(option)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : field.kind === "list" ? (
        <Textarea
          id={id}
          rows={3}
          placeholder="One value per line"
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          type={field.kind === "secret" ? "password" : field.kind === "number" ? "number" : "text"}
          autoComplete="off"
          placeholder={
            field.kind === "secret"
              ? hasSecret
                ? "Saved. Type to replace."
                : "Not set"
              : undefined
          }
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}
