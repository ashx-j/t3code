import { assert, it } from "@effect/vitest";

import { commitFromLsRemote } from "./pluginUpdates.ts";

const head = "a".repeat(40);
const tag = "b".repeat(40);
const peeled = "c".repeat(40);
const other = "d".repeat(40);

it.each([
  ["HEAD", undefined, `${head}\tHEAD\n`, head],
  [
    "a branch, not one whose name ends the same",
    "main",
    `${other}\trefs/heads/backup/main\n${head}\trefs/heads/main\n`,
    head,
  ],
  [
    "an annotated tag, by its commit",
    "v1",
    `${tag}\trefs/tags/v1\n${peeled}\trefs/tags/v1^{}\n`,
    peeled,
  ],
  ["nothing that matched", "main", `${other}\trefs/heads/backup/main\n`, undefined],
  ["a line that is not a ref", undefined, "fatal: not a repository\n", undefined],
] as const)("reads %s from git ls-remote", (_name, ref, output, expected) => {
  assert.strictEqual(commitFromLsRemote(output, ref), expected);
});
