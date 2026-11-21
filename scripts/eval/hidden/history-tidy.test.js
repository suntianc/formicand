import test from "node:test";
import assert from "node:assert/strict";
import { todo } from "./helpers.js";

const items = [
  { id: 1, itemTitle: "open", done: false, tags: [] },
  { id: 2, itemTitle: "closed", done: true, tags: ["a"] }
];

test("export --done writes only the done items, under the fixed header", () => {
  const out = todo(items)("export", "--done").out.trim().split("\n");
  assert.deepEqual(out, ["id,title,done,tags", "2,closed,true,a"]);
});

test("export without --done still writes every item", () => {
  assert.equal(todo(items)("export").out.trim().split("\n").length, 3);
});
