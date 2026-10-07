import {
  parseGitHubConversationUrl,
  type ThreadDiscussionLink,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

export interface GitHubReplyConversation {
  readonly url: string;
  readonly kind: "pull-request" | "discussion";
  readonly repository: string;
  readonly number: number;
  readonly title: string | null;
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
    })),
    ...(thread.discussions ?? []).map((link) => ({ url: link.url, title: link.title })),
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
    groups[0]?.filter((conversation) =>
      groups.every((group) =>
        group.some((candidate) => candidate.url.toLowerCase() === conversation.url.toLowerCase()),
      ),
    ) ?? []
  );
}
