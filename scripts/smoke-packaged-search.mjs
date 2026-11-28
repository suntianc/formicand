// Run by the candidate's Electron in Node mode. Only dependencies in the candidate qualify.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, sep } from "node:path";

const [appRoot, project] = process.argv.slice(2);
const require = createRequire(join(appRoot, "package.json"));
const entry = realpathSync(require.resolve("@ff-labs/fff-node"));
const local = relative(appRoot, entry);
assert.ok(
  local !== ".." && !local.startsWith(".." + sep) && !isAbsolute(local),
  "FFF must resolve inside the package"
);
const { FileFinder } = require(entry);
const unwrap = (result) => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const finder = unwrap(FileFinder.create({ basePath: project, aiMode: true, followSymlinks: false }));
try {
  assert.ok(unwrap(await finder.waitForScan(30000)), "FFF scan timed out");
  for (const result of [
    finder.fileSearch("package-probe.txt"),
    finder.grep("formicand native search marker")
  ])
    assert.ok(
      unwrap(result).items.some((item) => item.relativePath === "package-probe.txt"),
      "packaged FFF missed the smoke fixture"
    );
} finally {
  finder.destroy();
}
