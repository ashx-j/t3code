export type MarkdownFormat = "bold" | "italic" | "code" | "link" | "quote" | "bullet" | "numbered";

/** Returns the edited draft and selection so toolbar clicks preserve the typing position. */
export function formatMarkdownSelection(
  draft: string,
  start: number,
  end: number,
  format: MarkdownFormat,
) {
  if (format === "quote" || format === "bullet" || format === "numbered") {
    const lineStart = draft.slice(0, start).lastIndexOf("\n") + 1;
    const lastSelected = end > start && draft[end - 1] === "\n" ? end - 1 : end;
    const nextLine = draft.indexOf("\n", lastSelected);
    const lineEnd = nextLine === -1 ? draft.length : nextLine;
    const lines = (draft.slice(lineStart, lineEnd) || "text").split("\n");
    const replacement = lines
      .map(
        (line, index) =>
          `${format === "quote" ? "> " : format === "bullet" ? "- " : `${index + 1}. `}${line}`,
      )
      .join("\n");
    return {
      draft: draft.slice(0, lineStart) + replacement + draft.slice(lineEnd),
      start: lineStart,
      end: lineStart + replacement.length,
    };
  }
  const selected = draft.slice(start, end);
  const text =
    selected || (format === "link" ? "link text" : format === "code" ? "code" : `${format} text`);
  const codeFence = "`".repeat(
    Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length)) + 1,
  );
  const delimiter = format === "bold" ? "**" : format === "italic" ? "_" : codeFence;
  const blockCode = format === "code" && text.includes("\n");
  const codePadding =
    format === "code" && !blockCode && (text.startsWith("`") || text.endsWith("`")) ? " " : "";
  const fence = "`".repeat(Math.max(3, codeFence.length));
  const prefix =
    format === "link"
      ? "["
      : blockCode
        ? `${start > 0 && draft[start - 1] !== "\n" ? "\n" : ""}${fence}\n`
        : delimiter + codePadding;
  const suffix =
    format === "link"
      ? "](https://example.com)"
      : blockCode
        ? `\n${fence}${end < draft.length && draft[end] !== "\n" ? "\n" : ""}`
        : codePadding + delimiter;
  const replacement = prefix + text + suffix;
  const selectionStart =
    format === "link" ? start + prefix.length + text.length + 2 : start + prefix.length;
  return {
    draft: draft.slice(0, start) + replacement + draft.slice(end),
    start: selectionStart,
    end: selectionStart + (format === "link" ? "https://example.com".length : text.length),
  };
}
