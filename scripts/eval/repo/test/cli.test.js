import test from "node:test";
import assert from "node:assert/strict";
import { todo } from "./helpers.js";

test("add, done and list work together", () => {
  const run = todo();
  run("add", "Buy", "milk", "--tag", "home");
  run("add", "Call bank");
  run("done", "2");
  assert.equal(run("list").out, "[ ] 1. Buy milk #home\n[x] 2. Call bank\npage 1/1\n");
});

test("export writes a CSV header and rows", () => {
  const run = todo([{ id: 1, itemTitle: "a, b", done: false, tags: [] }]);
  assert.equal(run("export").out, 'id,title,done,tags\n1,"a, b",false,\n');
});

test("an unknown command fails", () => {
  assert.equal(run().code, 1);
  function run() {
    return todo()("frobnicate");
  }
});
