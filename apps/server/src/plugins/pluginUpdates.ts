/** The refs `git clone --branch <ref>` may clone, for `git ls-remote`; `HEAD` without a ref. */
export const lsRemotePatterns = (ref: string | undefined): ReadonlyArray<string> =>
  ref === undefined ? ["HEAD"] : [`refs/heads/${ref}`, `refs/tags/${ref}`];

/**
 * The commit `git clone --branch <ref>` fetches, read from `git ls-remote`: the branch, else the
 * tag's peeled commit (`^{}`) or the tag. Names must match exactly, because ls-remote also lists
 * refs that only end with the pattern, such as `refs/heads/backup/main`.
 */
export const commitFromLsRemote = (output: string, ref: string | undefined): string | undefined => {
  const commits = new Map<string, string>();
  for (const line of output.split("\n")) {
    const [commit, name] = line.trim().split(/\s+/);
    if (commit !== undefined && name !== undefined && /^[0-9a-f]{40,64}$/.test(commit)) {
      commits.set(name, commit);
    }
  }
  const wanted =
    ref === undefined ? ["HEAD"] : [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`];
  return wanted.map((name) => commits.get(name)).find((commit) => commit !== undefined);
};
