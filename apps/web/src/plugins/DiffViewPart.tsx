import { useAtomValue } from "@effect/atom-react";
import type { ReactNode } from "react";

import { pluginUiAtom } from "./pluginUi";

/**
 * The diff panel's file diffs, which a plugin may draw its own way through the `diff.view` part.
 * A wrapper of its own so `DiffPanel` keeps upstream's layout.
 */
export function DiffViewPart(props: {
  readonly patch: string | null;
  readonly children: ReactNode;
}) {
  const pluginUi = useAtomValue(pluginUiAtom);
  const original = <div className="flex min-h-0 flex-1 overflow-hidden">{props.children}</div>;
  if (pluginUi === null) return original;
  return <pluginUi.PluginReplaceable part="diff.view" pieces={{ original, patch: props.patch }} />;
}
