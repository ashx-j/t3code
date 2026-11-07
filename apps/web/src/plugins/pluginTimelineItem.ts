import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import type { WebPluginTimelineItem } from "@t3tools/plugin-sdk/web";

/** The step `timeline.item` hands plugins, so a change to T3's turn items never reaches them. */
export function toPluginTimelineItem(item: OrchestrationV2TurnItem): WebPluginTimelineItem {
  const step = { id: item.id, threadId: item.threadId, title: item.title, status: item.status };
  switch (item.type) {
    case "command_execution":
      return { ...step, type: "command", command: item.input, exitCode: item.exitCode ?? null };
    case "file_change":
      return {
        ...step,
        type: "file_change",
        path: item.fileName,
        additions: item.additions ?? null,
        deletions: item.deletions ?? null,
      };
    case "file_search":
      return { ...step, type: "file_search", pattern: item.pattern ?? null };
    case "web_search":
      return { ...step, type: "web_search", queries: item.patterns ?? [] };
    case "dynamic_tool":
      return { ...step, type: "tool", toolName: item.toolName, input: item.input };
    case "reasoning":
      return { ...step, type: "reasoning", text: item.text };
    default:
      return { ...step, type: "other" };
  }
}
