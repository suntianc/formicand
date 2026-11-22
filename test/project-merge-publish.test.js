import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { publishMerge } from "../dist/src/workspace/project-merge.js";

/**
 * Publishing a merge into the user's checkout of the target branch: if that
 * checkout switches branches after it was found, nothing else moves and the
 * merge is not reported as landed.
 */

const run = promisify(execFile);
const git = (cwd, args) => run("git", ["-C", cwd, ...args]).then((result) => result.stdout.trim());

test("a target checkout that switched branches is not fast-forwarded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coworkos-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await run("git", ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.email", "fixture@example.test"]);
  await git(repo, ["config", "user.name", "Fixture"]);
  await writeFile(join(repo, "a.txt"), "a\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  const base = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["branch", "other"]);
  await git(repo, ["switch", "-c", "feature"]);
  await writeFile(join(repo, "b.txt"), "b\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "feature"]);
  const merged = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["switch", "main"]);

  // Right after the checkout is found on main, the person switches it to other.
  const real = (await run("which", ["git"])).stdout.trim();
  const bin = join(root, "bin");
  await run("mkdir", [bin]);
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\n"${real}" "$@"\nstatus=$?\ncase "$*" in *"worktree list"*) "${real}" -C "${repo}" switch -q other ;; esac\nexit $status\n`
  );
  await chmod(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });

  const result = await publishMerge({
    repository: repo,
    targetBranch: "main",
    mergeCommit: merged,
    expectedTarget: base
  });
  process.env.PATH = path;
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.equal(await git(repo, ["rev-parse", "other"]), base, "the branch switched to stays where it was");
  assert.equal(await git(repo, ["rev-parse", "main"]), base);
});
