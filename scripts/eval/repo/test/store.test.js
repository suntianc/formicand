import test from "node:test";
import assert from "node:assert/strict";
import { add, complete, normalize } from "../src/store.js";

test("normalize fills missing fields", () => {
  assert.deepEqual(normalize({ itemTitle: "  milk " }, 2), {
    id: 3,
    itemTitle: "milk",
    done: false,
    tags: []
  });
});

test("add numbers after the highest id", () => {
  const items = add([{ id: 4, itemTitle: "a", done: false, tags: [] }], "b");
  assert.equal(items[1].id, 5);
  assert.equal(items[1].itemTitle, "b");
});

test("complete marks one item and rejects unknown ids", () => {
  const items = complete([{ id: 1, itemTitle: "a", done: false, tags: [] }], 1);
  assert.equal(items[0].done, true);
  assert.throws(() => complete(items, 9));
});
