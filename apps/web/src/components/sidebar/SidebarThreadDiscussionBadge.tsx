import type { ThreadDiscussionLink } from "@t3tools/contracts";
import type { MouseEvent } from "react";
import { GitHubDiscussionIcon } from "../Icons";
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarThreadDiscussionBadge({
  discussion,
  iconOnly = false,
  tooltipHidden = false,
  onOpen,
}: {
  discussion: ThreadDiscussionLink;
  iconOnly?: boolean;
  tooltipHidden?: boolean;
  onOpen: (event: MouseEvent<HTMLElement>, url: string) => void;
}) {
  const label = `Discussion #${discussion.number}${discussion.title ? `: ${discussion.title}` : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <InlineButton
            tone="muted"
            render={<a href={discussion.url} target="_blank" rel="noopener noreferrer" />}
            aria-label={label}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => onOpen(event, discussion.url)}
          />
        }
      >
        <span className="contents font-normal text-xs tabular-nums">
          <GitHubDiscussionIcon className="size-3 shrink-0" />
          {iconOnly ? null : <span className="min-w-0 truncate">#{discussion.number}</span>}
        </span>
      </TooltipTrigger>
      {!tooltipHidden ? (
        <TooltipPopup side="top" sideOffset={0} variant="glass">
          <div>{label}</div>
          <div className="text-muted-foreground">{discussion.repository}</div>
        </TooltipPopup>
      ) : null}
    </Tooltip>
  );
}
