import {
  githubReplyConversationLabel,
  githubReplyConversationsForCondition,
  githubReplySnoozeFailureMessage,
  type GitHubReplyConversation,
} from "@t3tools/client-runtime/github-reply-conversations";
import type { GitHubReplyWakeCondition } from "@t3tools/contracts";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useRef, useState } from "react";
import { Alert, Linking, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function githubReplySnoozeMenuAction(
  conversations: ReadonlyArray<GitHubReplyConversation>,
  wakeCondition?: GitHubReplyWakeCondition,
): MenuAction {
  conversations = githubReplyConversationsForCondition(conversations, wakeCondition);
  const changesRequested = wakeCondition === "changes-requested";
  const prefix = changesRequested ? "snooze:github:changes-requested" : "snooze:github";
  const only = conversations.length === 1 ? conversations[0] : undefined;
  return {
    id: only ? `${prefix}:${only.url}` : prefix,
    title: changesRequested ? "Until changes are requested" : "Until a GitHub reply",
    ...(conversations.length === 0
      ? {
          subtitle: changesRequested
            ? "Link an open GitHub PR first"
            : "Link a GitHub PR or discussion first",
          attributes: { disabled: true },
        }
      : {}),
    ...(conversations.length > 1
      ? {
          subactions: conversations.map((conversation) => ({
            id: `${prefix}:${conversation.url}`,
            title: githubReplyConversationLabel(conversation),
          })),
        }
      : {}),
  };
}

export function useGitHubReplySnooze(thread: EnvironmentThreadShell) {
  const snooze = useAtomCommand(threadEnvironment.snooze);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const snoozeUrl = useCallback(
    (url: string, wakeCondition?: GitHubReplyWakeCondition) => {
      if (
        pendingRef.current ||
        (wakeCondition === "changes-requested" &&
          appAtomRegistry.get(environmentServerConfigsAtom).get(thread.environmentId)?.environment
            .capabilities.threadGitHubChangesRequestedSnooze !== true)
      )
        return;
      pendingRef.current = true;
      setPending(true);
      void snooze({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, url, wakeCondition },
      }).then((result) => {
        pendingRef.current = false;
        setPending(false);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          Alert.alert("Could not snooze thread", githubReplySnoozeFailureMessage);
        }
      });
    },
    [snooze, thread.environmentId, thread.id],
  );
  return { pending, snoozeUrl };
}

export function GitHubReplySnoozeCard({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const unsnooze = useAtomCommand(threadEnvironment.unsnooze);
  const watch = thread.githubReplySnooze;
  if (!watch) return null;
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-border bg-background p-3">
      <Text className="font-t3-semibold">
        {watch.wakeCondition === "changes-requested"
          ? "Waiting for changes to be requested"
          : "Waiting for a GitHub reply"}
      </Text>
      <View className="flex-row items-center gap-6">
        <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(watch.url)}>
          <Text className="text-primary-text">View</Text>
        </Pressable>
        <View className="flex-1" />
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            void unsnooze({
              environmentId: thread.environmentId,
              input: { threadId: thread.id, reason: "user" },
            })
          }
        >
          <Text>Wake now</Text>
        </Pressable>
      </View>
    </View>
  );
}
