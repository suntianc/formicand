import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { repo } from "./helpers.js";

const { paginate } = await import(join(repo, "src/paginate.js"));
const items = Array.from({ length: 25 }, (_, index) => index + 1);

test("pages are numbered from 1 and the last page is partial", () => {
  assert.deepEqual(paginate(items, 1, 10), items.slice(0, 10));
  assert.deepEqual(paginate(items, 3, 10), [21, 22, 23, 24, 25]);
  assert.deepEqual(paginate(items, 4, 10), []);
});
