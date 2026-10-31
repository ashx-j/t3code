import { assert, it } from "@effect/vitest";

import { commitFromLsRemote } from "./pluginUpdates.ts";

const head = "a".repeat(40);
const tag = "b".repeat(40);
const peeled = "c".repeat(40);

it.each([
  ["a branch or HEAD", `${head}\tHEAD\n`, head],
  ["an annotated tag, by its commit", `${tag}\trefs/tags/v1\n${peeled}\trefs/tags/v1^{}\n`, peeled],
  ["nothing that matched", "", undefined],
  ["a line that is not a ref", "fatal: not a repository\n", undefined],
])("reads %s from git ls-remote", (_name, output, expected) => {
  assert.strictEqual(commitFromLsRemote(output), expected);
});
