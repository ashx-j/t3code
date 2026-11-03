import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";

import { useNavigateToMainApp } from "../components/sidebar/mainAppLocation";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { PluginRenderBoundary } from "./PluginRenderBoundary";
import { pluginPageAtom, pluginPageKey } from "./pluginRegistry";

function PageUnavailable({ reason }: { readonly reason: string }) {
  const navigateToMainApp = useNavigateToMainApp();
  const navigate = useNavigate();
  return (
    <div className="space-y-3 p-6">
      <p className="text-muted-foreground text-sm">{reason}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => void navigateToMainApp()}>
          Back
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void navigate({ to: "/settings/plugins" })}
        >
          Open Plugins settings
        </Button>
      </div>
    </div>
  );
}

/** A plugin's page at `/plugins/<pluginId>/<name>`, beside the sidebar in place of the thread. */
export function PluginPage(props: { readonly pluginId: string; readonly name: string }) {
  const page = useAtomValue(pluginPageAtom(pluginPageKey(props.pluginId, props.name)));
  const Page = page?.component;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="truncate font-medium text-sm">{page?.title ?? props.name}</h1>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {page && Page ? (
          <PluginRenderBoundary
            owner={page.owner}
            what={`Its page ${page.title}`}
            resetKeys={[page]}
            fallback={
              <PageUnavailable reason="This page stopped with an error. Settings → Plugins shows why." />
            }
          >
            <Page />
          </PluginRenderBoundary>
        ) : (
          <PageUnavailable reason="This page is not available. Its plugin may be turned off or still loading." />
        )}
      </div>
    </SidebarInset>
  );
}
