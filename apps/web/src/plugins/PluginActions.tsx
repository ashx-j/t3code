import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { BlocksIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { PluginRenderBoundary } from "./PluginRenderBoundary";
import {
  pluginActionAtoms,
  pluginThreadBadgesAtom,
  type PluginActionContexts,
  type PluginActionEntry,
  type PluginActionPlace,
} from "./pluginRegistry";

function PluginActionButton<Place extends PluginActionPlace>(props: {
  readonly entry: PluginActionEntry<Place>;
  readonly context: PluginActionContexts[Place];
  readonly size: "icon-xs" | "icon-sm";
}) {
  const Icon = props.entry.icon ?? BlocksIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size={props.size}
            variant="ghost"
            aria-label={props.entry.title}
            onClick={() => props.entry.run(props.context)}
          />
        }
      >
        <PluginRenderBoundary
          owner={props.entry.owner}
          what={`Its icon for ${props.entry.title}`}
          resetKeys={[Icon]}
          fallback={<BlocksIcon />}
        >
          <Icon />
        </PluginRenderBoundary>
      </TooltipTrigger>
      <TooltipPopup side="top">{props.entry.title}</TooltipPopup>
    </Tooltip>
  );
}

/** Plugin buttons for one place; nothing at all while no plugin added any. */
export function PluginActionButtons<Place extends PluginActionPlace>(props: {
  readonly place: Place;
  readonly environmentId: EnvironmentId;
  readonly context: PluginActionContexts[Place];
  readonly size?: "icon-xs" | "icon-sm";
  readonly className?: string;
}) {
  const entries = useAtomValue(pluginActionAtoms[props.place](props.environmentId));
  if (entries.length === 0) return null;
  return (
    <span className={cn("flex shrink-0 items-center gap-0.5", props.className)}>
      {entries.map((entry) => (
        <PluginActionButton
          key={entry.key}
          entry={entry}
          context={props.context}
          size={props.size ?? "icon-xs"}
        />
      ))}
    </span>
  );
}

/** Badges plugins set on a thread, for its sidebar row and header. */
export function PluginThreadBadges(props: { readonly threadKey: string }) {
  const badges = useAtomValue(pluginThreadBadgesAtom(props.threadKey));
  if (badges.length === 0) return null;
  return badges.map((badge) => (
    <Badge key={badge.pluginId} variant={badge.tone} size="sm">
      {badge.label}
    </Badge>
  ));
}
