import type { ReactNode } from "react";

import { RenderErrorBoundary } from "../components/RenderErrorBoundary";
import { toastManager } from "../components/ui/toast";
import { type PluginOwner, setPluginWebFailure } from "./pluginRegistry";

// Once per plugin start: a part drawn in several places would otherwise report once each.
const reported = new WeakSet<PluginOwner>();

// On the plugin's row in Settings and in a toast, since the fallback quietly takes the plugin's
// place.
const reportRenderFailure = (owner: PluginOwner, what: string, error: unknown) => {
  if (reported.has(owner)) return;
  reported.add(owner);
  const reason = error instanceof Error ? error.message : String(error);
  const message = `${what} stopped with an error: ${reason}`;
  setPluginWebFailure(owner.environmentId, owner.pluginId, message);
  toastManager.add({
    type: "error",
    title: `${owner.pluginName} hit an error`,
    description: `${what} stopped working where it failed, until the plugin reloads.`,
  });
};

/**
 * Draws something a plugin contributed, and `fallback` once it throws. `what` names it for
 * people, such as "Its sidebar section Notes".
 */
export function PluginRenderBoundary(props: {
  readonly owner: PluginOwner;
  readonly what: string;
  readonly fallback: ReactNode;
  readonly resetKeys: ReadonlyArray<unknown>;
  readonly children: ReactNode;
}) {
  return (
    <RenderErrorBoundary
      resetKeys={props.resetKeys}
      fallback={props.fallback}
      onError={(error) => reportRenderFailure(props.owner, props.what, error)}
    >
      {props.children}
    </RenderErrorBoundary>
  );
}
