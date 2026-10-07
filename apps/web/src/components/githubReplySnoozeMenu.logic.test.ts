import { describe, expect, it } from "vite-plus/test";
import type { GitHubReplyConversation } from "@t3tools/client-runtime/github-reply-conversations";
import { githubReplySnoozeChoice, githubReplySnoozeMenuItem } from "./githubReplySnoozeMenu.logic";

const pull: GitHubReplyConversation = {
  url: "https://github.com/owner/repo/pull/1",
  kind: "pull-request",
  repository: "owner/repo",
  number: 1,
  title: "A fix",
};
const discussion: GitHubReplyConversation = {
  url: "https://github.com/owner/repo/discussions/1",
  kind: "discussion",
  repository: "owner/repo",
  number: 1,
  title: "Feedback",
};

describe("GitHub reply snooze selection", () => {
  it("explains zero links and snoozes a single saved conversation directly", () => {
    expect(githubReplySnoozeMenuItem([])).toMatchObject({
      disabled: true,
      label: expect.stringContaining("Link a PR or discussion first"),
    });
    const item = githubReplySnoozeMenuItem([pull]);
    expect(item.children).toBeUndefined();
    expect(githubReplySnoozeChoice(item.id, [pull])).toEqual({ url: pull.url });
  });

  it("opens a nested choice for several links", () => {
    const item = githubReplySnoozeMenuItem([pull, discussion]);
    expect(item.children?.map((child) => child.label)).toEqual([
      "A fix",
      "Discussion #1 · Feedback",
    ]);
    expect(githubReplySnoozeChoice(item.id, [pull, discussion])).toBeUndefined();
    expect(githubReplySnoozeChoice(item.children![1]!.id, [pull, discussion])).toEqual({
      url: discussion.url,
    });
    expect(
      githubReplySnoozeChoice("snooze:github:https://github.com/other/repo/pull/4", [pull]),
    ).toBeUndefined();
  });
});
