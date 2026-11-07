import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { PluginRenderBoundary } from "./PluginRenderBoundary";
import { pluginToolRendererAtom, pluginToolRendererKey } from "./pluginRegistry";
import { pluginToolNameOf } from "./pluginUi";

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
  const toolName = pluginToolNameOf(props.toolName) ?? props.toolName;
  const renderer = useAtomValue(
    pluginToolRendererAtom(pluginToolRendererKey(props.environmentId, toolName)),
  );
  if (renderer === undefined) return props.fallback;
  const Renderer = renderer.component;
  return (
    <PluginRenderBoundary
      owner={renderer.owner}
      what={`Its view of the ${toolName} tool`}
      resetKeys={[renderer]}
      fallback={props.fallback}
    >
      <Renderer input={props.input} output={props.output} status={props.status} />
    </PluginRenderBoundary>
  );
}
