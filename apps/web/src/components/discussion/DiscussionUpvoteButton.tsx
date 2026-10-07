import type { ScopedThreadRef } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ArrowUpIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { discussionEnvironment } from "~/state/discussions";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";

export function DiscussionUpvoteButton({
  threadRef,
  url,
  subjectId,
  count,
  upvoted,
  canUpvote,
}: {
  threadRef: ScopedThreadRef;
  url: string;
  subjectId: string;
  count: number;
  upvoted: boolean;
  canUpvote: boolean;
}) {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const setUpvote = useAtomCommand(discussionEnvironment.setUpvote, { reportFailure: false });
  const toggle = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const result = await setUpvote({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, url, subjectId, upvoted: !upvoted },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "The upvote could not be saved",
          description:
            error instanceof Error ? error.message : "Refresh the discussion and try again.",
        });
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return (
    <button
      type="button"
      aria-label={`${upvoted ? "Remove upvote" : "Upvote"}, ${count}`}
      aria-pressed={upvoted}
      disabled={pending || !canUpvote}
      onClick={() => void toggle()}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60 enabled:hover:border-primary/60",
        upvoted
          ? "border-primary/60 bg-primary/10 text-foreground"
          : "border-border/70 bg-muted/40 text-muted-foreground",
      )}
    >
      <ArrowUpIcon aria-hidden className="size-3.5" />
      <span className="tabular-nums">{count}</span>
    </button>
  );
}
