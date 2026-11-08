import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { FolderDownIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "../../../lib/utils";
import { uploadPluginFolder } from "../../../plugins/pluginFiles";
import { type PluginFolder, pickedFolder } from "../../../plugins/pluginFolders";
import type { EnvironmentPresentation } from "../../../state/environments";
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
import { toastManager } from "../../ui/toast";

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
 * Installs plugins on `environment`. A plugin without server code only changes the app, so it does
 * nothing there unless the app loads plugin UI from it, which `loadsUi` says.
 */
export function usePluginInstaller(
  environment: Pick<EnvironmentPresentation, "environmentId" | "label">,
  loadsUi: boolean,
) {
  const [installing, setInstalling] = useState<string | null>(null);
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);

  // Resolves true when every folder installed with nothing to report.
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
          const plugin = await uploadPluginFolder(environment.environmentId, files).catch(
            (error: unknown) => {
              report(error instanceof Error ? error.message : "Could not install the plugin.");
              return null;
            },
          );
          if (plugin === null) continue;
          if (!plugin.enabled) {
            toastManager.add({
              type: "success",
              title: `Installed ${plugin.name}`,
              description: "Turn it on to run it.",
            });
          }
          if (!plugin.hasServer && !loadsUi) {
            report(
              `${plugin.name} only changes the app, and this app doesn't load plugin UI from ${environment.label}, so it does nothing there.`,
            );
          }
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
