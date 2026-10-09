import {
  githubReplyConversationLabel,
  githubReplyConversationsForCondition,
  type GitHubReplyConversation,
} from "@t3tools/client-runtime/github-reply-conversations";
import type { ContextMenuItem, GitHubReplyWakeCondition } from "@t3tools/contracts";

export function githubReplySnoozeMenuItem(
  conversations: ReadonlyArray<GitHubReplyConversation>,
  emptyLabel = "Link a PR or discussion first",
  wakeCondition?: GitHubReplyWakeCondition,
): ContextMenuItem<`snooze:${string}`> {
  conversations = githubReplyConversationsForCondition(conversations, wakeCondition);
  const changesRequested = wakeCondition === "changes-requested";
  const label = changesRequested ? "Until changes are requested" : "Until a GitHub reply";
  const prefix = changesRequested ? "snooze:github:changes-requested" : "snooze:github";
  if (changesRequested) emptyLabel = "Link an open GitHub PR first";
  const only = conversations.length === 1 ? conversations[0] : undefined;
  return {
    id: only ? `${prefix}:${only.url}` : prefix,
    label: conversations.length === 0 ? `${label} · ${emptyLabel}` : label,
    disabled: conversations.length === 0,
    ...(conversations.length > 1
      ? {
          children: conversations.map((conversation) => ({
            id: `${prefix}:${conversation.url}` as const,
            label: githubReplyConversationLabel(conversation),
          })),
        }
      : {}),
  };
}
