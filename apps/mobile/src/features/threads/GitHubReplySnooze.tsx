import { parseGitHubConversationUrl } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { AppText as Text } from "../../components/AppText";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function GitHubReplySnoozeSheet({
  thread,
  onClose,
}: {
  readonly thread: EnvironmentThreadShell;
  readonly onClose: () => void;
}) {
  const snooze = useAtomCommand(threadEnvironment.snooze);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1 items-center justify-center bg-backdrop px-6"
      >
        <View className="w-full max-w-md gap-4 rounded-3xl bg-screen p-6">
          <Text accessibilityRole="header" className="text-xl font-t3-semibold">
            Until a GitHub reply
          </Text>
          <Text>
            Paste a github.com PR or repository discussion URL. Open, merged and closed PRs are
            supported. New comments by other accounts wake this thread without running an agent.
          </Text>
          <Text>
            A discussion comment link watches its replies. PR links watch all conversation comments.
          </Text>
          <TextInput
            accessibilityLabel="GitHub conversation URL"
            autoCapitalize="none"
            autoCorrect={false}
            value={url}
            onChangeText={setUrl}
            placeholder="https://github.com/owner/repo/pull/123"
            className="min-h-12 rounded-xl bg-subtle p-3 text-foreground"
          />
          {error ? <Text accessibilityRole="alert">{error}</Text> : null}
          <View className="flex-row justify-end gap-6">
            <Pressable accessibilityRole="button" onPress={onClose} disabled={pending}>
              <Text>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={pending}
              onPress={() => {
                const target = parseGitHubConversationUrl(url.trim());
                if (!target) {
                  setError("Use a github.com pull request or repository discussion URL.");
                  return;
                }
                setPending(true);
                void snooze({
                  environmentId: thread.environmentId,
                  input: { threadId: thread.id, url: target.url },
                }).then((result) => {
                  setPending(false);
                  if (result._tag === "Success") onClose();
                  else
                    setError(
                      "Could not snooze this thread. Respond to pending requests and try again.",
                    );
                });
              }}
            >
              <Text>{pending ? "Saving..." : "Snooze"}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function GitHubReplySnoozeCard({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const unsnooze = useAtomCommand(threadEnvironment.unsnooze);
  const watch = thread.githubReplySnooze;
  const notice = thread.githubReplyNotice;
  if (!watch && !notice) return null;
  const url = watch?.url ?? notice!.url;
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-border bg-background p-3">
      <Text className="font-t3-semibold">
        {watch
          ? "Waiting for a GitHub reply"
          : notice?.type === "reply"
            ? `GitHub reply from ${notice.author}`
            : "GitHub reply snooze stopped"}
      </Text>
      {watch ? (
        <Text>
          {watch.status === "pending"
            ? "Checking GitHub access..."
            : watch.status === "rate-limited"
              ? "GitHub rate limit reached. Checks are paused until it resets."
              : watch.status === "retrying"
                ? "GitHub check failed. Retrying..."
                : "Checked every two minutes."}
        </Text>
      ) : (
        <ScrollView style={{ maxHeight: 140 }}>
          <Text selectable>{notice?.text}</Text>
        </ScrollView>
      )}
      <View className="flex-row gap-6">
        <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(url)}>
          <Text>Open on GitHub</Text>
        </Pressable>
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
