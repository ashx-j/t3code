import {
  githubReplyConversationLabel,
  githubReplyConversationsForCondition,
  type GitHubReplySnoozeChoice,
  type GitHubReplyConversation,
} from "@t3tools/client-runtime/github-reply-conversations";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "./ui/menu";

/** Several saved conversations extend the current menu from this row. */
export function GitHubReplySnoozeMenuItem({
  conversations,
  onSnooze,
  wakeCondition,
}: {
  conversations: ReadonlyArray<GitHubReplyConversation>;
  onSnooze: (choice: GitHubReplySnoozeChoice) => void;
  wakeCondition?: GitHubReplySnoozeChoice["wakeCondition"];
}) {
  conversations = githubReplyConversationsForCondition(conversations, wakeCondition);
  const label =
    wakeCondition === "changes-requested" ? "Until changes are requested" : "Until a GitHub reply";
  const only = conversations.length === 1 ? conversations[0] : undefined;
  if (conversations.length < 2) {
    return (
      <MenuItem
        disabled={!only}
        onClick={(event) => {
          event.stopPropagation();
          if (only) onSnooze({ url: only.url, wakeCondition });
        }}
      >
        <span className="flex flex-col gap-0.5">
          <span>{label}</span>
          {!only ? (
            <span className="text-xs text-muted-foreground">
              {wakeCondition === "changes-requested"
                ? "Link an open GitHub PR first"
                : "Link a GitHub PR or discussion first"}
            </span>
          ) : null}
        </span>
      </MenuItem>
    );
  }
  return (
    <MenuSub>
      <MenuSubTrigger openOnHover={false} onClick={(event) => event.stopPropagation()}>
        {label}
      </MenuSubTrigger>
      <MenuSubPopup animated className="max-w-80">
        {conversations.map((conversation) => (
          <MenuItem
            key={conversation.url}
            onClick={(event) => {
              event.stopPropagation();
              onSnooze({ url: conversation.url, wakeCondition });
            }}
          >
            <Tooltip>
              <TooltipTrigger render={<span className="min-w-0 truncate" />}>
                {githubReplyConversationLabel(conversation)}
              </TooltipTrigger>
              <TooltipPopup>{githubReplyConversationLabel(conversation)}</TooltipPopup>
            </Tooltip>
          </MenuItem>
        ))}
      </MenuSubPopup>
    </MenuSub>
  );
}

/** Received notices preserve their original scope; older notices choose from saved links. */
export function GitHubReplySnoozeButton({
  conversationUrl,
  wakeCondition,
  conversations,
  pending,
  onSnooze,
}: {
  conversationUrl?: string | null;
  wakeCondition?: GitHubReplySnoozeChoice["wakeCondition"];
  conversations: ReadonlyArray<GitHubReplyConversation>;
  pending: boolean;
  onSnooze: (url: string) => void;
}) {
  conversations = githubReplyConversationsForCondition(conversations, wakeCondition);
  const originalUrl =
    wakeCondition === "changes-requested"
      ? conversations.find(
          (conversation) =>
            conversation.url.toLowerCase() === conversationUrl?.split("#")[0]?.toLowerCase(),
        )?.url
      : conversationUrl;
  const directUrl =
    conversationUrl == null
      ? conversations.length === 1
        ? conversations[0]?.url
        : undefined
      : originalUrl;
  if ((conversationUrl != null && !originalUrl) || (!directUrl && conversations.length === 0)) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button size="xs" variant="ghost" disabled>
            Snooze
          </Button>
        </TooltipTrigger>
        <TooltipPopup>
          {wakeCondition === "changes-requested"
            ? "Link an open GitHub PR first"
            : "Link a GitHub PR or discussion first"}
        </TooltipPopup>
      </Tooltip>
    );
  }
  if (directUrl) {
    return (
      <Button size="xs" variant="ghost" disabled={pending} onClick={() => onSnooze(directUrl)}>
        {pending ? "Snoozing..." : "Snooze"}
      </Button>
    );
  }
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="ghost" disabled={pending} />}>
        {pending ? "Snoozing..." : "Snooze"}
      </MenuTrigger>
      <MenuPopup side="top" align="end" className="max-w-80">
        {conversations.map((conversation) => (
          <MenuItem key={conversation.url} onClick={() => onSnooze(conversation.url)}>
            <Tooltip>
              <TooltipTrigger render={<span className="min-w-0 truncate" />}>
                {githubReplyConversationLabel(conversation)}
              </TooltipTrigger>
              <TooltipPopup>{githubReplyConversationLabel(conversation)}</TooltipPopup>
            </Tooltip>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
