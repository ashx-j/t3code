import type { GitHubDiscussionDetail, ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { MessageSquareIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { openUrlInPreview } from "~/browser/openFileInPreview";
import { discussionEnvironment } from "~/state/discussions";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import {
  PullRequestMarkdown,
  PullRequestMarkdownContext,
} from "../pullRequest/PullRequestMarkdown";
import { PullRequestActorLabel } from "../pullRequest/pullRequestPresentation";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { cn } from "~/lib/utils";

type DiscussionPost = Pick<GitHubDiscussionDetail, "url" | "body" | "author" | "createdAt">;

function DiscussionPost({
  post,
  threadRef,
  cwd,
  selected,
}: {
  post: DiscussionPost;
  threadRef: ScopedThreadRef;
  cwd: string;
  selected: boolean;
}) {
  const anchor = new URL(post.url).hash.slice(1);
  return (
    <article
      id={anchor || undefined}
      tabIndex={-1}
      data-discussion-comment={anchor || undefined}
      className={cn(
        "min-w-0 scroll-mt-4 rounded-lg border border-border/70 bg-card/40 p-4 outline-none",
        selected && "border-primary/40 bg-primary/5",
      )}
    >
      <div className="mb-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <PullRequestActorLabel
          actor={post.author ? { ...post.author, name: null } : null}
          profileUrl={post.author?.url ?? null}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <a
                href={post.url}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground"
              />
            }
          >
            <time dateTime={post.createdAt}>{formatRelativeTimeLabel(post.createdAt)}</time>
          </TooltipTrigger>
          <TooltipPopup>{new Date(post.createdAt).toLocaleString()}</TooltipPopup>
        </Tooltip>
      </div>
      {post.body.trim() ? (
        <PullRequestMarkdown
          text={post.body}
          cwd={cwd}
          environmentId={threadRef.environmentId}
          threadRef={threadRef}
        />
      ) : (
        <p className="text-sm text-muted-foreground">No text.</p>
      )}
    </article>
  );
}

/** Experimental read-only discussion view, kept separate from the PR workflow. */
export function DiscussionDetailPanel({
  threadRef,
  url,
  cwd,
  supported,
}: {
  threadRef: ScopedThreadRef;
  url: string;
  cwd: string;
  supported: boolean;
}) {
  const query = useEnvironmentQuery(
    supported
      ? discussionEnvironment.detailQuery({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, url },
        })
      : null,
  );
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const contentRef = useRef<HTMLDivElement>(null);
  const focusedAnchor = useRef<string | null>(null);
  const anchor = new URL(url).hash.slice(1);
  const detail = query.data;
  useEffect(() => {
    if (!detail || !anchor || focusedAnchor.current === anchor) return;
    const comment = [
      ...(contentRef.current?.querySelectorAll<HTMLElement>("[data-discussion-comment]") ?? []),
    ].find((element) => element.dataset.discussionComment === anchor);
    if (!comment) return;
    focusedAnchor.current = anchor;
    comment.scrollIntoView({ block: "center" });
    comment.focus({ preventScroll: true });
  }, [anchor, detail]);
  const openBrowser = () => {
    void openUrlInPreview({ threadRef, url, openPreview }).then((result) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open Browser",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-discussion-panel>
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5 text-xs">
        <MessageSquareIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Discussion{detail ? ` #${detail.number}` : ""}</span>
        <Badge size="sm" variant="secondary">
          Experimental
        </Badge>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="xs"
          render={
            <a
              href={url}
              onClick={(event) => {
                if (event.ctrlKey || event.metaKey) return;
                event.preventDefault();
                openBrowser();
              }}
            />
          }
        >
          Open in Browser
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Refresh discussion"
          disabled={!supported || query.isPending}
          onClick={query.refresh}
        >
          <RefreshCwIcon />
        </Button>
      </header>
      <ScrollArea className="min-h-0 flex-1" radius="none" scrollFade>
        <div ref={contentRef} className="space-y-4 p-4">
          {!supported || query.error ? (
            <p role="alert" className="text-sm text-muted-foreground">
              {query.error ??
                "Update this environment's server to read discussions here. You can still open this conversation in Browser."}
            </p>
          ) : null}
          {!detail && supported && !query.error ? (
            <p className="text-sm text-muted-foreground">Loading discussion...</p>
          ) : null}
          {detail ? (
            <PullRequestMarkdownContext
              value={{
                repositoryUrl:
                  new URL(detail.url).origin +
                  new URL(detail.url).pathname.split("/").slice(0, 3).join("/"),
                threadRef,
              }}
            >
              <div className="space-y-2">
                <h2 className="text-lg font-semibold leading-snug wrap-anywhere">{detail.title}</h2>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {detail.category ? <span>{detail.category.name}</span> : null}
                  <span>{detail.isAnswered ? "Answered" : detail.closed ? "Closed" : "Open"}</span>
                  <span>
                    {detail.comments.length} {detail.comments.length === 1 ? "comment" : "comments"}
                  </span>
                </div>
              </div>
              <DiscussionPost post={detail} threadRef={threadRef} cwd={cwd} selected={false} />
              {detail.comments.map((comment) => (
                <div key={comment.id} className="space-y-2">
                  <DiscussionPost
                    post={comment}
                    threadRef={threadRef}
                    cwd={cwd}
                    selected={new URL(comment.url).hash.slice(1) === anchor}
                  />
                  {comment.replies.length > 0 ? (
                    <div className="ml-4 space-y-2 border-l border-border/70 pl-3">
                      {comment.replies.map((reply) => (
                        <DiscussionPost
                          key={reply.id}
                          post={reply}
                          threadRef={threadRef}
                          cwd={cwd}
                          selected={new URL(reply.url).hash.slice(1) === anchor}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </PullRequestMarkdownContext>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
