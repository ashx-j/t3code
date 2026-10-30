import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { RenderErrorBoundary } from "../components/RenderErrorBoundary";
import { pluginToolRendererAtom, pluginToolRendererKey } from "./pluginRegistry";

/**
 * A plugin MCP tool call's details, drawn by the plugin when it registered a renderer for the
 * tool and by `fallback` otherwise. Only `plg_` tools mount this, so other rows read no registry.
 */
export function PluginToolBody(props: {
  readonly environmentId: EnvironmentId;
  readonly toolName: string;
  readonly input: unknown;
  readonly output: string | null;
  readonly status: string;
  readonly fallback: ReactNode;
}) {
  const renderer = useAtomValue(
    pluginToolRendererAtom(pluginToolRendererKey(props.environmentId, props.toolName)),
  );
  if (renderer === undefined) return props.fallback;
  const Renderer = renderer.component;
  return (
    <RenderErrorBoundary resetKeys={[renderer]} fallback={props.fallback}>
      <Renderer input={props.input} output={props.output} status={props.status} />
    </RenderErrorBoundary>
  );
}
