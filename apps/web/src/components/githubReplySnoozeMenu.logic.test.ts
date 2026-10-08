import { describe, expect, it } from "vite-plus/test";
import {
  githubReplySnoozeChoice,
  type GitHubReplyConversation,
} from "@t3tools/client-runtime/github-reply-conversations";
import { githubReplySnoozeMenuItem } from "./githubReplySnoozeMenu.logic";

const pull: GitHubReplyConversation = {
  url: "https://github.com/owner/repo/pull/1",
  kind: "pull-request",
  repository: "owner/repo",
  number: 1,
  title: "A fix",
  isOpenPullRequest: true,
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

it("selects one open PR directly and several through the requested-changes submenu", () => {
  const single = githubReplySnoozeMenuItem([pull, discussion], undefined, "changes-requested");
  expect(single.label).toBe("Until changes are requested");
  expect(single.children).toBeUndefined();
  expect(githubReplySnoozeChoice(single.id, [pull, discussion])).toEqual({
    url: pull.url,
    wakeCondition: "changes-requested",
  });
  const other = { ...pull, number: 2, url: "https://github.com/owner/repo/pull/2" };
  const several = githubReplySnoozeMenuItem(
    [pull, other, discussion],
    undefined,
    "changes-requested",
  );
  expect(several.children).toHaveLength(2);
  expect(githubReplySnoozeChoice(several.children![1]!.id, [pull, other, discussion])).toEqual({
    url: other.url,
    wakeCondition: "changes-requested",
  });
  expect(
    githubReplySnoozeMenuItem(
      [{ ...pull, isOpenPullRequest: false }, discussion],
      undefined,
      "changes-requested",
    ),
  ).toMatchObject({ disabled: true });
  expect(
    githubReplySnoozeChoice(single.id, [{ ...pull, isOpenPullRequest: false }]),
  ).toBeUndefined();
});
