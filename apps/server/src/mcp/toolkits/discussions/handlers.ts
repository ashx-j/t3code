import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Effect from "effect/Effect";
import * as ThreadDiscussionMcpService from "../../ThreadDiscussionMcpService.ts";
import { DiscussionsToolkit } from "./tools.ts";

export const layer = DiscussionsToolkit.toLayer(
  Effect.gen(function* () {
    const service = yield* ThreadDiscussionMcpService.ThreadDiscussionMcpService;
    return DiscussionsToolkit.of({
      link_discussion: (input) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => service.link(scope, input)),
        ),
      unlink_discussion: (input) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => service.unlink(scope, input)),
        ),
      list_thread_discussions: (input) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => service.list(scope, input)),
        ),
    });
  }),
);
