import test from "node:test";
import assert from "node:assert/strict";
import { paginate, pageCount } from "../src/paginate.js";

const items = Array.from({ length: 25 }, (_, index) => index + 1);

test("the first page starts at the first item", () => {
  assert.deepEqual(paginate(items, 1, 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("pageCount rounds up", () => {
  assert.equal(pageCount(items, 10), 3);
});
