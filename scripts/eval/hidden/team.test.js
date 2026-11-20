import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { todo } from "./helpers.js";

const lines = (out) => out.split("\n").filter((line) => /\d+\./.test(line));
const csvFile = (text) => {
  const file = join(mkdtempSync(join(tmpdir(), "todo-import-")), "in.csv");
  writeFileSync(file, text);
  return file;
};

test("add --priority marks high and low in list; normal shows nothing", () => {
  const run = todo();
  assert.equal(run("add", "urgent", "--priority", "high").code, 0);
  assert.equal(run("add", "plain").code, 0);
  assert.equal(run("add", "someday", "--priority", "low").code, 0);
  const out = run("list").out;
  assert.match(out, /urgent.*\[high\]/);
  assert.match(out, /someday.*\[low\]/);
  assert.doesNotMatch(out, /plain.*\[(high|normal|low)\]/);
});

test("an unknown priority fails without writing", () => {
  const run = todo();
  assert.notEqual(run("add", "x", "--priority", "urgent").code, 0);
  assert.match(run("list").out, /\(empty\)/);
});

test("list --sort priority orders high, normal, low, then by id", () => {
  const run = todo();
  run("add", "a", "--priority", "low");
  run("add", "b");
  run("add", "c", "--priority", "high");
  run("add", "d");
  const order = lines(run("list", "--sort", "priority").out).map((line) => line.match(/\d+\. (\w)/)[1]);
  assert.deepEqual(order, ["c", "b", "d", "a"]);
});

test("export keeps the first four columns in place and adds priority after them", () => {
  const run = todo();
  run("add", "pay, rent", "--tag", "home", "--priority", "high");
  const [header, row] = run("export").out.trim().split("\n");
  assert.equal(header, "id,title,done,tags,priority");
  assert.equal(row, '1,"pay, rent",false,home,high');
});

test("an old data file without priorities still lists and exports as normal", () => {
  const run = todo([{ id: 1, itemTitle: "old", done: false, tags: [] }]);
  assert.match(run("list").out, /1\. old/);
  assert.doesNotMatch(run("list").out, /\[(high|normal|low)\]/);
  assert.equal(run("export").out.trim().split("\n")[1], "1,old,false,,normal");
});

test("import reads back what export wrote, appending with new ids", () => {
  const source = todo();
  source("add", 'say "hi", then leave', "--priority", "low");
  source("add", "plain");
  source("done", "2");
  const file = csvFile(source("export").out);
  const target = todo([{ id: 1, itemTitle: "existing", done: false, tags: [] }]);
  const result = target("import", file);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /imported: 2/);
  const out = target("list").out;
  assert.match(out, /1\. existing/);
  assert.match(out, /2\. say "hi", then leave.*\[low\]/);
  assert.match(out, /\[x\] 3\. plain/);
});

test("import with a wrong header fails and writes nothing", () => {
  const run = todo([{ id: 1, itemTitle: "keep", done: false, tags: [] }]);
  const file = csvFile("name,state\nx,false\n");
  assert.notEqual(run("import", file).code, 0);
  assert.deepEqual(lines(run("list").out), ["[ ] 1. keep"]);
});
