import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";
import { discussionEnvironment } from "~/state/discussions";
import { useAtomCommand } from "~/state/use-atom-command";
import { PullRequestMarkdownEditor } from "../pullRequest/PullRequestMarkdownEditor";
import { Input } from "../ui/input";
import { cn } from "~/lib/utils";

export function DiscussionComposer({
  threadRef,
  url,
  cwd,
  replyToId,
}: {
  threadRef: ScopedThreadRef;
  url: string;
  cwd: string;
  replyToId?: string;
}) {
  const canWrite = useAtomValue(
    discussionEnvironment.comment.permissionAtom(threadRef.environmentId),
  );
  const [expanded, setExpanded] = useState(replyToId === undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [seed, setSeed] = useState("");
  const draft = useRef("");
  const editorRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    const editor = editorRef.current;
    if (!expanded || replyToId === undefined || !editor) return;
    const collapseOutside = (event: PointerEvent) => {
      if (event.composedPath().includes(editor) || inFlight.current) return;
      setSeed(draft.current);
      setExpanded(false);
    };
    const document = editor.ownerDocument;
    document.addEventListener("pointerdown", collapseOutside, true);
    return () => document.removeEventListener("pointerdown", collapseOutside, true);
  }, [expanded, replyToId]);
  const comment = useAtomCommand(discussionEnvironment.comment, { reportFailure: false });
  const save = async (body: string) => {
    if (inFlight.current || !body.trim()) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await comment({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          url,
          body,
          ...(replyToId === undefined ? {} : { replyToId }),
        },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(
          cause instanceof Error
            ? cause.message
            : "The comment could not be posted. Refresh before trying again.",
        );
        return;
      }
      setRevision((value) => value + 1);
      draft.current = "";
      setSeed("");
      if (replyToId !== undefined) setExpanded(false);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  if (!canWrite)
    return (
      <p className="text-xs text-muted-foreground">
        This connection can read discussions. Posting needs source control write access.
      </p>
    );
  if (!expanded)
    return (
      <div className="border-t border-border/70 px-3 py-1">
        <Input
          unstyled
          size="compact"
          padding="none"
          className="flex w-full"
          aria-label="Write a reply"
          placeholder="Write a reply..."
          value={seed}
          onFocus={() => setExpanded(true)}
          onChange={(event) => {
            draft.current = event.target.value;
            setSeed(event.target.value);
            setExpanded(true);
          }}
        />
      </div>
    );
  return (
    <div
      ref={editorRef}
      className={cn(
        "space-y-2",
        replyToId === undefined
          ? "rounded-lg border border-border/70 bg-card/40 p-3"
          : "border-t border-border/70 px-3 py-1",
      )}
    >
      {replyToId === undefined ? (
        <h3 className="-mx-3 border-b border-border/70 px-3 pb-3 text-sm font-medium">
          Add a comment
        </h3>
      ) : null}
      <PullRequestMarkdownEditor
        key={revision}
        value={seed}
        cwd={cwd}
        environmentId={threadRef.environmentId}
        threadRef={threadRef}
        label={replyToId === undefined ? "Comment" : "Reply"}
        placeholder={replyToId === undefined ? "Add your comment here" : undefined}
        hidePlaceholderOnFocus
        saveLabel={replyToId === undefined ? "Comment" : "Reply"}
        savingLabel="Posting..."
        autoFocus={replyToId !== undefined}
        formatting
        toolbarPosition="bottom"
        showCancel={false}
        borderless
        previewEnabled={false}
        saveVariant="default"
        saving={saving}
        onDraftChange={(next) => {
          draft.current = next;
        }}
        onSave={(body) => void save(body)}
        onCancel={() => {
          setError(null);
          draft.current = "";
          setSeed("");
          setRevision((value) => value + 1);
          if (replyToId !== undefined) setExpanded(false);
        }}
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
