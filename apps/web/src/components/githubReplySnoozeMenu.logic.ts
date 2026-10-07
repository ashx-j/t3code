import {
  githubReplyConversationLabel,
  type GitHubReplyConversation,
} from "@t3tools/client-runtime/github-reply-conversations";
import type { ContextMenuItem } from "@t3tools/contracts";

export function githubReplySnoozeMenuItem(
  conversations: ReadonlyArray<GitHubReplyConversation>,
  emptyLabel = "Link a PR or discussion first",
): ContextMenuItem<`snooze:${string}`> {
  const only = conversations.length === 1 ? conversations[0] : undefined;
  return {
    id: only ? `snooze:github:${only.url}` : "snooze:github",
    label:
      conversations.length === 0 ? `Until a GitHub reply · ${emptyLabel}` : "Until a GitHub reply",
    disabled: conversations.length === 0,
    ...(conversations.length > 1
      ? {
          children: conversations.map((conversation) => ({
            id: `snooze:github:${conversation.url}` as const,
            label: githubReplyConversationLabel(conversation),
          })),
        }
      : {}),
  };
}

/** Resolve against the menu's saved links rather than accepting an arbitrary URL action. */
export function githubReplySnoozeChoice(
  action: string,
  conversations: ReadonlyArray<GitHubReplyConversation>,
) {
  const conversation = conversations.find(
    (candidate) => `snooze:github:${candidate.url}` === action,
  );
  return conversation ? { url: conversation.url } : undefined;
}
