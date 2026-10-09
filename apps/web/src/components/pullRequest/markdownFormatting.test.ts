import { describe, expect, it } from "vite-plus/test";
import { formatMarkdownSelection } from "./markdownFormatting";

describe("markdown toolbar editing", () => {
  it("wraps selected text without changing its surroundings", () => {
    expect(formatMarkdownSelection("before words after", 7, 12, "bold")).toEqual({
      draft: "before **words** after",
      start: 9,
      end: 14,
    });
  });
  it("selects inserted placeholder text for immediate replacement", () => {
    expect(formatMarkdownSelection("", 0, 0, "italic")).toEqual({
      draft: "_italic text_",
      start: 1,
      end: 12,
    });
  });
  it("selects the destination after turning text into a link", () => {
    const result = formatMarkdownSelection("read this", 5, 9, "link");
    expect(result.draft).toBe("read [this](https://example.com)");
    expect(result.draft.slice(result.start, result.end)).toBe("https://example.com");
  });
  it("numbers whole selected lines and leaves the next line untouched", () => {
    const text = "before\none\ntwo\nafter";
    expect(formatMarkdownSelection(text, 8, 15, "numbered").draft).toBe(
      "before\n1. one\n2. two\nafter",
    );
  });
  it("adds a bullet to the line containing a collapsed cursor", () => {
    expect(formatMarkdownSelection("some text", 4, 4, "bullet").draft).toBe("- some text");
  });
  it("inserts quote text on an empty first line", () => {
    expect(formatMarkdownSelection("\nnext", 0, 0, "quote").draft).toBe("> text\nnext");
  });
  it("fences multiline code on separate lines", () => {
    expect(formatMarkdownSelection("beforeone\ntwoafter", 6, 13, "code").draft).toBe(
      "before\n```\none\ntwo\n```\nafter",
    );
  });
  it("uses a longer delimiter for inline code containing backticks", () => {
    expect(formatMarkdownSelection("a `tick` here", 0, 13, "code").draft).toBe("``a `tick` here``");
  });
  it("separates literal edge backticks from the inline code delimiter", () => {
    expect(formatMarkdownSelection("`name`", 0, 6, "code").draft).toBe("`` `name` ``");
  });
});
