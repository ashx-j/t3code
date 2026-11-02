import { useAtomValue } from "@effect/atom-react";

import { RenderErrorBoundary } from "../components/RenderErrorBoundary";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { SidebarInset } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { pluginPageAtom, pluginPageKey } from "./pluginRegistry";

const unavailable = (
  <p className="p-6 text-muted-foreground text-sm">
    This page is not available. Its plugin may be turned off or still loading.
  </p>
);

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
          <RenderErrorBoundary resetKeys={[page]} fallback={unavailable}>
            <Page />
          </RenderErrorBoundary>
        ) : (
          unavailable
        )}
      </div>
    </SidebarInset>
  );
}
