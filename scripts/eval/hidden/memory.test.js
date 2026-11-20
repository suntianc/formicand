import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { todo, repo } from "./helpers.js";

test("rm works", () => {
  const run = todo([
    { id: 1, itemTitle: "a", done: false, tags: [] },
    { id: 2, itemTitle: "b", done: false, tags: [] }
  ]);
  assert.match(run("rm", "1").out, /removed: 1/);
  assert.doesNotMatch(run("list").out, /1\. a/);
});

test("the second conversation kept the changelog rule", () => {
  const lines = readFileSync(join(repo, "CHANGELOG.md"), "utf8").split("\n");
  // The rule is what is checked, not its exact wording.
  assert.equal(lines.filter((line) => /^- count\b/.test(line)).length, 1);
  assert.equal(lines.filter((line) => /^- rm\b/.test(line)).length, 1);
});
