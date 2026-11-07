import { useAtomValue } from "@effect/atom-react";
import type { ReactNode } from "react";

import { PluginRenderBoundary } from "./PluginRenderBoundary";
import { pluginCodeBlockRenderersAtom } from "./pluginRegistry";

/** A closed chat code fence, drawn by the plugin that claimed its language and by `fallback` otherwise. */
export function PluginCodeBlock(props: {
  readonly language: string;
  readonly code: string;
  readonly fallback: ReactNode;
}) {
  const entry = useAtomValue(pluginCodeBlockRenderersAtom).get(props.language);
  if (entry === undefined) return props.fallback;
  const Renderer = entry.component;
  return (
    <PluginRenderBoundary
      owner={entry.owner}
      what={`Its view of ${props.language} code blocks`}
      resetKeys={[props.code, entry]}
      fallback={props.fallback}
    >
      <Renderer code={props.code} />
    </PluginRenderBoundary>
  );
}
