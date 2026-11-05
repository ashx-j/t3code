import type { ReactNode } from "react";

import { PluginReplaceable } from "./PluginReplaceable";

/**
 * The diff panel's file diffs, which a plugin may draw its own way through the `diff.view` part.
 * A wrapper of its own so `DiffPanel` keeps upstream's layout.
 */
export function DiffViewPart(props: {
  readonly patch: string | null;
  readonly children: ReactNode;
}) {
  return (
    <PluginReplaceable
      part="diff.view"
      pieces={{
        original: <div className="flex min-h-0 flex-1 overflow-hidden">{props.children}</div>,
        patch: props.patch,
      }}
    />
  );
}
