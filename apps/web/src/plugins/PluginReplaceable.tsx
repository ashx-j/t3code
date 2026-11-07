import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { PluginRenderBoundary } from "./PluginRenderBoundary";
import {
  pluginReplacementAtoms,
  type PluginPartName,
  type PluginPartProps,
} from "./pluginRegistry";

const PART_NAMES: { readonly [Part in PluginPartName]: string } = {
  "composer.controls": "the composer's controls",
  "message.assistant": "agent messages",
  "message.user": "your messages",
  "timeline.item": "work details",
  "diff.view": "diffs",
};

/**
 * Draws a plugin's version of `part` when the thread environment's plugins registered one, and
 * T3's `pieces.original` otherwise or where the plugin's throws. Unused pieces are elements that
 * never render.
 */
export function PluginReplaceable<Part extends PluginPartName>(props: {
  readonly part: Part;
  readonly environmentId: EnvironmentId | null;
  readonly pieces: PluginPartProps<Part>;
}) {
  const replacement = useAtomValue(pluginReplacementAtoms[props.part](props.environmentId ?? ""));
  if (replacement === undefined) return props.pieces.original;
  const Replacement = replacement.component;
  return (
    <PluginRenderBoundary
      owner={replacement.owner}
      what={`Its version of ${PART_NAMES[props.part]} (${props.part})`}
      resetKeys={[replacement]}
      fallback={props.pieces.original}
    >
      <Replacement {...props.pieces} />
    </PluginRenderBoundary>
  );
}
