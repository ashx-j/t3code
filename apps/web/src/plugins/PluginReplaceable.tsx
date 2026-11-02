import { useAtomValue } from "@effect/atom-react";

import { RenderErrorBoundary } from "../components/RenderErrorBoundary";
import { toastManager } from "../components/ui/toast";
import {
  type PluginOwner,
  pluginReplacementAtoms,
  type PluginPartName,
  type PluginPartProps,
  setPluginWebFailure,
} from "./pluginRegistry";

const toastedFailures = new WeakSet<PluginOwner>();

const PART_NAMES: { readonly [Part in PluginPartName]: string } = {
  "composer.controls": "the composer's controls",
  "message.assistant": "agent messages",
  "message.user": "your messages",
  "timeline.item": "work details",
  "diff.view": "diffs",
  "app.pageFrame": "Settings and Usage",
  "app.sidebar": "the sidebar",
};

// Shown on the plugin's row until it reloads, and once as a toast, since T3's own part quietly
// takes its place.
const reportFailure = (part: PluginPartName, owner: PluginOwner, error: unknown) => {
  const reason = error instanceof Error ? error.message : String(error);
  const message = `Its version of ${PART_NAMES[part]} (${part}) stopped with an error: ${reason}. T3 shows its own until the plugin reloads.`;
  setPluginWebFailure(owner.environmentId, owner.pluginId, message);
  owner.report?.(message);
  if (toastedFailures.has(owner)) return;
  toastedFailures.add(owner);
  toastManager.add({
    type: "error",
    title: `${owner.pluginName} stopped changing ${PART_NAMES[part]}`,
    description: "T3 shows its own until the plugin reloads.",
  });
};

/**
 * Draws a plugin's version of `part` when one is registered, and T3's `pieces.original`
 * otherwise or when the plugin's throws. Unused pieces are elements that never render.
 */
export function PluginReplaceable<Part extends PluginPartName>(props: {
  readonly part: Part;
  readonly pieces: PluginPartProps<Part>;
}) {
  const replacement = useAtomValue(pluginReplacementAtoms[props.part]);
  if (replacement === undefined) return props.pieces.original;
  const Replacement = replacement.component;
  return (
    <RenderErrorBoundary
      resetKeys={[replacement]}
      fallback={props.pieces.original}
      onError={(error) => reportFailure(props.part, replacement, error)}
    >
      <Replacement {...props.pieces} />
    </RenderErrorBoundary>
  );
}
