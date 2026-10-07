import {
  DiscussionOperationError,
  McpCapabilityUnavailableError,
  PositiveInt,
  ThreadDiscussionLink,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadDiscussionMcpService from "../../ThreadDiscussionMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadDiscussionMcpService.ThreadDiscussionMcpService,
];
const target = Schema.Struct({
  threadId: Schema.optional(
    ThreadId.annotate({ description: "Thread to act on. Omit for this thread." }),
  ),
  url: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "GitHub discussion URL, for example https://github.com/owner/repo/discussions/123.",
    }),
  ),
  repository: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "owner/repo, required with number when url is omitted.",
    }),
  ),
  number: Schema.optional(PositiveInt),
  host: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Only github.com is supported. Defaults to github.com.",
    }),
  ),
});
const identity = {
  host: Schema.Literal("github.com"),
  repository: Schema.String,
  number: PositiveInt,
};
const failure = Schema.Union([DiscussionOperationError, McpCapabilityUnavailableError]);

const LinkDiscussionTool = Tool.make("link_discussion", {
  description:
    "Link a GitHub discussion you create or work on to this thread, so the user can open it or choose it when snoozing until a reply. Call after creating or commenting on a discussion. Pass its URL, or repository plus number. Repeated links succeed with alreadyLinked=true. Linking does not start monitoring, wake an agent, or settle the thread.",
  parameters: target,
  success: Schema.Struct({ ...identity, url: Schema.String, alreadyLinked: Schema.Boolean }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Link discussion to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnlinkDiscussionTool = Tool.make("unlink_discussion", {
  description:
    "Remove a discussion link from this thread. Pass the URL, or repository plus number. An absent link succeeds with wasLinked=false. This does not delete anything on GitHub.",
  parameters: target,
  success: Schema.Struct({ ...identity, wasLinked: Schema.Boolean }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Unlink discussion from thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadDiscussionsTool = Tool.make("list_thread_discussions", {
  description:
    "List saved GitHub discussion links and their known titles. Omit threadId for this thread. Before finishing discussion work, link any discussion you created or commented on that is missing.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({ discussions: Schema.Array(ThreadDiscussionLink) }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "List thread discussions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const DiscussionsToolkit = Toolkit.make(
  LinkDiscussionTool,
  UnlinkDiscussionTool,
  ListThreadDiscussionsTool,
);
