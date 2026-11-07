import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PluginState } from "@t3tools/contracts";
import { FolderDownIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "../../../lib/utils";
import { uploadPluginFolder } from "../../../plugins/pluginFiles";
import { type PluginFolder, pickedFolder } from "../../../plugins/pluginFolders";
import { pluginEnvironment } from "../../../state/plugins";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import type { PluginTarget } from "./pluginTargets";

export function AddPluginButton(props: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  const canInstall = useAtomValue(
    pluginEnvironment.createPluginUploadUrl.permissionAtom(props.environmentId),
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
 * Installs plugins on `targets`, the first one first. A plugin without server code only changes the
 * app, so it is installed on the first one only, and does nothing unless the app loads plugin UI
 * from there.
 */
export function usePluginInstaller(
  targets: ReadonlyArray<PluginTarget>,
  uiSource: { readonly environmentIds: ReadonlyArray<EnvironmentId> },
) {
  const [installing, setInstalling] = useState<string | null>(null);
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);

  const installOnTargets = async (
    install: (environmentId: EnvironmentId) => Promise<PluginState>,
    report: (problem: string) => void,
  ) => {
    const [main, ...others] = targets;
    if (main === undefined) return report("No environment here can run plugins.");
    const reportFailure = (target: PluginTarget, error: unknown) => {
      const message = error instanceof Error ? error.message : "Could not install the plugin.";
      report(targets.length > 1 ? `${target.label}: ${message}` : message);
    };
    const plugin = await install(main.environmentId).catch((error: unknown) => {
      reportFailure(main, error);
      return null;
    });
    if (plugin === null) return;
    if (!plugin.hasServer) {
      // Such as when that environment is offline and another one came first.
      if (!uiSource.environmentIds.includes(main.environmentId)) {
        report(
          `${plugin.name} only changes the app, and this app doesn't load plugin UI from ${main.label}, so it does nothing there.`,
        );
      }
      return;
    }
    const results = await Promise.allSettled(others.map((target) => install(target.environmentId)));
    results.forEach((result, index) => {
      if (result.status === "rejected") reportFailure(others[index]!, result.reason);
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
            (environmentId) => uploadPluginFolder(environmentId, files),
            report,
          );
        }
      });
    },
  };
}

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
  const folderInput = useRef<HTMLInputElement>(null);
  const busy = installer.installing !== null;
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
          <InstallProblems problems={installer.problems} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
