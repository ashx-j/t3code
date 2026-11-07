import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PluginInstallSource } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { FolderDownIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "../../../lib/utils";
import { type PluginFolder, pickedFolder } from "../../../plugins/pluginFolders";
import { pluginEnvironment } from "../../../state/plugins";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { installSourceLabel, type PluginTarget } from "./pluginTargets";

export function AddPluginButton(props: {
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

export function InstallProblems({ problems }: { readonly problems: ReadonlyArray<string> }) {
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
 * Installs plugins on `targets`, the first one first. The app draws plugin UI only from
 * `uiSource`, so a plugin without server code changes nothing on the others and is installed on
 * the first one only.
 */
export function usePluginInstaller(
  targets: ReadonlyArray<PluginTarget>,
  uiSource: { readonly environmentId: EnvironmentId | null; readonly name: string },
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
    if (!plugin.hasServer) {
      // Such as when that environment is offline and another one came first.
      if (main.environmentId !== uiSource.environmentId) {
        report(
          `${plugin.name} only changes the app, and this app shows plugin changes only from ${uiSource.name}, so it does nothing on ${main.label}.`,
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

const INSTALL_SOURCES = {
  git: { label: "Git repository", placeholder: "https://github.com/me/my-plugin.git" },
  npm: { label: "npm package", placeholder: "t3-plugin-example" },
} as const;

export function AddPluginDialog({
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
