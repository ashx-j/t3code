import { useRef, useState } from "react";
import {
  BoldIcon,
  ItalicIcon,
  CodeIcon,
  LinkIcon,
  QuoteIcon,
  ListIcon,
  ListOrderedIcon,
} from "lucide-react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { Button, type ButtonVariant } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatMarkdownSelection, type MarkdownFormat } from "./markdownFormatting";

const FORMATTING_ACTIONS = [
  { format: "bold", label: "Bold", icon: BoldIcon },
  { format: "italic", label: "Italic", icon: ItalicIcon },
  { format: "code", label: "Code", icon: CodeIcon },
  { format: "link", label: "Link", icon: LinkIcon },
  { format: "quote", label: "Quote", icon: QuoteIcon },
  { format: "bullet", label: "Bulleted list", icon: ListIcon },
  { format: "numbered", label: "Numbered list", icon: ListOrderedIcon },
] as const;

/**
 * The box a body is rewritten in — a description, or a remark already posted. It owns the draft
 * and nothing else: the caller sends the request and says whether it is still in flight, so the
 * same box serves every mutation without knowing which one it is.
 *
 * Preview renders through the same component the saved body will be read through, which is the
 * only way to see what a host's markdown will actually become before it is sent.
 */
export function PullRequestMarkdownEditor({
  value,
  cwd,
  environmentId,
  threadRef = null,
  placeholder,
  hidePlaceholderOnFocus = false,
  label,
  saving,
  saveLabel = "Save",
  savingLabel = "Saving...",
  autoFocus = true,
  formatting = false,
  toolbarPosition = "top",
  showCancel = true,
  borderless = false,
  previewEnabled = true,
  saveVariant = "outline",
  allowEmpty = false,
  className,
  onSave,
  onCancel,
  onDraftChange,
}: {
  readonly value: string;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  /** Thread the editor sits beside, so links in its preview follow the link target setting. */
  readonly threadRef?: ScopedThreadRef | null;
  readonly placeholder?: string | undefined;
  readonly hidePlaceholderOnFocus?: boolean;
  readonly label: string;
  readonly saving: boolean;
  readonly saveLabel?: string;
  readonly savingLabel?: string;
  readonly autoFocus?: boolean;
  readonly formatting?: boolean;
  readonly toolbarPosition?: "top" | "bottom";
  readonly showCancel?: boolean;
  readonly borderless?: boolean;
  readonly previewEnabled?: boolean;
  readonly saveVariant?: ButtonVariant;
  /** A description may be cleared, which is how one is removed; a remark may not be emptied. */
  readonly allowEmpty?: boolean;
  readonly className?: string | undefined;
  readonly onSave: (next: string) => void;
  readonly onCancel: () => void;
  readonly onDraftChange?: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [previewMode, setPreview] = useState(false);
  const preview = previewEnabled && previewMode;
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const applyFormat = (format: MarkdownFormat) => {
    const textarea = textareaRef.current;
    if (!textarea || saving) return;
    const next = formatMarkdownSelection(
      draft,
      textarea.selectionStart,
      textarea.selectionEnd,
      format,
    );
    setDraft(next.draft);
    onDraftChange?.(next.draft);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(next.start, next.end);
    });
  };
  // The words this draft started from. React keeps a component instance wherever the same
  // position and key come round again, so an editor opened on one remark can be handed another's
  // words without being rebuilt — and saving would then write the first remark's text onto the
  // second. Different words mean a different subject, and the draft starts again from them.
  const [seed, setSeed] = useState(value);
  if (seed !== value) {
    setSeed(value);
    setDraft(value);
  }
  const empty = draft.trim().length === 0;
  const saveDisabled = saving || (empty && !allowEmpty);

  const toolbar = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {previewEnabled ? (
        <ToggleGroup
          aria-label="Markdown editor mode"
          variant="segmented"
          value={[preview ? "preview" : "write"]}
          disabled={saving}
          onValueChange={(next) => {
            const mode = next[0];
            if (mode === "write" || mode === "preview") setPreview(mode === "preview");
          }}
        >
          <Toggle value="write">Write</Toggle>
          <Toggle value="preview">Preview</Toggle>
        </ToggleGroup>
      ) : null}
      {formatting ? (
        <div className="flex flex-wrap items-center" role="group" aria-label="Markdown formatting">
          {FORMATTING_ACTIONS.map(({ format, label, icon: Icon }) => (
            <Tooltip key={format}>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={label}
                    disabled={saving || preview}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => applyFormat(format)}
                  />
                }
              >
                <Icon />
              </TooltipTrigger>
              <TooltipPopup>{label}</TooltipPopup>
            </Tooltip>
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <div
      className={cn("space-y-2", borderless && "text-xs", className)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey) &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (!saveDisabled && !event.repeat) onSave(draft);
          return;
        }
        if (event.key !== "Escape" || saving || !showCancel) return;
        event.preventDefault();
        onCancel();
      }}
    >
      {toolbarPosition === "top" ? toolbar : null}
      {preview ? (
        <div className={cn("py-2", !borderless && "rounded-lg border border-border/60 px-3")}>
          {empty ? (
            <p className="text-xs text-muted-foreground">Nothing to preview.</p>
          ) : (
            <PullRequestMarkdown
              text={draft}
              cwd={cwd}
              environmentId={environmentId}
              threadRef={threadRef}
            />
          )}
        </div>
      ) : (
        <Textarea
          unstyled={borderless}
          resizable={!borderless}
          ref={textareaRef}
          autoFocus={autoFocus}
          disabled={saving}
          value={draft}
          rows={6}
          placeholder={hidePlaceholderOnFocus && focused ? undefined : placeholder}
          aria-label={label}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => {
            setDraft(event.target.value);
            onDraftChange?.(event.target.value);
          }}
        />
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {toolbarPosition === "bottom" ? <div className="mr-auto">{toolbar}</div> : null}
        <div className="ml-auto flex items-center gap-2">
          {showCancel ? (
            <Button size="xs" variant="ghost" disabled={saving} onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button
            size="xs"
            variant={saveVariant}
            disabled={saveDisabled}
            onClick={() => onSave(draft)}
          >
            {saving ? savingLabel : saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
