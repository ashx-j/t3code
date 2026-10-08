import { CommandId } from "./baseSchemas.ts";
import { GitHubReplyNotice, GitHubReplySnooze } from "./githubReply.ts";
import { OrchestrationV2Command } from "./orchestrationV2.ts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

const decodeSnooze = Schema.decodeUnknownSync(GitHubReplySnooze);
const decodeNotice = Schema.decodeUnknownSync(GitHubReplyNotice);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);

const legacy = {
  requestId: CommandId.make("legacy-snooze"),
  url: "https://github.com/team/repo/pull/1",
  startedAt: "2026-10-01T12:00:00Z",
  nextCheckAt: "2026-10-01T12:02:00Z",
  status: "watching",
  failures: 0,
  baseline: { latestAt: null, ids: [] },
};

it("keeps saved snoozes without a wake condition compatible and roundtrips the new condition", () => {
  expect(decodeSnooze(legacy).wakeCondition).toBeUndefined();
  const saved = { ...legacy, wakeCondition: "changes-requested" };
  expect(decodeSnooze(saved).wakeCondition).toBe("changes-requested");
  expect(() => decodeSnooze({ ...legacy, wakeCondition: "negative-sentiment" })).toThrow();
  const notice = decodeNotice({
    type: "reply",
    url: legacy.url,
    receivedAt: legacy.startedAt,
    text: "",
    wakeCondition: "changes-requested",
  });
  expect(notice.wakeCondition).toBe("changes-requested");
});

it("rejects unsupported GitHub snooze URLs at the command boundary", () => {
  const command = {
    type: "thread.github-reply.snooze",
    commandId: "snooze",
    threadId: "thread",
    wakeCondition: "changes-requested",
  };
  for (const url of [
    "https://example.com/pr/1",
    "https://github.com/team/repo/issues/1",
    "https://ghe.example/team/repo/pull/1",
  ]) {
    expect(() => decodeCommand({ ...command, url })).toThrow();
  }
  expect(decodeCommand({ ...command, url: legacy.url })).toMatchObject({
    wakeCondition: "changes-requested",
  });
});
