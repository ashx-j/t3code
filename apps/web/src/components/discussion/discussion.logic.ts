import type { GitHubDiscussionDetail } from "@t3tools/contracts";

export type DiscussionCommentSort = "oldest" | "newest" | "top";

/** counts identifiable authors in the loaded preview, including the discussion author. */
export function discussionParticipants(
  detail: Pick<GitHubDiscussionDetail, "author" | "comments">,
) {
  const participants = new Map<string, NonNullable<GitHubDiscussionDetail["author"]>>();
  const add = (author: GitHubDiscussionDetail["author"]) => {
    if (author) participants.set(author.login.toLowerCase(), author);
  };
  add(detail.author);
  for (const comment of detail.comments) {
    add(comment.author);
    for (const reply of comment.replies) add(reply.author);
  }
  return [...participants.values()];
}

export function sortDiscussionComments(
  comments: GitHubDiscussionDetail["comments"],
  sort: DiscussionCommentSort,
): GitHubDiscussionDetail["comments"] {
  return comments.toSorted((left, right) => {
    const age = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    if (sort === "top") return (right.upvoteCount ?? 0) - (left.upvoteCount ?? 0) || age;
    return sort === "newest" ? -age : age;
  });
}

/** an anchor outside the preview must remain reachable through the original github link. */
export function discussionHasAnchor(
  detail: Pick<GitHubDiscussionDetail, "url" | "comments">,
  anchor: string,
) {
  if (!anchor || new URL(detail.url).hash.slice(1) === anchor) return true;
  return detail.comments.some(
    (comment) =>
      new URL(comment.url).hash.slice(1) === anchor ||
      comment.replies.some((reply) => new URL(reply.url).hash.slice(1) === anchor),
  );
}
