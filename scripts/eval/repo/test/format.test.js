import test from "node:test";
import assert from "node:assert/strict";
import { formatItem, formatList } from "../src/format.js";

test("formatItem shows state, id, title and tags", () => {
  assert.equal(formatItem({ id: 2, itemTitle: "milk", done: true, tags: ["home"] }), "[x] 2. milk #home");
});

test("formatList marks an empty list", () => {
  assert.equal(formatList([]), "(empty)");
});
