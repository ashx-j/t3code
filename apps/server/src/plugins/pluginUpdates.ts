/**
 * The commit `git ls-remote <url> <ref>` names: a tag's peeled commit (`^{}`) when the remote
 * lists one, else the first match.
 */
export const commitFromLsRemote = (output: string): string | undefined => {
  const entries = output.split("\n").flatMap((line) => {
    const [commit, ref] = line.trim().split(/\s+/);
    return commit !== undefined && ref !== undefined && /^[0-9a-f]{40,64}$/.test(commit)
      ? [{ commit, ref }]
      : [];
  });
  return (entries.find((entry) => entry.ref.endsWith("^{}")) ?? entries[0])?.commit;
};
