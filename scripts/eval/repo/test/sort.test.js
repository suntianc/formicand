import test from "node:test";
import assert from "node:assert/strict";
import { sortItems } from "../src/sort.js";

test("sortItems orders by title, then id", () => {
  const items = [
    { id: 1, itemTitle: "b", done: false, tags: [] },
    { id: 2, itemTitle: "a", done: false, tags: [] },
    { id: 3, itemTitle: "a", done: false, tags: [] }
  ];
  assert.deepEqual(
    sortItems(items, "title").map((item) => item.id),
    [2, 3, 1]
  );
  assert.throws(() => sortItems(items, "size"));
});
