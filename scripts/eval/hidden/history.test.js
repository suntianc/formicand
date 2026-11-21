import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { todo } from "./helpers.js";

// Every expectation below comes from a decision in the project's ledger; the
// prompt only says to follow the rules decided before.
const today = { TODO_TODAY: "2026-03-04" };
const old = [{ id: 1, itemTitle: "old item", done: false, tags: [] }];

test("add records the creation date under the agreed field name, from TODO_TODAY", () => {
  const run = todo([], today);
  assert.equal(run("add", "new item").code, 0);
  const [item] = JSON.parse(readFileSync(run.file, "utf8"));
  assert.equal(item.created, "2026-03-04");
  const list = run("list").out;
  assert.match(list, /new item.*\[created 2026-03-04\]/);
});

test("the date is YYYY-MM-DD, not the retracted MM/DD/YYYY", () => {
  const run = todo([], today);
  run("add", "x");
  const out = run("list").out + run("export").out;
  assert.doesNotMatch(out, /03\/04\/2026/);
});

test("export appends created as the last column and keeps the others in place", () => {
  const run = todo([], today);
  run("add", "x");
  const [header, row] = run("export").out.trim().split("\n");
  assert.equal(header, "id,title,done,tags,created");
  assert.match(row, /^1,x,false,,2026-03-04$/);
});

test("an old item without a creation date still lists and exports, with the column empty", () => {
  const run = todo(old, today);
  const list = run("list");
  assert.equal(list.code, 0);
  assert.match(list.out, /old item/);
  assert.doesNotMatch(list.out, /old item.*\[created/);
  const [, row] = run("export").out.trim().split("\n");
  assert.match(row, /^1,old item,false,,$/);
});
