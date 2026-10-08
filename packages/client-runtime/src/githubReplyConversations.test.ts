import type { ThreadDiscussionLink, ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  commonGitHubReplyConversations,
  eligibleThreadGitHubConversations,
  githubReplyConversationsForCondition,
  githubReplySnoozeChoice,
} from "./githubReplyConversations.ts";

const linkedAt = "2026-10-07T12:00:00.000Z";
const pull: ThreadPullRequestLink = {
  host: "github.com",
  repository: "owner/repo",
  number: 12,
  url: "https://github.com/owner/repo/pull/12",
  source: "manual",
  linkedAt,
  snapshot: null,
  stack: null,
};
const discussion: ThreadDiscussionLink = {
  host: "github.com",
  repository: "owner/repo",
  number: 4,
  url: "https://github.com/owner/repo/discussions/4",
  title: "Feedback",
  source: "agent",
  linkedAt,
};

describe("eligibleThreadGitHubConversations", () => {
  it("offers linked GitHub conversations, including closed PRs, but omits other hosts and dismissed stack links", () => {
    const conversations = eligibleThreadGitHubConversations({
      pullRequests: [
        {
          ...pull,
          snapshot: {
            state: "closed",
            title: "Closed work",
            headBranch: "work",
            baseBranch: "main",
            isDraft: false,
            updatedAt: linkedAt,
            syncedAt: linkedAt,
          },
        },
        {
          ...pull,
          number: 13,
          url: "https://github.com/owner/repo/pull/13",
          source: "stack-dismissed",
        },
        { ...pull, host: "gitlab.com", url: "https://gitlab.com/owner/repo/-/merge_requests/12" },
      ],
      discussions: [discussion],
    });
    expect(conversations).toEqual([
      {
        url: pull.url,
        kind: "pull-request",
        repository: "owner/repo",
        number: 12,
        title: "Closed work",
        isOpenPullRequest: false,
      },
      {
        url: discussion.url,
        kind: "discussion",
        repository: "owner/repo",
        number: 4,
        title: "Feedback",
        isOpenPullRequest: false,
      },
    ]);
  });

  it("deduplicates PR anchors and case variations without combining PRs with discussions", () => {
    expect(
      eligibleThreadGitHubConversations({
        pullRequests: [
          pull,
          { ...pull, url: "https://github.com/Owner/Repo/pull/12#issuecomment-9" },
        ],
        discussions: [
          { ...discussion, number: 12, url: "https://github.com/owner/repo/discussions/12" },
        ],
      }),
    ).toHaveLength(2);
  });

  it("limits bulk selection to a conversation saved on every selected thread", () => {
    const both = eligibleThreadGitHubConversations({
      pullRequests: [pull],
      discussions: [discussion],
    });
    const one = eligibleThreadGitHubConversations({ discussions: [discussion] });
    expect(commonGitHubReplyConversations([both, one])).toEqual(one);
    expect(commonGitHubReplyConversations([both, []])).toEqual([]);
    expect(commonGitHubReplyConversations([])).toEqual([]);
  });
});

it("limits requested-changes targets to linked open GitHub PRs on every selected thread", () => {
  const snapshot = {
    state: "open" as const,
    title: "Open",
    headBranch: "work",
    baseBranch: "main",
    isDraft: false,
    updatedAt: linkedAt,
    syncedAt: linkedAt,
  };
  const conversations = eligibleThreadGitHubConversations({
    pullRequests: [
      { ...pull, snapshot },
      {
        ...pull,
        number: 2,
        url: "https://github.com/owner/repo/pull/2",
        snapshot: { ...snapshot, state: "closed" },
      },
      {
        ...pull,
        number: 3,
        url: "https://github.com/owner/repo/pull/3",
        snapshot: { ...snapshot, state: "merged" },
      },
      { ...pull, number: 4, url: "https://github.com/owner/repo/pull/4", snapshot: null },
      {
        ...pull,
        number: 5,
        url: "https://github.com/owner/repo/pull/5",
        snapshot,
        source: "stack-dismissed",
      },
      {
        ...pull,
        number: 6,
        url: "https://ghe.example/owner/repo/pull/6",
        host: "ghe.example",
        snapshot,
      },
    ],
    discussions: [discussion],
  });
  expect(
    githubReplyConversationsForCondition(conversations, "changes-requested").map(
      (item) => item.url,
    ),
  ).toEqual([pull.url]);
  expect(githubReplyConversationsForCondition(conversations)).toHaveLength(5);
  const closedElsewhere = eligibleThreadGitHubConversations({
    pullRequests: [{ ...pull, snapshot: { ...snapshot, state: "closed" } }],
  });
  const shared = commonGitHubReplyConversations([conversations, closedElsewhere]);
  expect(shared).toHaveLength(1);
  expect(githubReplyConversationsForCondition(shared, "changes-requested")).toEqual([]);
  expect(
    githubReplySnoozeChoice(`snooze:github:changes-requested:${discussion.url}`, conversations),
  ).toBeUndefined();
});
