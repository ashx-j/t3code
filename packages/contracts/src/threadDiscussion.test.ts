import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  GitHubDiscussionUrl,
  GitHubDiscussionDetail,
  GitHubDiscussionCommentInput,
  ThreadDiscussionKey,
  ThreadDiscussionLink,
} from "./threadDiscussion.ts";

const decodeLink = Schema.decodeUnknownSync(ThreadDiscussionLink);
const decodeDetail = Schema.decodeUnknownSync(GitHubDiscussionDetail);

describe("discussion contracts", () => {
  it("accepts whole discussions and explicit comment scopes", () => {
    const decode = Schema.decodeUnknownSync(GitHubDiscussionUrl);
    expect(decode("https://github.com/team/repo/discussions/1")).toBe(
      "https://github.com/team/repo/discussions/1",
    );
    expect(decode("https://github.com/team/repo/discussions/1#discussioncomment-2")).toContain(
      "#discussioncomment-2",
    );
  });
  it("rejects other hosts, pull requests and malformed repositories", () => {
    const decodeUrl = Schema.decodeUnknownSync(GitHubDiscussionUrl);
    for (const url of [
      "https://github.example/team/repo/discussions/1",
      "https://github.com/team/repo/pull/1",
      "https://github.com/team/repo/discussions/0",
    ])
      expect(() => decodeUrl(url)).toThrow();
    const decodeKey = Schema.decodeUnknownSync(ThreadDiscussionKey);
    for (const repository of ["team", "team/repo/extra", "team/repo?query"])
      expect(() => decodeKey({ host: "github.com", repository, number: 1 })).toThrow();
  });
  it("retains the association without requiring PR state", () => {
    const link = {
      host: "github.com",
      repository: "team/repo",
      number: 1,
      url: "https://github.com/team/repo/discussions/1",
      title: null,
      source: "agent",
      linkedAt: "2026-10-07T12:00:00Z",
    };
    expect(decodeLink(link)).toEqual(link);
  });

  it("reads detail responses from environments without discussion interactions", () => {
    const oldDetail = {
      number: 1,
      url: "https://github.com/team/repo/discussions/1",
      title: "Discussion",
      body: "Text",
      author: null,
      createdAt: "2026-10-01T12:00:00Z",
      updatedAt: "2026-10-01T12:00:00Z",
      closed: false,
      isAnswered: false,
      category: null,
      comments: [],
    };
    expect(decodeDetail(oldDetail)).toEqual(oldDetail);
  });

  it("validates comment text without removing markdown indentation", () => {
    const decode = Schema.decodeUnknownSync(GitHubDiscussionCommentInput);
    const input = {
      threadId: "thread",
      url: "https://github.com/team/repo/discussions/1",
      body: "    indented code\n",
    };
    expect(decode(input).body).toBe(input.body);
    for (const body of [" \n\t", "a".repeat(65_537)])
      expect(() => decode({ ...input, body })).toThrow();
  });
});
