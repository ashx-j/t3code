import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  GitHubDiscussionUrl,
  ThreadDiscussionKey,
  ThreadDiscussionLink,
} from "./threadDiscussion.ts";

const decodeLink = Schema.decodeUnknownSync(ThreadDiscussionLink);

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
});
