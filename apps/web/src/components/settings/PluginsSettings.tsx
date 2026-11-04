import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { pluginSettingsForm } from "@t3tools/client-runtime/plugins/settings-form";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PluginInstallSource, PluginState } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import type * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  DownloadIcon,
  FolderDownIcon,
  BlocksIcon,
  RotateCwIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import {
  type DragEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { cn } from "../../lib/utils";
import { droppedFolders, type PluginFolder, pickedFolder } from "../../plugins/pluginFolders";
import { type EnvironmentPresentation, usePrimaryEnvironmentId } from "../../state/environments";
import {
  pluginContributionKey,
  pluginSettingsPanelAtom,
  type PluginSettingsPanelEntry,
  pluginWebFailureAtom,
} from "../../plugins/pluginRegistry";
import { pluginEnvironment } from "../../state/plugins";
import { PluginRenderBoundary } from "../../plugins/PluginRenderBoundary";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
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
        <SettingsSection title="Plugins">
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
  return <PluginsPage environments={shown} />;
}

const runsPlugins = (environment: EnvironmentPresentation) =>
  environment.connection.phase === "connected" &&
  environment.serverConfig?.environment.capabilities.plugins === true;

interface PluginTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** A plugin as one environment in view has it. */
interface PluginCopy extends PluginTarget {
  readonly plugin: PluginState;
}

const NO_INSTALL_PERMISSION = Atom.make(false);

/** Lists the plugins in view. Plugin folders dropped anywhere on it are installed. */
function PluginsPage({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  // Labels tell apart environments with the same name, as the scope picker does.
  const labelOf = (environment: EnvironmentPresentation) =>
    settingsScopeEnvironmentLabel(environment, environments);
  const targets = environments.filter(runsPlugins).map((environment): PluginTarget => ({
    environmentId: environment.environmentId,
    label: labelOf(environment),
  }));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const installer = usePluginInstaller(targets, primaryEnvironmentId);
  const [adding, setAdding] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [main] = targets;
  const canInstall = useAtomValue(
    main === undefined
      ? NO_INSTALL_PERMISSION
      : pluginEnvironment.installPluginFiles.permissionAtom(main.environmentId),
  );
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
          setDragActive(canInstall);
        }}
        onDragOver={(event) => {
          if (!isFileDrag(event)) return;
          // Taken even without permission, so the browser doesn't open the folder instead.
          event.preventDefault();
          event.dataTransfer.dropEffect = canInstall ? "copy" : "none";
          setDragActive(canInstall);
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
          if (!canInstall) return;
          void installer
            .installFolders(droppedFolders(event.dataTransfer))
            .then((installed) => installed && setAdding(false));
        }}
      >
        {main === undefined ? (
          <SettingsSection title="Plugins">
            <PluginsUnavailable environments={environments} />
          </SettingsSection>
        ) : (
          <PluginList main={main} targets={targets}>
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
          </PluginList>
        )}
        {main === undefined ? null : (
          <AddPluginDialog
            open={adding}
            onOpenChange={setAdding}
            installer={installer}
            dragActive={dragActive}
            scopeNote={
              main.environmentId !== primaryEnvironmentId
                ? `Installs on ${targets.length > 1 ? "every environment here that runs plugins" : main.label}. ${main.label} isn't your main environment, and the app shows plugin changes only from that one, so a plugin with no server code or agent skills does nothing here.`
                : targets.length > 1
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
  targets: ReadonlyArray<PluginTarget>,
  primaryEnvironmentId: EnvironmentId | null,
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
      target: PluginTarget,
      result: { readonly cause: Cause.Cause<unknown> },
    ) => {
      const error = squashAtomCommandFailure(result);
      const message = error instanceof Error ? error.message : "Could not install the plugin.";
      report(targets.length > 1 ? `${target.label}: ${message}` : message);
    };
    const first = await install(main.environmentId);
    if (first._tag === "Failure") return reportFailure(main, first);
    const { plugin } = first.value;
    if (!plugin.hasServer && plugin.hasSkills !== true) {
      // Such as when the main environment is offline and another one came first.
      if (main.environmentId !== primaryEnvironmentId) {
        report(
          `${plugin.name} only changes the app, and this app shows plugin changes only from your main environment, so it does nothing on ${main.label}.`,
        );
      }
      return;
    }
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
    installFolders: (folders: ReadonlyArray<PluginFolder>) => {
      // Outside `run`, which would end the install in progress as far as the page can tell.
      if (installing !== null) {
        setProblems([`${installing} is still installing. Add more once it's done.`]);
        return Promise.resolve(false);
      }
      return run(async (report) => {
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
      });
    },
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

function PluginsUnavailable({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const [only, ...others] = environments;
  if (only === undefined || others.length > 0) {
    return (
      <SettingsRow
        title="Plugins are not available"
        description="None of these environments runs a T3 Code server with plugin support."
      />
    );
  }
  if (only.connection.phase !== "connected" || only.serverConfig === null) {
    return (
      <SettingsRow
        title="Environment disconnected"
        description={`Reconnect ${only.label} to manage its plugins.`}
      />
    );
  }
  return (
    <SettingsRow
      title="Plugins are not available"
      description={`${only.label} runs a T3 Code server without plugin support.`}
    />
  );
}

// Keyed by the JSON list of environment ids, so one value holds every environment's plugins.
const pluginListsAtom = Atom.family((environmentIdsKey: string) => {
  const environmentIds = JSON.parse(environmentIdsKey) as ReadonlyArray<EnvironmentId>;
  return Atom.make((get) =>
    environmentIds.map((environmentId) =>
      get(pluginEnvironment.pluginsLive({ environmentId, input: {} })),
    ),
  ).pipe(Atom.withLabel(`web-plugin-lists:${environmentIdsKey}`));
});

/**
 * Copies of a plugin on different environments share a row. A copy that failed discovery keeps its
 * own. One that another copy with its id shadows is `shadowed`: actions send only the id, so they
 * would reach the copy that is used instead.
 */
function pluginRows(copies: ReadonlyArray<PluginCopy>) {
  const rows = new Map<
    string,
    { readonly first: PluginCopy; readonly copies: Array<PluginCopy>; readonly shadowed: boolean }
  >();
  copies.forEach((copy, index) => {
    const failedDiscovery = copy.plugin.failure?.stage === "discovery";
    const key = failedDiscovery
      ? `${copy.environmentId}:${index}`
      : `${copy.plugin.id}:${copy.plugin.source}`;
    const shadowed =
      failedDiscovery &&
      copies.some(
        (other) =>
          other !== copy &&
          other.environmentId === copy.environmentId &&
          other.plugin.id === copy.plugin.id,
      );
    const row = rows.get(key);
    if (row === undefined) rows.set(key, { first: copy, copies: [copy], shadowed });
    else row.copies.push(copy);
  });
  return Array.from(rows, ([key, row]) => ({ key, ...row }));
}

const fromGitOrNpm = (copy: PluginCopy) =>
  copy.plugin.installSource !== undefined && copy.plugin.installSource.type !== "path";

/**
 * The page's own settings, with `children` first, then each plugin once, however many of `targets`
 * have it. Actions on a row apply to every copy. `main` comes first in `targets` and decides which
 * actions are offered.
 */
function PluginList({
  main,
  targets,
  children,
}: {
  readonly main: PluginTarget;
  readonly targets: ReadonlyArray<PluginTarget>;
  readonly children: ReactNode;
}) {
  const lists = useAtomValue(
    pluginListsAtom(JSON.stringify(targets.map((target) => target.environmentId))),
  );
  const several = targets.length > 1;
  const loaded = targets.map((target, index) => {
    const result = lists[index] ?? AsyncResult.initial(true);
    return {
      target,
      plugins: AsyncResult.getOrElse(result, () => null)?.plugins ?? null,
      error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    };
  });
  const copies = loaded.flatMap(({ target, plugins }) =>
    (plugins ?? []).map((plugin): PluginCopy => ({ ...target, plugin })),
  );
  const rows = pluginRows(copies);
  const errors = loaded.flatMap(({ target, error }) =>
    error === null ? [] : [several ? `${target.label}: ${error}` : error],
  );
  const updatable = copies.filter(fromGitOrNpm);
  const agentTools = loaded.flatMap(({ target }, index) => {
    const value = AsyncResult.getOrElse(
      lists[index] ?? AsyncResult.initial(true),
      () => null,
    )?.agentTools;
    // Servers from before the switch leave it out.
    return value === undefined ? [] : [{ environmentId: target.environmentId, value }];
  });
  return (
    <>
      <SettingsSection title="Plugins">
        {children}
        {agentTools.length === 0 ? null : (
          <AgentToolsRow environmentId={main.environmentId} environments={agentTools} />
        )}
        {updatable.length === 0 ? null : (
          <CheckPluginUpdates environmentId={main.environmentId} copies={updatable} />
        )}
      </SettingsSection>
      {targets.map((target) => (
        <ScanPluginsFolder key={target.environmentId} environmentId={target.environmentId} />
      ))}
      <SettingsSection title="Installed plugins">
        {errors.map((error) => (
          <SettingsRow key={error} title="Could not load plugins" description={error} />
        ))}
        {loaded.every(({ plugins, error }) => plugins === null && error === null) ? (
          <SettingsRow title="Loading plugins…" role="status" />
        ) : rows.length === 0 && errors.length === 0 ? (
          <SettingsRow
            title="No plugins installed"
            description="Drop a plugin folder on this page to add it."
          />
        ) : (
          rows.map((row) => (
            <PluginRow
              key={row.key}
              environmentId={main.environmentId}
              first={row.first}
              copies={row.copies}
              shadowed={row.shadowed}
              labelled={several}
            />
          ))
        )}
      </SettingsSection>
    </>
  );
}

/** Has the server look at its plugins folder again, so folders copied there by hand are listed. */
function ScanPluginsFolder({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const canRescan = useAtomValue(pluginEnvironment.rescanPlugins.permissionAtom(environmentId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The server reads its plugins folder only when asked, so opening the page asks it.
  useEffect(() => {
    if (!canRescan) return;
    void runAtomCommand(
      registry,
      pluginEnvironment.rescanPlugins,
      { environmentId, input: {} },
      { label: "plugin folder scan", reportFailure: false, reportDefect: false },
    );
  }, [registry, environmentId, canRescan]);
  return null;
}

/** Checks plugins installed from git or npm now; the server also checks once a day. */
function CheckPluginUpdates({
  environmentId,
  copies,
}: {
  readonly environmentId: EnvironmentId;
  /** Plugins installed from git or npm. */
  readonly copies: ReadonlyArray<PluginCopy>;
}) {
  const canCheck = useAtomValue(pluginEnvironment.checkPluginUpdates.permissionAtom(environmentId));
  const canUpdate = useAtomValue(pluginEnvironment.updatePlugin.permissionAtom(environmentId));
  const check = useAtomCommand(pluginEnvironment.checkPluginUpdates, "plugin update check");
  const update = useAtomCommand(pluginEnvironment.updatePlugin, "plugin update");
  const [busy, setBusy] = useState<"checking" | "updating" | null>(null);
  const [checked, setChecked] = useState(false);
  const outdated = copies.filter((copy) => copy.plugin.availableUpdate !== undefined);
  const updates = new Set(outdated.map((copy) => copy.plugin.id)).size;
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
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || !canCheck}
            onClick={async () => {
              setBusy("checking");
              const results = await Promise.all(
                [...new Set(copies.map((copy) => copy.environmentId))].map((target) =>
                  check({ environmentId: target, input: {} }),
                ),
              );
              setBusy(null);
              setChecked(results.every((result) => result._tag === "Success"));
            }}
          >
            {busy === "checking" ? "Checking…" : "Check for updates"}
          </Button>
          {updates > 0 ? (
            <Button
              size="sm"
              disabled={busy !== null || !canUpdate}
              onClick={async () => {
                setBusy("updating");
                await Promise.all(
                  outdated.map((copy) =>
                    update({
                      environmentId: copy.environmentId,
                      input: { pluginId: copy.plugin.id },
                    }),
                  ),
                );
                setBusy(null);
              }}
            >
              {busy === "updating" ? "Updating…" : "Update all"}
            </Button>
          ) : null}
        </div>
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
                  : "Exact version, such as 1.2.3 (optional, latest by default)"}
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
  first,
  copies,
  shadowed,
  labelled,
}: {
  /** The main environment in view. Its permissions decide which actions are offered. */
  readonly environmentId: EnvironmentId;
  readonly first: PluginCopy;
  readonly copies: ReadonlyArray<PluginCopy>;
  /** Another copy of this plugin is used instead, so the row only explains why. */
  readonly shadowed: boolean;
  /** Problems name their environment, because several are in view. */
  readonly labelled: boolean;
}) {
  const { plugin } = first;
  const canManage = useAtomValue(pluginEnvironment.setPluginEnabled.permissionAtom(environmentId));
  const setEnabled = useAtomCommand(pluginEnvironment.setPluginEnabled, "plugin enabled");
  const reload = useAtomCommand(pluginEnvironment.reloadPlugin, "plugin reload");
  const uninstall = useAtomCommand(pluginEnvironment.uninstallPlugin, "plugin removal");
  const update = useAtomCommand(pluginEnvironment.updatePlugin, "plugin update");
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Plugin UI loads from the main environment only, so its settings panel and web failure do too.
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
  const updatable = copies.filter((copy) => copy.plugin.installSource !== undefined);
  // A plugin an agent linked from its own folder is unlinked instead; the folder stays.
  const removeLabel = copies.every((copy) => copy.plugin.source === "dev") ? "Unlink" : "Remove";
  // Only a shadowed link can be dropped on its own, by its folder; see `pluginRows`.
  const shadowedLink = shadowed && plugin.source === "dev" ? plugin.linkedFolder : undefined;
  const source = updatable[0]?.plugin.installSource;
  const availableUpdate = copies.find((copy) => copy.plugin.availableUpdate !== undefined)?.plugin
    .availableUpdate;
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
        availableUpdate === undefined && problems.length === 0 ? undefined : (
          <div className="flex flex-wrap items-center gap-2">
            {availableUpdate === undefined ? null : (
              <Badge variant="info">Update available: {updateLabel(availableUpdate.version)}</Badge>
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
                <SlidersHorizontalIcon className="size-4" />
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
            {source === undefined ? null : (
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={busy || !canManage}
                aria-label={`Update ${plugin.name}`}
                title={
                  availableUpdate === undefined
                    ? `Update from ${installSourceLabel(source)}`
                    : `Update to ${updateLabel(availableUpdate.version)} from ${installSourceLabel(source)}`
                }
                onClick={() =>
                  void runOn(updatable, (copy) =>
                    update({ environmentId: copy.environmentId, input: { pluginId: plugin.id } }),
                  )
                }
              >
                <DownloadIcon className="size-4" />
              </Button>
            )}
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
    >
      {settingsOpen ? (
        <PluginSettingsPanel
          first={first}
          copies={copies}
          labelled={labelled}
          customSettings={customSettings}
          hasGeneratedForm={hasGeneratedForm}
        />
      ) : null}
    </SettingsRow>
  );
}

/** A plugin's settings under its row: the plugin's own panel, or the generated form. */
function PluginSettingsPanel({
  first,
  copies,
  labelled,
  customSettings,
  hasGeneratedForm,
}: {
  readonly first: PluginCopy;
  readonly copies: ReadonlyArray<PluginCopy>;
  readonly labelled: boolean;
  readonly customSettings: PluginSettingsPanelEntry | undefined;
  readonly hasGeneratedForm: boolean;
}) {
  return (
    <div className="mt-3 mb-2 space-y-3 rounded-lg border border-border/60 bg-muted/30 p-3 sm:p-4">
      {customSettings === undefined ? (
        <PluginSettingsEditor first={first} copies={copies} labelled={labelled} />
      ) : (
        <>
          <PluginCustomSettings entry={customSettings} />
          {/* The plugin's own panel talks to the main environment's copy alone. */}
          {copies.length > 1 ? (
            <>
              <p className="text-xs text-muted-foreground">
                {hasGeneratedForm
                  ? `This panel changes ${first.label} only. The form below changes every environment.`
                  : `This panel changes ${first.label} only.`}
              </p>
              {hasGeneratedForm ? (
                <PluginSettingsEditor first={first} copies={copies} labelled={labelled} />
              ) : null}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Whether agents get the tools that list, install, check and change plugins. Until the user picks,
 * they follow whether the environment has a plugin.
 */
function AgentToolsRow(props: {
  readonly environmentId: EnvironmentId;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly value: boolean;
  }>;
}) {
  const canChange = useAtomValue(
    pluginEnvironment.setAgentTools.permissionAtom(props.environmentId),
  );
  const setAgentTools = useAtomCommand(pluginEnvironment.setAgentTools, "plugin tools for agents");
  const [busy, setBusy] = useState(false);
  return (
    <SettingsRow
      title="Plugin tools for agents"
      description="Lets agents list, install, check and change plugins. Changing them still needs a thread set to Full access."
      control={
        <Switch
          checked={props.environments.every((environment) => environment.value)}
          disabled={busy || !canChange}
          aria-label="Plugin tools for agents"
          onCheckedChange={(enabled) => {
            setBusy(true);
            void Promise.all(
              props.environments.map((environment) =>
                setAgentTools({ environmentId: environment.environmentId, input: { enabled } }),
              ),
            ).finally(() => setBusy(false));
          }}
        />
      }
    />
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

/** A settings panel the plugin's web bundle drew instead of the generated form. */
function PluginCustomSettings(props: { readonly entry: PluginSettingsPanelEntry }) {
  const Panel = props.entry.component;
  return (
    <PluginRenderBoundary
      owner={props.entry.owner}
      what="Its settings panel"
      resetKeys={[props.entry]}
      fallback={
        <p className="text-xs text-destructive">
          This plugin's settings panel stopped with an error.
        </p>
      }
    >
      <Panel />
    </PluginRenderBoundary>
  );
}

/** Shows the first copy's settings. Saving writes the same change to every copy. */
function PluginSettingsEditor({
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
  if (query.error) return <p className="text-xs text-destructive">{query.error}</p>;
  if (!query.data) return <p className="text-xs text-muted-foreground">Loading settings…</p>;
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
