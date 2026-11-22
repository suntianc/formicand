import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { publishMerge } from "../dist/src/workspace/project-merge.js";

const run = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "coworkos-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const real = (await run("which", ["git"])).stdout.trim();
  const git = (args) => run(real, ["-C", repo, ...args]).then((result) => result.stdout.trim());
  await run(real, ["init", "-b", "main", repo]);
  await git(["config", "user.email", "fixture@example.test"]);
  await git(["config", "user.name", "Fixture"]);
  await writeFile(join(repo, "a.txt"), "a\n");
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  const base = await git(["rev-parse", "HEAD"]);
  await git(["branch", "other"]);
  await git(["branch", "third"]);
  await git(["switch", "-c", "feature"]);
  await writeFile(join(repo, "b.txt"), "b\n");
  await git(["add", "."]);
  await git(["commit", "-m", "feature"]);
  const merged = await git(["rev-parse", "HEAD"]);
  await git(["switch", "main"]);
  const publish = () =>
    publishMerge({ repository: repo, targetBranch: "main", mergeCommit: merged, expectedTarget: base });

  async function intercept(commands) {
    const bin = join(root, "bin");
    await mkdir(bin);
    const wrapper = join(bin, "git");
    await writeFile(
      wrapper,
      `#!/bin/sh
git() { "${real}" -C "${repo}" "$@"; }
case "$*" in
${commands}
esac
exec "${real}" "$@"
`
    );
    await chmod(wrapper, 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    t.after(() => {
      process.env.PATH = path;
    });
  }
  return { root, repo, real, git, base, merged, publish, intercept };
}

test("two checkout switches during publication leave every branch where its owner put it", async (t) => {
  const { git, real, base, merged, publish, intercept } = await fixture(t);
  await git(["switch", "other"]);
  await git(["merge", "--ff-only", merged]);
  await git(["switch", "main"]);
  await intercept(`*"worktree list"*) "${real}" "$@" && git switch -q other; exit $? ;;
*"update-ref"*) git switch -q third ;;`);
  assert.equal((await publish()).status, "blocked");
  assert.equal(await git(["branch", "--show-current"]), "third");
  assert.equal(await git(["rev-parse", "main"]), base);
  assert.equal(await git(["rev-parse", "other"]), merged);
  assert.equal(await git(["rev-parse", "third"]), base);
  assert.equal(await git(["status", "--porcelain"]), "");
});

test("a branch already at the candidate keeps its previous fast-forward and reflog", async (t) => {
  const { git, real, base, merged, publish, intercept } = await fixture(t);
  await git(["switch", "other"]);
  await git(["merge", "--ff-only", merged]);
  const reflog = await git(["reflog", "show", "other"]);
  await git(["switch", "main"]);
  await intercept(`*"worktree list"*) "${real}" "$@" && git switch -q other; exit $? ;;`);
  const blocked = await publish();
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.detail.includes(base) && blocked.detail.includes(merged), blocked.detail);
  assert.equal(await git(["rev-parse", "main"]), base);
  assert.equal(await git(["rev-parse", "other"]), merged);
  assert.equal(await git(["reflog", "show", "other"]), reflog);
  assert.equal(await git(["status", "--porcelain"]), "");
});

test("the target stays locked through the fast-forward and unrelated staged and unstaged edits survive", async (t) => {
  const { repo, git, real, root, base, merged, publish, intercept } = await fixture(t);
  await writeFile(join(repo, "a.txt"), "staged\n");
  await git(["add", "a.txt"]);
  await writeFile(join(repo, "a.txt"), "working\n");
  const marker = join(root, "switch-result");
  await intercept(
    `*"symbolic-ref"*) "${real}" "$@" || exit $?; git switch -q other 2>/dev/null; echo "$?" > "${marker}"; exit 0 ;;`
  );
  assert.equal((await publish()).status, "updated");
  assert.notEqual((await readFile(marker, "utf8")).trim(), "0");
  assert.equal(await git(["rev-parse", "main"]), merged);
  assert.equal(await git(["rev-parse", "other"]), base);
  assert.equal(await git(["show", ":a.txt"]), "staged");
  assert.equal(await readFile(join(repo, "a.txt"), "utf8"), "working\n");
  assert.equal(await readFile(join(repo, "b.txt"), "utf8"), "b\n");
});

test("a conflicting local file blocks publication and retry finishes an already prepared tree", async (t) => {
  const { repo, git, base, merged, publish } = await fixture(t);
  await writeFile(join(repo, "b.txt"), "local\n");
  assert.equal((await publish()).status, "blocked");
  assert.equal(await git(["rev-parse", "main"]), base);
  assert.equal(await readFile(join(repo, "b.txt"), "utf8"), "local\n");
  await rm(join(repo, "b.txt"));
  await git(["read-tree", "-u", "-m", base, merged]);
  assert.equal((await publish()).status, "updated");
  assert.equal(await git(["rev-parse", "main"]), merged);
  assert.equal(await git(["status", "--porcelain"]), "");
});

test("an unchecked target can only be fast-forwarded", async (t) => {
  const { repo, git, base, merged, publish } = await fixture(t);
  await git(["switch", "other"]);
  assert.equal((await publish()).status, "updated");
  const result = await publishMerge({
    repository: repo,
    targetBranch: "main",
    expectedTarget: merged,
    mergeCommit: base
  });
  assert.equal(result.status, "blocked");
  assert.equal(await git(["rev-parse", "main"]), merged);
});
