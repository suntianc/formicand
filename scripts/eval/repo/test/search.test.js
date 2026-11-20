import test from "node:test";
import assert from "node:assert/strict";
import { search } from "../src/search.js";

const items = [
  { id: 1, itemTitle: "Buy milk", done: false, tags: [] },
  { id: 2, itemTitle: "Call bank", done: false, tags: ["work"] }
];

test("search matches titles case-insensitively and tags exactly", () => {
  assert.deepEqual(
    search(items, "MILK").map((item) => item.id),
    [1]
  );
  assert.deepEqual(
    search(items, "work").map((item) => item.id),
    [2]
  );
});
