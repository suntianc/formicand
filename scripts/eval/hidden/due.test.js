import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { todo } from "./helpers.js";

const today = { TODO_TODAY: "2026-03-10" };

test("add --due stores the date and list shows it", () => {
  const run = todo([], today);
  assert.equal(run("add", "pay rent", "--due", "2026-03-15").code, 0);
  assert.match(run("list").out, /pay rent.*\(due 2026-03-15\)/);
});

test("a malformed due date fails without writing", () => {
  const run = todo([], today);
  assert.notEqual(run("add", "x", "--due", "15/03/2026").code, 0);
  assert.notEqual(run("add", "y", "--due", "2026-02-30").code, 0);
  assert.match(run("list").out, /\(empty\)/);
});

test("an open item past its date is overdue; a done one is not", () => {
  const run = todo([], today);
  run("add", "late", "--due", "2026-03-01");
  run("add", "finished", "--due", "2026-03-01");
  run("done", "2");
  run("add", "future", "--due", "2026-04-01");
  const out = run("list").out;
  assert.match(out, /late.*\(due 2026-03-01\) overdue/);
  assert.doesNotMatch(out, /finished.*overdue/);
  assert.doesNotMatch(out, /future.*overdue/);
});

test("list --sort due orders by date, undated last", () => {
  const run = todo([], today);
  run("add", "none");
  run("add", "april", "--due", "2026-04-01");
  run("add", "march", "--due", "2026-03-20");
  const order = run("list", "--sort", "due")
    .out.split("\n")
    .filter((line) => /\d+\./.test(line))
    .map((line) => line.match(/\d+\. (\w+)/)[1]);
  assert.deepEqual(order, ["march", "april", "none"]);
});

test("the README documents --due", () => {
  assert.match(readFileSync(`${process.env.EVAL_REPO}/README.md`, "utf8"), /--due/);
});
