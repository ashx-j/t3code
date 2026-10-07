import type { GitHubDiscussionDetail } from "@t3tools/contracts";

export type DiscussionCommentSort = "oldest" | "newest" | "top";

/** the reader loads every comment and reply page, so all identifiable authors count. */
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
