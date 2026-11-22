import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
// Keep legacy untouched files stable. A changed file must meet the common formatter.
// CI compares against the PR base; locally include staged, unstaged and new files.
function selection() {
  if (process.argv.includes("--all")) return [["ls-files", "--cached", "-z"]];
  let base = process.env.FORMAT_BASE;
  if (base) {
    try {
      execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], { stdio: "ignore" });
      // eslint-disable-next-line no-restricted-syntax -- FORMAT_BASE 可能未被浅克隆取回，此时沿用 HEAD 作为基准。
    } catch {
      base = "HEAD";
    }
    return [["diff", "--name-only", "--diff-filter=d", "-z", `${base}...HEAD`]];
  }
  return [
    ["diff", "--name-only", "--diff-filter=d", "-z", "HEAD"],
    ["ls-files", "--others", "--exclude-standard", "-z"]
  ];
}
const files = [
  ...new Set(selection().flatMap((args) => execFileSync("git", args, { encoding: "utf8" }).split("\0")))
].filter(
  (file) =>
    existsSync(file) &&
    // A running harness can create task workspaces inside this checkout.
    // Their user content and live supervisor state are not product source.
    !/^task-[^/]+\//.test(file) &&
    !file.startsWith("applications/") &&
    !file.startsWith("workspace/") &&
    !file.startsWith("vendor/") &&
    /\.(?:[cm]?[jt]s|[jt]sx|json|md|css|html|ya?ml)$/.test(file) &&
    file !== "package-lock.json"
);
// Bound each command line when checking a whole checkout.
const batchSize = 100;
for (let i = 0; i < files.length; i += batchSize) {
  const result = spawnSync(
    process.execPath,
    [
      resolve("node_modules/prettier/bin/prettier.cjs"),
      process.argv.includes("--write") ? "--write" : "--check",
      ...files.slice(i, i + batchSize)
    ],
    { stdio: "inherit" }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}
if (!files.length) console.log("No files selected for formatting");
