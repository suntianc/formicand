import test from "node:test";
import assert from "node:assert/strict";
import { todo } from "./helpers.js";

const items = [
  { id: 1, itemTitle: "open", done: false, tags: [] },
  { id: 2, itemTitle: "closed", done: true, tags: [] }
];

test("--done lists completed items only", () => {
  const { code, out } = todo(items)("list", "--done");
  assert.equal(code, 0);
  assert.match(out, /closed/);
  assert.doesNotMatch(out, /open/);
});

test("--todo lists open items only", () => {
  const { code, out } = todo(items)("list", "--todo");
  assert.equal(code, 0);
  assert.match(out, /open/);
  assert.doesNotMatch(out, /closed/);
});

test("--done and --todo together fail", () => {
  assert.notEqual(todo(items)("list", "--done", "--todo").code, 0);
});

test("a plain list still shows both", () => {
  const { out } = todo(items)("list");
  assert.match(out, /open/);
  assert.match(out, /closed/);
});
