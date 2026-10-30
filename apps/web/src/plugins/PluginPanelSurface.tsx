import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { PuzzleIcon } from "lucide-react";

import { RenderErrorBoundary } from "../components/RenderErrorBoundary";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { pluginRightPanelAtom, pluginRightPanelKey } from "./pluginRegistry";

function PluginPanelNotice(props: {
  readonly title: string;
  readonly description: string;
  readonly onClose: () => void;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PuzzleIcon />
        </EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" variant="outline" onClick={props.onClose}>
          Close
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/** A right panel registered by a web plugin, or a notice when that plugin is not loaded. */
export function PluginPanelSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly pluginId: string;
  readonly panel: string;
  readonly onClose: () => void;
}) {
  const entry = useAtomValue(
    pluginRightPanelAtom(pluginRightPanelKey(props.environmentId, props.pluginId, props.panel)),
  );
  if (entry === undefined) {
    return (
      <PluginPanelNotice
        title="Plugin not active"
        description={`${props.pluginId} is disabled or not loaded, so its "${props.panel}" panel is unavailable.`}
        onClose={props.onClose}
      />
    );
  }
  const Panel = entry.component;
  return (
    <RenderErrorBoundary
      resetKeys={[entry]}
      fallback={
        <PluginPanelNotice
          title="Plugin panel failed"
          description={`${entry.title} from ${props.pluginId} stopped with an error.`}
          onClose={props.onClose}
        />
      }
    >
      <Panel threadId={props.threadId} />
    </RenderErrorBoundary>
  );
}
