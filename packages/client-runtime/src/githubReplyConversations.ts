import {
  parseGitHubConversationUrl,
  type GitHubReplyWakeCondition,
  type GitHubReplySnooze,
  type ThreadDiscussionLink,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

export const githubReplySnoozeFailureMessage =
  "GitHub reply snooze could not be set up. Try again.";

export interface GitHubReplyConversation {
  readonly url: string;
  readonly kind: "pull-request" | "discussion";
  readonly repository: string;
  readonly number: number;
  readonly title: string | null;
  readonly isOpenPullRequest?: boolean;
}

/** Only saved GitHub conversations can be selected, including merged and closed PRs. */
export function eligibleThreadGitHubConversations(thread: {
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink>;
  readonly discussions?: ReadonlyArray<ThreadDiscussionLink>;
}): ReadonlyArray<GitHubReplyConversation> {
  const candidates = [
    ...visibleThreadPullRequests(thread.pullRequests ?? []).map((link) => ({
      url: link.url,
      title: link.snapshot?.title ?? null,
      isOpenPullRequest:
        link.host.toLowerCase() === "github.com" && link.snapshot?.state === "open",
    })),
    ...(thread.discussions ?? []).map((link) => ({
      url: link.url,
      title: link.title,
      isOpenPullRequest: false,
    })),
  ];
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const conversation = parseGitHubConversationUrl(candidate.url);
    if (!conversation) return [];
    const url = conversation.kind === "pull" ? conversation.url.split("#")[0]! : conversation.url;
    const key = url.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        url,
        kind: conversation.kind === "pull" ? ("pull-request" as const) : ("discussion" as const),
        repository: `${conversation.owner}/${conversation.repository}`,
        number: conversation.number,
        title: candidate.title,
        isOpenPullRequest: candidate.isOpenPullRequest,
      },
    ];
  });
}

export function githubReplyConversationLabel(conversation: GitHubReplyConversation): string {
  if (conversation.kind === "pull-request" && conversation.title) return conversation.title;
  const kind = conversation.kind === "pull-request" ? "PR" : "Discussion";
  return `${kind} #${conversation.number}${conversation.title ? ` · ${conversation.title}` : ` · ${conversation.repository}`}`;
}

/** A bulk action must watch a conversation linked to every selected thread. */
export function commonGitHubReplyConversations(
  groups: ReadonlyArray<ReadonlyArray<GitHubReplyConversation>>,
): ReadonlyArray<GitHubReplyConversation> {
  return (
    groups[0]?.flatMap((conversation) => {
      const matches = groups.map((group) =>
        group.find((candidate) => candidate.url.toLowerCase() === conversation.url.toLowerCase()),
      );
      if (matches.some((match) => match === undefined)) return [];
      return [
        {
          ...conversation,
          ...(conversation.kind === "pull-request"
            ? {
                isOpenPullRequest: matches.every((match) => match?.isOpenPullRequest === true),
              }
            : {}),
        },
      ];
    }) ?? []
  );
}

export type GitHubReplySnoozeChoice = Pick<GitHubReplySnooze, "url" | "wakeCondition">;

export function githubReplyConversationsForCondition(
  conversations: ReadonlyArray<GitHubReplyConversation>,
  wakeCondition?: GitHubReplyWakeCondition,
): ReadonlyArray<GitHubReplyConversation> {
  return wakeCondition === "changes-requested"
    ? conversations.filter(
        (conversation) =>
          conversation.kind === "pull-request" && conversation.isOpenPullRequest === true,
      )
    : conversations;
}

/** resolve menu actions against saved links, including the condition's eligibility. */
export function githubReplySnoozeChoice(
  action: string,
  conversations: ReadonlyArray<GitHubReplyConversation>,
): GitHubReplySnoozeChoice | undefined {
  const changesRequested = action.startsWith("snooze:github:changes-requested:");
  const wakeCondition = changesRequested ? "changes-requested" : undefined;
  const prefix = changesRequested ? "snooze:github:changes-requested:" : "snooze:github:";
  const conversation = githubReplyConversationsForCondition(conversations, wakeCondition).find(
    (candidate) => `${prefix}${candidate.url}` === action,
  );
  return conversation
    ? { url: conversation.url, ...(wakeCondition ? { wakeCondition } : {}) }
    : undefined;
}
