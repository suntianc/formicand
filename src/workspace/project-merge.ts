import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { now } from "../domain/types.js";
import type { MergeCheck } from "../domain/development-merge.js";
import {
  assertRepository,
  branchTip as targetTip,
  git,
  gitCommit,
  gitPaths,
  gitProbe,
  gitWorktrees,
  GIT_TIMEOUT_MS
} from "./development-workspace.js";

export { targetTip };

const execute = promisify(execFile);
const CHECK_TIMEOUT_MS = 10 * 60_000;
const CHECK_OUTPUT_LIMIT = 8000;

/** A real conflict is distinguishable from a Git failure the operation could not use. */
export type MergeAttempt =
  | { status: "merged"; baseCommit: string; mergeCommit: string }
  | { status: "conflict"; baseCommit: string; paths: string[]; detail: string }
  | { status: "failed"; baseCommit: string; detail: string };

export type PublishResult =
  { status: "updated" } | { status: "moved" } | { status: "blocked"; detail: string };

/** Whether `ancestor` is already contained in `commit`; a target may advance past our update. */
export async function isAncestor(repository: string, ancestor: string, commit: string): Promise<boolean> {
  return (await gitProbe(repository, ["merge-base", "--is-ancestor", ancestor, commit])) !== undefined;
}

export async function commitExists(repository: string, commit: string): Promise<boolean> {
  return (await gitCommit(repository, commit)) !== undefined;
}

/** The checkout that currently has the target branch checked out, if any. */
export async function targetWorktree(repository: string, branch: string): Promise<string | undefined> {
  return (await gitWorktrees(repository)).find((worktree) => worktree.branch === `refs/heads/${branch}`)
    ?.directory;
}

/**
 * Remove the merge's own temporary checkout.
 *
 * This path is derived from the operation id, so it is never the user's tree or
 * a development branch's checkout; a failed removal is reported, not guessed at.
 */
export async function removeMergeSite(repository: string, directory: string): Promise<void> {
  try {
    await git(repository, ["worktree", "remove", "--force", "--force", directory]);
    // eslint-disable-next-line no-restricted-syntax -- worktree 登记损坏或目录已被删时 remove 会失败，下面的 rm 与 prune 才是这一现场真正的清理路径
  } catch {
    await rm(directory, { recursive: true, force: true });
    // eslint-disable-next-line no-restricted-syntax -- prune 只清理失效的 worktree 登记，rm 已经把目录删掉，登记清理失败不影响清理结果
    await git(repository, ["worktree", "prune"]).catch(() => undefined);
  }
}

/**
 * Build the combined version without touching the target branch.
 *
 * A detached worktree at the current target is merged with the candidate. A
 * conflict aborts there, so the target keeps the previous merge and the
 * candidate branch keeps its own commits. The resulting commit is what the
 * target update will publish with a compare-and-swap on the expected tip.
 */
export async function mergeCandidate(input: {
  repository: string;
  directory: string;
  targetBranch: string;
  candidate: string;
}): Promise<MergeAttempt> {
  await assertRepository(input.repository);
  const baseCommit = await targetTip(input.repository, input.targetBranch);
  if (!baseCommit) throw new Error(`合入目标分支 ${input.targetBranch} 不存在`);
  if (!(await commitExists(input.repository, input.candidate)))
    throw new Error(`合入候选提交 ${input.candidate} 不在仓库 ${input.repository} 中`);
  await removeMergeSite(input.repository, input.directory);
  await mkdir(dirname(input.directory), { recursive: true, mode: 0o700 });
  await git(input.repository, ["worktree", "add", "--detach", input.directory, baseCommit]);
  try {
    await git(input.directory, ["merge", "--no-ff", "--no-edit", input.candidate]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const paths = await gitPaths(input.directory, ["diff", "--name-only", "--diff-filter=U"])
      // eslint-disable-next-line no-restricted-syntax -- 冲突文件列表读不到时按 failed 汇报，原始 git 错误仍作为 detail 返回给调用方
      .catch(() => [] as string[]);
    // eslint-disable-next-line no-restricted-syntax -- 走到这里说明合入已失败，工作树可能已没有可中止的合并，abort 失败不改变下面返回的 conflict/failed 结果
    await git(input.directory, ["merge", "--abort"]).catch(() => undefined);
    return paths.length
      ? { status: "conflict", baseCommit, paths, detail }
      : { status: "failed", baseCommit, detail };
  }
  const mergeCommit = await git(input.directory, ["rev-parse", "HEAD"]);
  return { status: "merged", baseCommit, mergeCommit };
}

/** Run the requester's checks on the combined checkout and keep the real receipts. */
export async function runMergeChecks(directory: string, checks: MergeCheck[]): Promise<MergeCheck[]> {
  const results: MergeCheck[] = [];
  for (const check of checks) {
    const at = now();
    try {
      const { stdout, stderr } = await execute("/bin/sh", ["-c", check.command], {
        cwd: directory,
        timeout: CHECK_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024
      });
      results.push({
        name: check.name,
        command: check.command,
        exitCode: 0,
        output: `${stdout}${stderr}`.slice(0, CHECK_OUTPUT_LIMIT),
        at
      });
    } catch (error) {
      const failure = error as {
        code?: unknown;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      results.push({
        name: check.name,
        command: check.command,
        exitCode: typeof failure.code === "number" ? failure.code : failure.killed ? 124 : 1,
        output:
          `${failure.stdout ?? ""}${failure.stderr ?? ""}`.slice(0, CHECK_OUTPUT_LIMIT) ||
          failure.message ||
          "",
        at
      });
    }
  }
  return results;
}

/** Git holds HEAD and its referent from prepare until commit (or EOF). */
async function advanceCheckout(worktree: string, target: string, before: string, after: string) {
  const update = execute("git", ["-C", worktree, "update-ref", "-m", "publish merge", "--stdin"], {
    timeout: GIT_TIMEOUT_MS
  });
  const replies = createInterface({ input: update.child.stdout! })[Symbol.asyncIterator]();
  const started = replies.next();
  async function* commands() {
    yield `start\nupdate HEAD ${after} ${before}\nprepare\n`;
    if ((await started).value !== "start: ok" || (await replies.next()).value !== "prepare: ok")
      throw new Error("Git 未确认分支引用已锁定");
    if ((await git(worktree, ["symbolic-ref", "--quiet", "HEAD"])) !== target)
      throw new Error(`${worktree} 已不在 ${target} 分支上，请稍后重试合入`);
    // The same two-tree update as Git's push-to-checkout hook: keep local
    // changes unless the incoming tree would overwrite them.
    await git(worktree, ["read-tree", "-u", "-m", before, after]);
    yield "commit\n";
  }
  const [transaction, input] = await Promise.allSettled([update, pipeline(commands(), update.child.stdin!)]);
  if (transaction.status === "rejected") throw transaction.reason;
  if (input.status === "rejected") throw input.reason;
}

/**
 * Publish the combined commit to the target branch.
 *
 * When the target branch is checked out in a real worktree, a fast-forward is
 * used so that checkout stays consistent; it refuses rather than overwriting a
 * dirty file the merge would touch. Otherwise the ref moves by compare-and-swap,
 * so a target that advanced underneath the attempt reports `moved` instead of
 * silently dropping the other update.
 */
export async function publishMerge(input: {
  repository: string;
  targetBranch: string;
  mergeCommit: string;
  expectedTarget: string;
}): Promise<PublishResult> {
  const current = await targetTip(input.repository, input.targetBranch);
  if (!current) throw new Error(`合入目标分支 ${input.targetBranch} 不存在`);
  if (current !== input.expectedTarget) return { status: "moved" };
  if (!(await isAncestor(input.repository, current, input.mergeCommit)))
    return { status: "blocked", detail: `${input.targetBranch} 无法快进到合入提交` };
  const ref = `refs/heads/${input.targetBranch}`;
  const worktree = await targetWorktree(input.repository, input.targetBranch);
  try {
    if (worktree) await advanceCheckout(worktree, ref, current, input.mergeCommit);
    else await git(input.repository, ["update-ref", ref, input.mergeCommit, current]);
    return { status: "updated" };
  } catch (error) {
    const after = await targetTip(input.repository, input.targetBranch);
    if (after !== input.expectedTarget) return { status: "moved" };
    return { status: "blocked", detail: error instanceof Error ? error.message : String(error) };
  }
}
