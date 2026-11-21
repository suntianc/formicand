#!/usr/bin/env node
// Shows what changed upstream in the skills CoworkOS adapted from mattpocock/skills.
//
// Usage: node scripts/upstream-skills.mjs <upstream-clone> [--record]
//   default:  print the upstream diff of every adapted skill between the commit
//             recorded in upstream-skills.json and the clone's HEAD. The bundled
//             copies in .pi/skills/ are edited for CoworkOS, so an upstream
//             change is merged into them by hand, never copied over them.
//   --record: after merging, record the clone's HEAD as the new base.
// The clone is only read: git runs with hooks and fsmonitor off.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), "upstream-skills.json");
const args = process.argv.slice(2);
const clone = args.find((arg) => !arg.startsWith("--"));
if (!clone) {
  console.error("usage: node scripts/upstream-skills.mjs <upstream-clone> [--record]");
  process.exit(2);
}
const config = JSON.parse(readFileSync(CONFIG, "utf8"));

const git = (...gitArgs) => {
  const result = spawnSync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", clone, ...gitArgs],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    console.error(result.stderr.trim() || `git ${gitArgs.join(" ")} failed`);
    process.exit(1);
  }
  return result.stdout;
};

const head = git("rev-parse", "HEAD").trim();
if (args.includes("--record")) {
  writeFileSync(CONFIG, `${JSON.stringify({ ...config, commit: head }, null, 2)}\n`);
  console.log(`upstream-skills.json now records ${head.slice(0, 7)}`);
  process.exit(0);
}
if (head === config.commit) {
  console.log(`Upstream is still at ${head.slice(0, 7)}; nothing to merge.`);
  process.exit(0);
}
const paths = Object.values(config.skills);
const changed = git("diff", "--stat", `${config.commit}..${head}`, "--", ...paths).trim();
console.log(`Upstream ${config.commit.slice(0, 7)}..${head.slice(0, 7)}`);
if (!changed) {
  console.log("No adapted skill changed upstream. Record the new base with --record.");
  process.exit(0);
}
console.log(`${changed}\n`);
process.stdout.write(git("diff", `${config.commit}..${head}`, "--", ...paths));
