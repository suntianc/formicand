import { shellExecutable } from "./fixtures/script-executable.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { commitExists, isAncestor, publishMerge, targetTip } from "../dist/src/workspace/project-merge.js";

const run = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "formicand-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const real = (await run(process.platform === "win32" ? "where.exe" : "which", ["git"])).stdout
    .trim()
    .split(/\r?\n/)[0]
    .replaceAll("\\", "/");
  const git = (args) => run(real, ["-C", repo, ...args]).then((result) => result.stdout.trim());
  await run(real, ["init", "-b", "main", repo]);
  await git(["config", "user.email", "fixture@example.test"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "core.autocrlf", "false"]);
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
    await shellExecutable(
      wrapper,
      `#!/bin/sh
git() { "${real}" -C "${repo.replaceAll("\\", "/")}" "$@"; }
case "$*" in
${commands}
esac
exec "${real}" "$@"
`
    );
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path}`;
    t.after(() => {
      process.env.PATH = path;
    });
  }
  return { root, repo, real, git, base, merged, publish, intercept };
}

test("target and ancestor queries keep Git failures separate from negative results", async (t) => {
  const { root, repo, git, base, merged } = await fixture(t);
  assert.equal(await targetTip(repo, "main"), base);
  await git(["tag", "refs/heads/missing", base]);
  assert.equal(await targetTip(repo, "missing"), undefined);
  await git(["tag", "refs/heads/corrupt", base]);
  await writeFile(join(repo, ".git", "refs", "heads", "corrupt"), "not-an-object\n");
  await assert.rejects(targetTip(repo, "corrupt"), /failed to look up reference|broken ref/);
  await writeFile(join(repo, ".git", "refs", "heads", "missing-object"), "1".repeat(40) + "\n");
  await assert.rejects(targetTip(repo, "missing-object"), { code: 128 });
  assert.equal(await isAncestor(repo, base, merged), true);
  assert.equal(await isAncestor(repo, merged, base), false);
  assert.equal(await commitExists(repo, "0".repeat(40)), false);
  await assert.rejects(isAncestor(repo, "0".repeat(40), base), { code: 128 });
  await assert.rejects(isAncestor(root, base, merged), { code: 128 });
  await assert.rejects(targetTip(root, "main"), { code: 128 });
  await assert.rejects(commitExists(root, base), { code: 128 });
});

for (const format of ["exists", "legacy"]) {
  test(`Git trace leaves successful queries and negative results intact (${format} ref lookup)`, async (t) => {
    const { repo, git, base, merged, intercept } = await fixture(t);
    if (format === "legacy") await intercept(`*"show-ref --exists"*) exit 129 ;;`);
    const trace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = "1";
    t.after(() => {
      if (trace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = trace;
    });
    assert.equal(await targetTip(repo, "main"), base);
    assert.equal(await targetTip(repo, "missing"), undefined);
    assert.equal(await isAncestor(repo, base, merged), true);
    assert.equal(await isAncestor(repo, merged, base), false);
    assert.equal(await commitExists(repo, "0".repeat(40)), false);
    await git(["tag", "refs/heads/corrupt", base]);
    await writeFile(join(repo, ".git", "refs", "heads", "corrupt"), "not-an-object\n");
    await assert.rejects(targetTip(repo, "corrupt"), /failed to look up reference|broken ref/);
  });
}

test("an invalid merge commit fails publication before the target changes", async (t) => {
  const { repo, git, base } = await fixture(t);
  await assert.rejects(
    publishMerge({
      repository: repo,
      targetBranch: "main",
      expectedTarget: base,
      mergeCommit: "0".repeat(40)
    }),
    { code: 128 }
  );
  assert.equal(await git(["rev-parse", "main"]), base);
});

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
  const marker = join(root, "switch-result").replaceAll("\\", "/");
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

for (const format of ["NUL", "legacy"]) {
  test(`a target in a linked worktree with a quoted path is advanced on disk (${format} listing)`, async (t) => {
    const { root, git, merged, publish, intercept } = await fixture(t);
    const checkout = join(root, process.platform === "win32" ? "linked 中文 worktree" : 'linked "worktree"');
    await git(["switch", "other"]);
    await git(["worktree", "add", checkout, "main"]);
    if (format === "legacy") await intercept(`*"worktree list"*"-z"*) exit 129 ;;`);
    assert.equal((await publish()).status, "updated");
    assert.equal(await git(["rev-parse", "main"]), merged);
    assert.equal(await readFile(join(checkout, "b.txt"), "utf8"), "b\n");
  });
}

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
