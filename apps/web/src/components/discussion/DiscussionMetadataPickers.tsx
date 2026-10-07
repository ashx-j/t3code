import type {
  GitHubDiscussionDetail,
  GitHubDiscussionLabel,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CheckIcon, PlusIcon } from "lucide-react";
import { useRef, useState } from "react";
import { discussionEnvironment } from "~/state/discussions";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { PullRequestCandidatePicker } from "../pullRequest/PullRequestCandidatePicker";
import { pullRequestLabelColor } from "../pullRequest/pullRequestList.logic";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "../ui/select";
import { toastManager } from "../ui/toast";

type MetadataPickerProps = {
  detail: GitHubDiscussionDetail;
  threadRef: ScopedThreadRef;
};

export function DiscussionLabelPicker({ detail, threadRef }: MetadataPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const candidates = useEnvironmentQuery(
    open
      ? discussionEnvironment.metadataOptions({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, url: detail.url, kind: "labels" },
        })
      : null,
  );
  const setLabel = useAtomCommand(discussionEnvironment.setLabel, { reportFailure: false });
  const applied = new Set(detail.labels?.map((label) => label.name));
  const needle = query.toLowerCase();
  const labels = (candidates.data?.labels ?? []).filter(
    (label) =>
      label.name.toLowerCase().includes(needle) ||
      (label.description ?? "").toLowerCase().includes(needle),
  );
  const toggle = async (label: typeof GitHubDiscussionLabel.Type) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const result = await setLabel({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          url: detail.url,
          labelId: label.id,
          applied: !applied.has(label.name),
        },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "The label could not be saved",
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
    <PullRequestCandidatePicker
      icon={<PlusIcon className="size-3.5" />}
      label="Change discussion labels"
      allowed={detail.canEditLabels === true}
      disabledReason="Your GitHub account cannot change these labels"
      open={open}
      onOpenChange={setOpen}
      query={query}
      onQueryChange={setQuery}
      searchLabel="Search labels"
      isPending={candidates.isPending && candidates.data === null}
      error={candidates.data === null ? candidates.error : null}
      candidates={labels}
      emptyLabel="This repository has no labels."
      noMatchLabel="No label matches that."
      errorLabel="The labels could not be read."
      truncated={candidates.data?.truncated === true}
      truncatedLabel="This repository has more labels than are listed here. Manage the rest on GitHub."
      candidateKey={(label) => label.id}
      disabled={pending}
      onSelect={(label) => void toggle(label)}
    >
      {(label) => {
        const color = pullRequestLabelColor(label.color);
        return (
          <>
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-muted-foreground"
              {...(color ? { style: { backgroundColor: color } } : {})}
            />
            <span className="min-w-0 flex-1 truncate">
              {label.name}
              {label.description ? (
                <span className="text-muted-foreground"> · {label.description}</span>
              ) : null}
            </span>
            {applied.has(label.name) ? (
              <CheckIcon aria-label="Applied" className="size-3.5 shrink-0" />
            ) : null}
          </>
        );
      }}
    </PullRequestCandidatePicker>
  );
}

export function DiscussionCategoryPicker({ detail, threadRef }: MetadataPickerProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const candidates = useEnvironmentQuery(
    open
      ? discussionEnvironment.metadataOptions({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, url: detail.url, kind: "categories" },
        })
      : null,
  );
  const setCategory = useAtomCommand(discussionEnvironment.setCategory, { reportFailure: false });
  const change = async (categoryId: string | null) => {
    if (!categoryId || categoryId === detail.category?.id || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const result = await setCategory({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, url: detail.url, categoryId },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "The category could not be saved",
          description:
            error instanceof Error ? error.message : "Refresh the discussion and try again.",
        });
      } else {
        setOpen(false);
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  if (detail.canEditCategory !== true)
    return <span className="min-w-0 truncate">{detail.category?.name ?? "None"}</span>;
  return (
    <Select
      value={detail.category?.id ?? null}
      onValueChange={(value) => void change(value)}
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (!nextOpen && details.reason === "item-press") {
          details.cancel();
          return;
        }
        setOpen(nextOpen);
      }}
      disabled={pending}
    >
      <SelectTrigger variant="ghost" size="xs" aria-label="Change discussion category">
        {detail.category?.name ?? "None"}
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {candidates.data === null ? (
          <p className="p-2 text-xs text-muted-foreground">
            {candidates.error ?? "Loading categories..."}
          </p>
        ) : candidates.data.categories.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">
            This repository has no discussion categories.
          </p>
        ) : (
          candidates.data.categories.map((category) => (
            <SelectItem key={category.id} value={category.id}>
              {category.name}
            </SelectItem>
          ))
        )}
      </SelectPopup>
    </Select>
  );
}
