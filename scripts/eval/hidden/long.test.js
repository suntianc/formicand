import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { todo, repo } from "./helpers.js";

const items = () => [
  { id: 1, itemTitle: "a", done: true, tags: ["work"] },
  { id: 2, itemTitle: "b", done: false, tags: [] },
  { id: 3, itemTitle: "c", done: false, tags: ["home", "work"] }
];

test("store.js is untouched", () => {
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const start = git("rev-list", "--max-parents=0", "HEAD");
  assert.equal(git("diff", "--name-only", start, "--", "src/store.js"), "");
});

test("count", () => {
  assert.match(todo(items())("count").out, /total: 3, done: 1/);
});

test("undo", () => {
  const run = todo(items());
  assert.match(run("undo", "1").out, /undone: 1/);
  assert.match(run("count").out, /done: 0/);
});

test("rm keeps the other ids", () => {
  const run = todo(items());
  assert.match(run("rm", "2").out, /removed: 2/);
  const list = run("list").out;
  assert.match(list, /1\. a/);
  assert.match(list, /3\. c/);
  assert.doesNotMatch(list, /2\. b/);
});

test("tag does not repeat a tag", () => {
  const run = todo(items());
  assert.match(run("tag", "1", "work").out, /tagged: 1/);
  run("tag", "2", "home");
  const stats = run("stats").out.trim().split("\n");
  assert.deepEqual(stats, ["home: 2", "work: 2"]);
});

test("every new command reports a missing id the same way", () => {
  for (const command of [
    ["undo", "9"],
    ["rm", "9"],
    ["tag", "9", "x"]
  ]) {
    const result = todo(items())(...command);
    assert.notEqual(result.code, 0, command.join(" "));
    assert.match(result.err, /error: no item 9/, command.join(" "));
  }
});

test("the changelog has one line per command, none repeated", () => {
  const lines = readFileSync(join(repo, "CHANGELOG.md"), "utf8")
    .split("\n")
    .filter((line) => /^- /.test(line));
  for (const name of ["count", "undo", "rm", "tag", "stats"])
    assert.equal(lines.filter((line) => line.startsWith(`- ${name}:`)).length, 1, name);
});

test("the README covers all five commands", () => {
  const readme = readFileSync(join(repo, "README.md"), "utf8");
  for (const name of ["count", "undo", "rm", "tag", "stats"])
    assert.match(readme, new RegExp(`\\b${name}\\b`));
});
