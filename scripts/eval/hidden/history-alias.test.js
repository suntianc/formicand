import test from "node:test";
import assert from "node:assert/strict";
import { todo } from "./helpers.js";

// The rule on old items comes from the creation-date feature's summary in the
// ledger; the prompt calls the feature 添加时间 and names no rule.
const items = [
  { id: 1, itemTitle: "early", done: false, tags: [], created: "2026-03-01" },
  { id: 2, itemTitle: "late", done: false, tags: [], created: "2026-03-05" },
  { id: 3, itemTitle: "old item", done: false, tags: [] }
];

test("--since lists the items created on or after the day", () => {
  const out = todo(items)("list", "--since", "2026-03-05").out;
  assert.match(out, /late/);
  assert.doesNotMatch(out, /early/);
});

test("an old item without a creation date is kept by --since", () => {
  assert.match(todo(items)("list", "--since", "2026-03-03").out, /old item/);
});

test("a malformed date fails the agreed way", () => {
  const run = todo(items)("list", "--since", "03/05/2026");
  assert.equal(run.code, 1);
  assert.match(run.err, /^error: /);
});
