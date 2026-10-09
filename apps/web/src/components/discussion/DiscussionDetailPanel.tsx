import { useAtomValue } from "@effect/atom-react";
import type {
  GitHubDiscussionDetail,
  PullRequestReactionContent,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ExternalLinkIcon, FolderIcon, TagIcon, UsersIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

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
import {
  PullRequestActorLabel,
  PullRequestLabelChip,
  PullRequestMetaRow,
} from "../pullRequest/pullRequestPresentation";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { cn } from "~/lib/utils";
import { DiscussionCategoryPicker, DiscussionLabelPicker } from "./DiscussionMetadataPickers";
import { DiscussionComposer } from "./DiscussionComposer";
import { DiscussionUpvoteButton } from "./DiscussionUpvoteButton";
import { ReactionBar } from "../pullRequest/PullRequestReactions";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  discussionParticipants,
  sortDiscussionComments,
  type DiscussionCommentSort,
} from "./discussion.logic";

type DiscussionPost = Pick<
  GitHubDiscussionDetail,
  | "id"
  | "url"
  | "body"
  | "author"
  | "createdAt"
  | "reactions"
  | "viewerCanReact"
  | "upvoteCount"
  | "viewerHasUpvoted"
  | "viewerCanUpvote"
>;

function DiscussionPost({
  post,
  threadRef,
  cwd,
  selected,
  discussionUrl,
  interactive,
  attached = false,
}: {
  post: DiscussionPost;
  threadRef: ScopedThreadRef;
  cwd: string;
  selected: boolean;
  discussionUrl: string;
  interactive: boolean;
  attached?: boolean;
}) {
  const canWrite = useAtomValue(
    discussionEnvironment.setReaction.permissionAtom(threadRef.environmentId),
  );
  const anchor = new URL(post.url).hash.slice(1);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const setReaction = useAtomCommand(discussionEnvironment.setReaction, { reportFailure: false });
  const react = async (content: PullRequestReactionContent, reacted: boolean) => {
    if (!post.id || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const result = await setReaction({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          url: discussionUrl,
          subjectId: post.id,
          content,
          reacted,
        },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "The reaction could not be saved",
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
    <article
      id={anchor || undefined}
      tabIndex={-1}
      data-discussion-comment={anchor || undefined}
      className={cn(
        "min-w-0 scroll-mt-4 rounded-lg border border-border/70 bg-card/40 p-4 outline-none",
        attached && "rounded-none border-0 bg-transparent",
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
      <div className="mt-3 flex flex-wrap items-center gap-1">
        {post.id !== undefined && post.upvoteCount !== undefined ? (
          <DiscussionUpvoteButton
            threadRef={threadRef}
            url={discussionUrl}
            subjectId={post.id}
            count={post.upvoteCount}
            upvoted={post.viewerHasUpvoted === true}
            canUpvote={post.viewerCanUpvote === true}
          />
        ) : null}
        <ReactionBar
          reactions={post.reactions ?? []}
          canReact={
            canWrite && interactive && post.viewerCanReact === true && post.id !== undefined
          }
          pending={pending}
          onToggle={(content, reacted) => void react(content, reacted)}
        />
      </div>
    </article>
  );
}

/** experimental discussion view, sharing markdown and controls with the pr viewer. */
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
  const [sort, setSort] = useState<DiscussionCommentSort>("oldest");
  const [condensed, setCondensed] = useState(false);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const foldRef = useRef<HTMLDivElement | null>(null);
  const condensedRowRef = useRef<HTMLDivElement | null>(null);
  const compensationRef = useRef<number | null>(null);
  // Match the PR viewer's scroll refund after the header folds, before the next paint.
  useLayoutEffect(() => {
    if (compensationRef.current === null) return;
    const scroller = scrollerRef.current;
    const delta = compensationRef.current;
    compensationRef.current = null;
    if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
  }, [condensed]);
  const anchor = new URL(url).hash.slice(1);
  const detail = query.data;
  const discussionUrl = new URL(detail?.url ?? url);
  const repository = discussionUrl.pathname.split("/").slice(1, 3).join("/");
  const repositoryUrl = `${discussionUrl.origin}/${repository}`;
  const number = detail?.number ?? discussionUrl.pathname.split("/")[4];
  const participants = useMemo(() => (detail ? discussionParticipants(detail) : []), [detail]);
  const discussionKey = `${threadRef.environmentId}:${threadRef.threadId}:${discussionUrl.origin}${discussionUrl.pathname}`;
  useLayoutEffect(() => {
    compensationRef.current = null;
    focusedAnchor.current = null;
    setCondensed(false);
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [discussionKey]);
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
  const discussionLink = (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open discussion #${number} in Browser`}
            className="inline-flex shrink-0 items-center gap-0.5 font-medium text-primary underline-offset-2 hover:underline"
            onClick={(event) => {
              if (event.ctrlKey || event.metaKey) return;
              event.preventDefault();
              openBrowser();
            }}
          />
        }
      >
        #{number}
        <ExternalLinkIcon aria-hidden className="size-2.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">Open in Browser</TooltipPopup>
    </Tooltip>
  );
  const discussionStatus = detail ? (
    <>
      {detail.isAnswered ? <span>Answered</span> : null}
      {detail.locked ? <span>Locked</span> : null}
    </>
  ) : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-discussion-panel>
      <header className="grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 border-b border-border/60">
        <div className="grid h-7 min-w-0 items-center overflow-hidden pl-4">
          <div
            aria-hidden={condensed}
            inert={condensed}
            className={cn(
              "col-start-1 row-start-1 flex min-w-0 items-center gap-1 text-sm text-muted-foreground transition-[opacity,transform] ease-out motion-reduce:transform-none motion-reduce:transition-none sm:text-xs",
              condensed
                ? "pointer-events-none -translate-y-1 opacity-0 duration-100"
                : "translate-y-0 opacity-100 delay-50 duration-150",
            )}
          >
            <a
              href={repositoryUrl}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 truncate font-medium underline-offset-2 hover:text-foreground hover:underline"
            >
              {repository}
            </a>
            {discussionLink}
          </div>
          <div
            aria-hidden={!condensed}
            inert={!condensed}
            className={cn(
              "col-start-1 row-start-1 flex min-w-0 items-center gap-1 text-sm text-muted-foreground transition-[opacity,transform] ease-out motion-reduce:transform-none motion-reduce:transition-none sm:text-xs",
              condensed
                ? "translate-y-0 opacity-100 delay-50 duration-150"
                : "pointer-events-none translate-y-1 opacity-0 duration-100",
            )}
          >
            {discussionLink}
            {detail ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="min-w-0 truncate font-medium text-foreground">
                      {detail.title}
                    </span>
                  }
                />
                <TooltipPopup side="top">{detail.title}</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        </div>
        <div className="mr-4 flex h-7 shrink-0 items-center justify-end">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label="Refresh discussion"
                  disabled={!supported || query.isPending}
                  onClick={query.refresh}
                />
              }
            >
              <RefreshIcon size="md" refreshing={query.isPending} />
            </TooltipTrigger>
            <TooltipPopup side="top">Refresh discussion</TooltipPopup>
          </Tooltip>
        </div>
        <div
          className={cn(
            "col-span-2 grid",
            condensed
              ? "grid-rows-[1fr]"
              : "grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          )}
        >
          <div
            ref={condensedRowRef}
            className={cn(
              "min-h-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none",
              condensed
                ? "translate-y-0 opacity-100 delay-50"
                : "translate-y-1 opacity-0 duration-100",
            )}
            inert={!condensed}
          >
            {detail ? (
              <div className="min-w-0 px-4 pb-2 pt-1">
                <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <span className="flex shrink-0 items-center gap-1.5">
                    <PullRequestActorLabel
                      actor={detail.author ? { ...detail.author, name: null } : null}
                      profileUrl={detail.author?.url ?? null}
                      variant="avatar"
                    />
                    <time dateTime={detail.updatedAt}>
                      {formatRelativeTimeLabel(detail.updatedAt)}
                    </time>
                  </span>
                  {detail.category ? (
                    <>
                      <span aria-hidden className="h-3 w-px shrink-0 bg-border/70" />
                      <DiscussionCategoryPicker
                        key={`${discussionKey}:compact`}
                        detail={detail}
                        threadRef={threadRef}
                      />
                    </>
                  ) : null}
                  <span className="ml-auto inline-flex shrink-0 items-center gap-2 text-2xs">
                    {discussionStatus}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <div
          className={cn(
            "col-span-2 grid",
            // Collapse before refunding scroll; only reopening animates the header height.
            condensed
              ? "grid-rows-[0fr]"
              : "grid-rows-[1fr] transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          )}
        >
          <div
            ref={foldRef}
            className={cn(
              "min-h-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none",
              condensed
                ? "-translate-y-1 opacity-0 duration-100"
                : "translate-y-0 opacity-100 delay-50",
            )}
            inert={condensed}
          >
            {detail ? (
              <div className="mt-1 min-w-0 px-4 pb-4">
                <h2 className="min-h-7 text-base font-semibold leading-snug wrap-anywhere sm:min-h-6">
                  {detail.title}
                </h2>
                {detail.isAnswered || detail.locked ? (
                  <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {discussionStatus}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <ScrollArea
        className="min-h-0 flex-1"
        radius="none"
        scrollFade
        onScrollCapture={(event) => {
          const scroller = event.target;
          if (
            !(scroller instanceof HTMLElement) ||
            scroller.dataset.slot !== "scroll-area-viewport" ||
            scroller.parentElement !== event.currentTarget
          ) {
            return;
          }
          scrollerRef.current = scroller;
          const top = scroller.scrollTop;
          setCondensed((previous) => {
            const foldHeight = foldRef.current?.scrollHeight ?? 0;
            const chromeDelta = foldHeight - (condensedRowRef.current?.scrollHeight ?? 0);
            if (previous) {
              // Returning to the top reopens above the content, without a scroll refund.
              if (top < 4 && foldHeight > 0) return false;
            } else if (foldHeight > 0 && top > foldHeight + 32) {
              compensationRef.current = -chromeDelta;
              return true;
            }
            return previous;
          });
        }}
      >
        <div ref={contentRef} className="space-y-4 px-4 pt-2.5 pb-4">
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
                repositoryUrl,
                threadRef,
              }}
            >
              <div className="space-y-2">
                <PullRequestMetaRow icon={<FolderIcon className="size-3.5" />} label="Category">
                  <DiscussionCategoryPicker
                    key={discussionKey}
                    detail={detail}
                    threadRef={threadRef}
                  />
                </PullRequestMetaRow>
                <PullRequestMetaRow icon={<TagIcon className="size-3.5" />} label="Labels">
                  <span className="flex min-w-0 flex-wrap items-center gap-1">
                    {detail.labels === undefined ? (
                      <span className="text-muted-foreground">Unavailable</span>
                    ) : detail.labels.length === 0 ? (
                      detail.canEditLabels === true ? null : (
                        <span className="text-muted-foreground">None</span>
                      )
                    ) : (
                      detail.labels.map((label) => (
                        <PullRequestLabelChip
                          key={label.name}
                          label={label}
                          size="default"
                          className="max-w-48"
                        />
                      ))
                    )}
                    {detail.canEditLabels === true ? (
                      <DiscussionLabelPicker
                        key={discussionKey}
                        detail={detail}
                        threadRef={threadRef}
                      />
                    ) : null}
                  </span>
                </PullRequestMetaRow>
                <PullRequestMetaRow icon={<UsersIcon className="size-3.5" />} label="Participants">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="flex items-center -space-x-1">
                      {participants.slice(0, 8).map((participant) => (
                        <PullRequestActorLabel
                          key={participant.login}
                          actor={{ ...participant, name: null }}
                          profileUrl={participant.url}
                          variant="avatar"
                        />
                      ))}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {participants.length}
                    </span>
                  </span>
                </PullRequestMetaRow>
              </div>
              <DiscussionPost
                post={detail}
                threadRef={threadRef}
                cwd={cwd}
                selected={false}
                discussionUrl={detail.url}
                interactive={detail.canComment === true}
              />
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium">Comments ({detail.comments.length})</h3>
                <Select
                  value={sort}
                  onValueChange={(value) => {
                    if (value === "oldest" || value === "newest" || value === "top") setSort(value);
                  }}
                >
                  <SelectTrigger variant="ghost" size="sm" aria-label="Sort comments">
                    <SelectValue>
                      {sort === "oldest" ? "Oldest" : sort === "newest" ? "Newest" : "Top"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    <SelectItem value="oldest">Oldest</SelectItem>
                    <SelectItem value="newest">Newest</SelectItem>
                    <SelectItem value="top">Top</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
              {sortDiscussionComments(detail.comments, sort).map((comment) => (
                <div
                  key={comment.id}
                  className="overflow-hidden rounded-lg border border-border/70 bg-card/40"
                >
                  <DiscussionPost
                    post={comment}
                    threadRef={threadRef}
                    cwd={cwd}
                    selected={new URL(comment.url).hash.slice(1) === anchor}
                    discussionUrl={detail.url}
                    interactive={detail.canComment === true}
                    attached
                  />
                  {comment.replies.length > 0 ? (
                    <div className="mx-3 mb-3 space-y-2 border-l border-border/70 pl-3">
                      {comment.replies.map((reply) => (
                        <DiscussionPost
                          key={reply.id}
                          post={reply}
                          threadRef={threadRef}
                          cwd={cwd}
                          selected={new URL(reply.url).hash.slice(1) === anchor}
                          discussionUrl={detail.url}
                          interactive={detail.canComment === true}
                        />
                      ))}
                    </div>
                  ) : null}
                  {detail.canComment ? (
                    <DiscussionComposer
                      threadRef={threadRef}
                      url={detail.url}
                      cwd={cwd}
                      replyToId={comment.id}
                    />
                  ) : null}
                </div>
              ))}
              {detail.canComment ? (
                <DiscussionComposer threadRef={threadRef} url={detail.url} cwd={cwd} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {detail.canComment === undefined
                    ? "Update this environment's server to comment and react here."
                    : detail.locked
                      ? "This discussion is locked. Comments are unavailable."
                      : "Comments are unavailable for this discussion."}
                </p>
              )}
            </PullRequestMarkdownContext>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
