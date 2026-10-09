import { describe, expect, it } from "vite-plus/test";
import {
  discussionHasAnchor,
  discussionParticipants,
  sortDiscussionComments,
} from "./discussion.logic";

const comments = [
  { id: "old", createdAt: "2026-10-01T12:00:00Z", upvoteCount: 1 },
  { id: "popular", createdAt: "2026-10-02T12:00:00Z", upvoteCount: 5 },
  { id: "new", createdAt: "2026-10-03T12:00:00Z", upvoteCount: 1 },
].map((comment) => ({
  ...comment,
  updatedAt: comment.createdAt,
  url: "https://github.com/team/repo/discussions/1",
  author: null,
  body: "Comment",
  replies: [],
}));

describe("discussion comment sorting", () => {
  it("sorts by age or upvotes without moving replies or changing the cached order", () => {
    expect(sortDiscussionComments(comments, "oldest").map((comment) => comment.id)).toEqual([
      "old",
      "popular",
      "new",
    ]);
    expect(sortDiscussionComments(comments, "newest").map((comment) => comment.id)).toEqual([
      "new",
      "popular",
      "old",
    ]);
    expect(sortDiscussionComments(comments, "top").map((comment) => comment.id)).toEqual([
      "popular",
      "old",
      "new",
    ]);
    expect(comments.map((comment) => comment.id)).toEqual(["old", "popular", "new"]);
    expect(sortDiscussionComments(comments, "top")[0]?.replies).toBe(comments[1]?.replies);
  });
});

describe("discussion participants", () => {
  const author = (login: string) => ({
    login,
    avatarUrl: `https://github.com/${login}.png`,
    url: `https://github.com/${login}`,
  });

  it("counts distinct authors across the discussion, comments and replies, excluding deleted accounts", () => {
    const opener = author("opener");
    const commenter = author("commenter");
    const replier = author("replier");
    expect(
      discussionParticipants({
        author: opener,
        comments: [
          {
            ...comments[0]!,
            author: commenter,
            replies: [
              { ...comments[0]!, author: replier },
              { ...comments[0]!, author: author("OPENER") },
              { ...comments[0]!, author: null },
            ],
          },
          { ...comments[1]!, author: commenter },
          { ...comments[2]!, author: null },
        ],
      }).map((participant) => participant.login.toLowerCase()),
    ).toEqual(["opener", "commenter", "replier"]);
  });

  it("includes a newly posted reply author when the cached detail changes", () => {
    const detail = { author: author("opener"), comments: [comments[0]!] };
    const updated = {
      ...detail,
      comments: [
        { ...comments[0]!, replies: [{ ...comments[1]!, author: author("new-replier") }] },
      ],
    };
    expect(discussionParticipants(detail)).toHaveLength(1);
    expect(discussionParticipants(updated).map((participant) => participant.login)).toEqual([
      "opener",
      "new-replier",
    ]);
  });
});

describe("discussion anchor fallback", () => {
  const url = "https://github.com/team/repo/discussions/1";
  const detail = {
    url,
    comments: [
      {
        ...comments[0]!,
        url: `${url}#discussioncomment-1`,
        replies: [{ ...comments[1]!, url: `${url}#discussioncomment-2` }],
      },
    ],
  };

  it("keeps loaded root and reply anchors in the reader", () => {
    expect(discussionHasAnchor(detail, "")).toBe(true);
    expect(discussionHasAnchor(detail, "discussioncomment-1")).toBe(true);
    expect(discussionHasAnchor(detail, "discussioncomment-2")).toBe(true);
  });

  it("requires a github fallback for anchors outside the loaded preview", () => {
    expect(discussionHasAnchor(detail, "discussioncomment-99")).toBe(false);
    expect(discussionHasAnchor(detail, "discussion-123")).toBe(false);
  });
});
