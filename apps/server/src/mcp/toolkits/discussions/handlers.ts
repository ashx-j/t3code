import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Effect from "effect/Effect";
import * as ThreadDiscussionMcpService from "../../ThreadDiscussionMcpService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DiscussionsToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const service = yield* ThreadDiscussionMcpService.ThreadDiscussionMcpService;
  return {
    link_discussion: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => service.link(scope, input)),
        ),
    ),
    unlink_discussion: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => service.unlink(scope, input)),
        ),
    ),
    list_thread_discussions: McpToolAccess.reads((input) =>
      McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) => service.list(scope, input)),
      ),
    ),
  } satisfies McpToolAccess.Handlers<typeof DiscussionsToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(DiscussionsToolkit, make);
