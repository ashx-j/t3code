import {
  eligibleThreadGitHubConversations,
  githubReplyConversationLabel,
  githubReplySnoozeFailureMessage,
  type GitHubReplyConversation,
} from "@t3tools/client-runtime/github-reply-conversations";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useRef, useState } from "react";
import { Alert, Linking, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function githubReplySnoozeMenuAction(
  conversations: ReadonlyArray<GitHubReplyConversation>,
): MenuAction {
  const only = conversations.length === 1 ? conversations[0] : undefined;
  return {
    id: only ? `snooze:github:${only.url}` : "snooze:github",
    title: "Until a GitHub reply",
    ...(conversations.length === 0
      ? { subtitle: "Link a GitHub PR or discussion first", attributes: { disabled: true } }
      : {}),
    ...(conversations.length > 1
      ? {
          subactions: conversations.map((conversation) => ({
            id: `snooze:github:${conversation.url}`,
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
    (url: string) => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      setPending(true);
      void snooze({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, url },
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
  const { pending, snoozeUrl } = useGitHubReplySnooze(thread);
  const conversations = eligibleThreadGitHubConversations(thread);
  const watch = thread.githubReplySnooze;
  const notice = thread.githubReplyNotice;
  if (!watch && !notice) return null;
  const url = watch?.url ?? notice!.url;
  const directUrl =
    notice?.conversationUrl ?? (conversations.length === 1 ? conversations[0]?.url : undefined);
  const snoozeButton = (
    <Text className="font-t3-semibold">{pending ? "Snoozing..." : "Snooze"}</Text>
  );
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-border bg-background p-3">
      <Text className="font-t3-semibold">
        {watch
          ? "Waiting for a GitHub reply"
          : notice?.type === "reply"
            ? `GitHub reply from ${notice.author}`
            : "GitHub reply snooze stopped"}
      </Text>
      {!watch && notice?.type === "error" ? <Text>{notice.text}</Text> : null}
      <View className="flex-row items-center gap-6">
        <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(url)}>
          <Text className="text-primary-text">View</Text>
        </Pressable>
        <View className="flex-1" />
        {!watch && notice ? (
          directUrl ? (
            <Pressable
              accessibilityRole="button"
              disabled={pending}
              onPress={() => snoozeUrl(directUrl)}
            >
              {snoozeButton}
            </Pressable>
          ) : (
            <ControlPillMenu
              actions={
                conversations.length === 0
                  ? [githubReplySnoozeMenuAction(conversations)]
                  : conversations.map((conversation) => ({
                      id: conversation.url,
                      title: githubReplyConversationLabel(conversation),
                    }))
              }
              onPressAction={({ nativeEvent }) => {
                if (
                  !pending &&
                  conversations.some((conversation) => conversation.url === nativeEvent.event)
                )
                  snoozeUrl(nativeEvent.event);
              }}
            >
              <Pressable accessibilityRole="button" disabled={pending}>
                {snoozeButton}
              </Pressable>
            </ControlPillMenu>
          )
        ) : null}
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            void unsnooze({
              environmentId: thread.environmentId,
              input: { threadId: thread.id, reason: "user" },
            })
          }
        >
          <Text>{watch ? "Wake now" : "Dismiss"}</Text>
        </Pressable>
      </View>
    </View>
  );
}
