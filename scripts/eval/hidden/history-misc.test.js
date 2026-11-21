import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repo } from "./helpers.js";

test("the version is 0.2.0 in package.json and the README", () => {
  assert.equal(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version, "0.2.0");
  assert.match(readFileSync(join(repo, "README.md"), "utf8"), /^Version: 0\.2\.0$/m);
});
