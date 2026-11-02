import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { pluginSettingsForm } from "@t3tools/client-runtime/plugins/settings-form";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PluginInstallSource, PluginState } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import type * as Schema from "effect/Schema";
import {
  DownloadIcon,
  FolderDownIcon,
  PuzzleIcon,
  RotateCwIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import { type ComponentType, type DragEvent, useContext, useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { droppedFolders, type PluginFolder, pickedFolder } from "../../plugins/pluginFolders";
import { type EnvironmentPresentation, usePrimaryEnvironmentId } from "../../state/environments";
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
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { JsonSchemaSettingsForm } from "./JsonSchemaSettingsForm";
import { useSettingsScope } from "./SettingsScopeContext";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const FAILURE_STAGES = {
  discovery: "Not found",
  manifest: "Invalid manifest",
  compatibility: "Incompatible",
  load: "Failed to load",
  activate: "Failed to start",
} as const;

export function PluginsSettings() {
  const { scope, environment, environments } = useSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (scope.kind === "unavailable") {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Plugins" variant="plain">
          <SettingsRow title={scope.message} />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  // The main environment comes first: installs start there, see `usePluginInstaller`.
  const shown =
    scope.kind === "all"
      ? environments.toSorted(
          (a, b) =>
            Number(b.environmentId === primaryEnvironmentId) -
            Number(a.environmentId === primaryEnvironmentId),
        )
      : environment === null
        ? []
        : [environment];
  if (shown.length === 0) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Plugins" variant="plain">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PuzzleIcon />
              </EmptyMedia>
              <EmptyTitle>No environment selected</EmptyTitle>
              <EmptyDescription>Connect an environment to manage its plugins.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return <PluginsPage environments={shown} />;
}

const runsPlugins = (environment: EnvironmentPresentation) =>
  environment.connection.phase === "connected" &&
  environment.serverConfig?.environment.capabilities.plugins === true;

/** Lists each environment's plugins. Plugin folders dropped anywhere on it are installed. */
function PluginsPage({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  // Labels tell apart environments with the same name, as the scope picker does.
  const labelOf = (environment: EnvironmentPresentation) =>
    settingsScopeEnvironmentLabel(environment, environments);
  const targets = environments.filter(runsPlugins).map((environment) => ({
    environmentId: environment.environmentId,
    label: labelOf(environment),
  }));
  const installer = usePluginInstaller(targets);
  const [adding, setAdding] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const several = environments.length > 1;
  const [main] = targets;
  const isFileDrag = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  return (
    <SettingsPageContainer>
      {/* Drops on the Add plugin dialog land here too: React bubbles events out of portals. */}
      <div
        className={cn(
          "-m-3 flex flex-col gap-8 rounded-xl p-3",
          dragActive &&
            "bg-primary/5 outline-2 -outline-offset-2 outline-primary/60 outline-dashed",
        )}
        onDragEnter={(event) => {
          if (!isFileDrag(event)) return;
          event.preventDefault();
          setDragActive(true);
        }}
        onDragOver={(event) => {
          if (!isFileDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          if (!isFileDrag(event)) return;
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          ) {
            return;
          }
          setDragActive(false);
        }}
        onDrop={(event) => {
          if (!isFileDrag(event)) return;
          event.preventDefault();
          setDragActive(false);
          if (installer.installing !== null) return;
          void installer
            .installFolders(droppedFolders(event.dataTransfer))
            .then((installed) => installed && setAdding(false));
        }}
      >
        <SettingsSection title="Plugins" variant="plain">
          {main === undefined ? null : (
            <SettingsRow
              title="Add a plugin"
              description={
                installer.installing === null
                  ? "Drop plugin folders on this page, or pick one with Add plugin. Plugins run with the same access as T3 Code, so install only code you trust."
                  : `Installing ${installer.installing}…`
              }
              control={
                <AddPluginButton
                  environmentId={main.environmentId}
                  disabled={installer.installing !== null}
                  onClick={() => {
                    installer.clearProblems();
                    setAdding(true);
                  }}
                />
              }
            >
              <InstallProblems problems={installer.problems} />
            </SettingsRow>
          )}
          {several ? null : <EnvironmentPlugins environment={environments[0]!} />}
        </SettingsSection>
        {several
          ? environments.map((environment) => (
              <SettingsSection
                key={environment.environmentId}
                title={labelOf(environment)}
                variant="plain"
              >
                <EnvironmentPlugins environment={environment} />
              </SettingsSection>
            ))
          : null}
        {main === undefined ? null : (
          <AddPluginDialog
            open={adding}
            onOpenChange={setAdding}
            installer={installer}
            dragActive={dragActive}
            scopeNote={
              targets.length > 1
                ? `Installs on every environment that runs plugins. A plugin with no server code or agent skills only changes the app, so it goes to ${main.label} only.`
                : `Installs on ${main.label}.`
            }
          />
        )}
      </div>
    </SettingsPageContainer>
  );
}

function AddPluginButton(props: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  const canInstall = useAtomValue(
    pluginEnvironment.installPluginFiles.permissionAtom(props.environmentId),
  );
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={props.disabled || !canInstall}
      onClick={props.onClick}
    >
      Add plugin
    </Button>
  );
}

function InstallProblems({ problems }: { readonly problems: ReadonlyArray<string> }) {
  if (problems.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-destructive text-xs">
      {problems.map((problem) => (
        <li key={problem}>{problem}</li>
      ))}
    </ul>
  );
}

/**
 * Installs plugins on `targets`, the main environment first. The app draws plugin UI only from
 * the main environment, so a plugin without server code or agent skills changes nothing on the
 * others and is installed on the main one only.
 */
function usePluginInstaller(
  targets: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>,
) {
  const installSource = useAtomCommand(pluginEnvironment.installPlugin, {
    label: "plugin install",
    reportFailure: false,
  });
  const installFiles = useAtomCommand(pluginEnvironment.installPluginFiles, {
    label: "plugin install",
    reportFailure: false,
  });
  const [installing, setInstalling] = useState<string | null>(null);
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);

  const installOnTargets = async (
    install: (environmentId: EnvironmentId) => ReturnType<typeof installFiles>,
    report: (problem: string) => void,
  ) => {
    const [main, ...others] = targets;
    if (main === undefined) return report("No environment here can run plugins.");
    const reportFailure = (
      target: (typeof targets)[number],
      result: { readonly cause: Cause.Cause<unknown> },
    ) => {
      const error = squashAtomCommandFailure(result);
      const message = error instanceof Error ? error.message : "Could not install the plugin.";
      report(targets.length > 1 ? `${target.label}: ${message}` : message);
    };
    const first = await install(main.environmentId);
    if (first._tag === "Failure") return reportFailure(main, first);
    const { plugin } = first.value;
    if (!plugin.hasServer && plugin.hasSkills !== true) return;
    const results = await Promise.all(others.map((target) => install(target.environmentId)));
    results.forEach((result, index) => {
      if (result._tag === "Failure") reportFailure(others[index]!, result);
    });
  };

  // Resolves true when everything installed everywhere it should.
  const run = async (work: (report: (problem: string) => void) => Promise<void>) => {
    const found: Array<string> = [];
    setProblems([]);
    await work((problem) => found.push(problem));
    setInstalling(null);
    setProblems(found);
    return found.length === 0;
  };

  return {
    installing,
    problems,
    clearProblems: () => setProblems([]),
    installFolders: (folders: ReadonlyArray<PluginFolder>) =>
      run(async (report) => {
        if (folders.length === 0) return report("Drop a plugin's folder, not the files in it.");
        for (const folder of folders) {
          setInstalling(folder.name);
          const files = await folder.read().catch((error: unknown) => {
            report(error instanceof Error ? error.message : `Could not read ${folder.name}.`);
            return null;
          });
          if (files === null) continue;
          await installOnTargets(
            (environmentId) => installFiles({ environmentId, input: { files } }),
            report,
          );
        }
      }),
    installSource: (source: PluginInstallSource) =>
      run(async (report) => {
        setInstalling(installSourceLabel(source));
        await installOnTargets(
          (environmentId) => installSource({ environmentId, input: { source } }),
          report,
        );
      }),
  };
}

function EnvironmentPlugins({ environment }: { readonly environment: EnvironmentPresentation }) {
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const supported = environment.serverConfig?.environment.capabilities.plugins === true;
  useRescanPlugins(environment.environmentId, connected && supported);
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
      {plugins.some(
        (plugin) => plugin.installSource !== undefined && plugin.installSource.type !== "path",
      ) ? (
        <CheckPluginUpdates environmentId={environment.environmentId} plugins={plugins} />
      ) : null}
      {plugins.length === 0 ? (
        <SettingsRow
          title="No plugins installed"
          description="Drop a plugin folder on this page to add it."
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

/** Has the server look at its plugins folder again, so folders copied there by hand are listed. */
function useRescanPlugins(environmentId: EnvironmentId, available: boolean) {
  const registry = useContext(RegistryContext);
  const canRescan = useAtomValue(pluginEnvironment.rescanPlugins.permissionAtom(environmentId));
  const rescan = available && canRescan;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The server reads its plugins folder only when asked, so opening the page asks it.
  useEffect(() => {
    if (!rescan) return;
    void runAtomCommand(
      registry,
      pluginEnvironment.rescanPlugins,
      { environmentId, input: {} },
      { label: "plugin folder scan", reportFailure: false, reportDefect: false },
    );
  }, [registry, environmentId, rescan]);
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
  git: { label: "Git repository", placeholder: "https://github.com/me/my-plugin.git" },
  npm: { label: "npm package", placeholder: "t3-plugin-example" },
} as const;

function AddPluginDialog({
  open,
  onOpenChange,
  installer,
  dragActive,
  scopeNote,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly installer: ReturnType<typeof usePluginInstaller>;
  readonly dragActive: boolean;
  readonly scopeNote: string;
}) {
  const [kind, setKind] = useState<keyof typeof INSTALL_SOURCES>("git");
  const [location, setLocation] = useState("");
  const [ref, setRef] = useState("");
  const folderInput = useRef<HTMLInputElement>(null);
  const busy = installer.installing !== null;
  const submit = async () => {
    const extra = ref.trim();
    const source =
      kind === "git"
        ? { type: "git" as const, url: location.trim(), ...(extra === "" ? {} : { ref: extra }) }
        : {
            type: "npm" as const,
            name: location.trim(),
            ...(extra === "" ? {} : { version: extra }),
          };
    if (!(await installer.installSource(source))) return;
    onOpenChange(false);
    setLocation("");
    setRef("");
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a plugin</DialogTitle>
          <DialogDescription>
            {scopeNote} Plugins run with the same access as T3 Code, so install only code you trust.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div
            className={cn(
              "flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center",
              dragActive ? "border-primary bg-primary/5" : "border-border",
            )}
          >
            <FolderDownIcon className="size-5 text-muted-foreground" />
            <p className="text-sm">
              {busy ? `Installing ${installer.installing}…` : "Drop plugin folders here"}
            </p>
            <p className="text-muted-foreground text-xs">
              T3 Code copies each one into its plugins folder.
            </p>
            <Button
              className="mt-2"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => folderInput.current?.click()}
            >
              Choose folder
            </Button>
            <input
              ref={(input) => {
                // Not in React's input props; it makes the picker choose folders, not files.
                if (input !== null) input.webkitdirectory = true;
                folderInput.current = input;
              }}
              type="file"
              hidden
              onChange={(event) => {
                const folder = pickedFolder(Array.from(event.currentTarget.files ?? []));
                // Cleared so picking the same folder again still reports a change.
                event.currentTarget.value = "";
                if (folder === undefined) return;
                void installer
                  .installFolders([folder])
                  .then((installed) => installed && onOpenChange(false));
              }}
            />
          </div>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="plugin-install-source">Or install from</Label>
              <Select
                value={kind}
                onValueChange={(value) => setKind(value === "npm" ? "npm" : "git")}
              >
                <SelectTrigger id="plugin-install-source">
                  <SelectValue>{INSTALL_SOURCES[kind].label}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="git">{INSTALL_SOURCES.git.label}</SelectItem>
                  <SelectItem value="npm">{INSTALL_SOURCES.npm.label}</SelectItem>
                </SelectPopup>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plugin-install-location">
                {kind === "git" ? "Repository URL" : "Package name"}
              </Label>
              <Input
                id="plugin-install-location"
                value={location}
                placeholder={INSTALL_SOURCES[kind].placeholder}
                onChange={(event) => setLocation(event.target.value)}
              />
            </div>
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
            <Button type="submit" size="sm" disabled={busy || location.trim() === ""}>
              {busy ? "Installing…" : "Install"}
            </Button>
          </form>
          <InstallProblems problems={installer.problems} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
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
  const problems = [
    ...(plugin.failure
      ? [`${FAILURE_STAGES[plugin.failure.stage]}: ${plugin.failure.message}`]
      : []),
    ...(webFailure === undefined ? [] : [`Web part failed: ${webFailure}`]),
  ];
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
        plugin.availableUpdate === undefined && problems.length === 0 ? undefined : (
          <div className="flex flex-wrap items-center gap-2">
            {plugin.availableUpdate === undefined ? null : (
              <Badge variant="info">
                Update available: {updateLabel(plugin.availableUpdate.version)}
              </Badge>
            )}
            {problems.map((problem) => (
              <span key={problem} className="text-destructive">
                {problem}
              </span>
            ))}
          </div>
        )
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
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={busy || !canManage}
                    aria-label={`Remove ${plugin.name}`}
                  />
                }
              >
                <Trash2Icon className="size-4" />
              </PopoverTrigger>
              <PopoverPopup side="top" align="end" width="md">
                <div className="flex flex-col gap-3">
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
                  <div className="flex justify-end gap-2">
                    <PopoverClose render={<Button size="sm" variant="ghost" disabled={busy} />}>
                      Cancel
                    </PopoverClose>
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
                  </div>
                </div>
              </PopoverPopup>
            </Popover>
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
