import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { todo, repo } from "./helpers.js";

const { normalize } = await import(join(repo, "src/store.js"));

test("records use title", () => {
  assert.deepEqual(normalize({ title: "a" }, 0), { id: 1, title: "a", done: false, tags: [] });
});

test("an old record's itemTitle is still read", () => {
  assert.equal(normalize({ itemTitle: "old" }, 0).title, "old");
  const run = todo([{ id: 1, itemTitle: "legacy", done: false, tags: [] }]);
  assert.match(run("list").out, /1\. legacy/);
});

test("new records are saved with title", () => {
  const run = todo();
  run("add", "fresh");
  assert.match(run("export").out, /1,fresh,false/);
});
