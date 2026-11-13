import {
  cloneFileDiffMetadata,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { useState } from "react";

import { DIFF_VIEW_UNSAFE_CSS } from "../../diffs/StyledDiffCodeView";
import { GuideDiff, type ExcerptCommenting, type ExcerptDraft } from "./GuideExcerpt";

export function GuideFileDiff({
  path,
  file,
  commenting,
  loadDiffFiles,
}: {
  path: string;
  file: FileDiffMetadata;
  commenting: ExcerptCommenting | null;
  loadDiffFiles: FileDiffContentsLoader;
}) {
  const [draft, setDraft] = useState<ExcerptDraft | null>(null);
  // Loading the unchanged lines rewrites the diff it is given; the excerpts read the same file
  // as a patch, so this view expands a copy of its own.
  const expandable = cloneFileDiffMetadata(file);
  return (
    <div className="border-t border-border/60">
      <GuideDiff
        path={path}
        file={file}
        fileDiff={expandable}
        drawn={null}
        notes={[]}
        draft={draft}
        setDraft={setDraft}
        commenting={commenting}
        unsafeCSS={DIFF_VIEW_UNSAFE_CSS}
        disableFileHeader
        loadDiffFiles={loadDiffFiles}
      />
    </div>
  );
}
