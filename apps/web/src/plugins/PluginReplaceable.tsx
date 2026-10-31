import { useAtomValue } from "@effect/atom-react";
import type { ReactNode } from "react";

import { RenderErrorBoundary } from "../components/RenderErrorBoundary";
import {
  pluginReplacementAtoms,
  type PluginPartName,
  type PluginPartProps,
} from "./pluginRegistry";

/**
 * Draws a plugin's version of `part` when one is registered, and T3's `original` otherwise or
 * when the plugin's throws. `pieces` runs only while a plugin replaces the part.
 */
export function PluginReplaceable<Part extends PluginPartName>(props: {
  readonly part: Part;
  readonly original: ReactNode;
  readonly pieces: () => PluginPartProps<Part>;
}) {
  const replacement = useAtomValue(pluginReplacementAtoms[props.part]);
  if (replacement === undefined) return props.original;
  const Replacement = replacement.component;
  return (
    <RenderErrorBoundary resetKeys={[replacement]} fallback={props.original}>
      <Replacement {...props.pieces()} />
    </RenderErrorBoundary>
  );
}
