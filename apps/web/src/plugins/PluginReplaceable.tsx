import { useAtomValue } from "@effect/atom-react";

import { RenderErrorBoundary } from "../components/RenderErrorBoundary";
import {
  pluginReplacementAtoms,
  type PluginPartName,
  type PluginPartProps,
} from "./pluginRegistry";

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
    <RenderErrorBoundary resetKeys={[replacement]} fallback={props.pieces.original}>
      <Replacement {...props.pieces} />
    </RenderErrorBoundary>
  );
}
