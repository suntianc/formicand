import { mkdir, readdir, realpath, rmdir, stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { ProjectDataInvalidError } from "../domain/project-ledger.js";
import { assertRepository, git, gitCommit, isRegisteredWorktree } from "./development-workspace.js";

/** One Reviewer's own checkout of the frozen candidate. */
export interface ReviewSite {
  /** The development checkout that owns the candidate commit. */
  repository: string;
  /** The candidate commit under review. */
  commit: string;
  /** The Reviewer's detached checkout; never the Executor's. */
  directory: string;
}

function invalid(message: string): ProjectDataInvalidError {
  return new ProjectDataInvalidError(message);
}

async function resolveCommit(repository: string, commit: string): Promise<string> {
  const resolved = await gitCommit(repository, commit);
  if (!resolved) throw invalid(`审查候选提交不存在（${commit}）`);
  return resolved;
}

/** Whether the directory is still this Reviewer's checkout of the same candidate. */
export async function reviewSiteIsIntact(site: ReviewSite): Promise<boolean> {
  try {
    const directory = await stat(site.directory);
    if (!directory.isDirectory()) return false;
    if (!(await isRegisteredWorktree(site.repository, site.directory))) return false;
    return (
      (await git(site.directory, ["rev-parse", "HEAD"])) ===
      (await resolveCommit(site.repository, site.commit))
    );
    // eslint-disable-next-line no-restricted-syntax -- 目录不存在或 git 查询失败都说明现场不可用，false 就是结论
  } catch {
    return false;
  }
}

/**
 * Create the Reviewer's detached checkout of one frozen candidate.
 *
 * It is a real `git worktree` detached at the candidate commit, outside the
 * repository and separate from every Executor checkout. A previous attempt of
 * this same review at the same commit is reused as it was left; any other
 * content in the directory is preserved and reported instead of overwritten.
 */
export async function prepareReviewSite(site: ReviewSite): Promise<void> {
  await assertRepository(site.repository);
  const repository = await realpath(site.repository);
  const commit = await resolveCommit(site.repository, site.commit);
  const parent = dirname(site.directory);
  // eslint-disable-next-line no-restricted-syntax -- 目标父目录此时可能还不存在，realpath 失败时退回字面路径只用于越界比较
  const resolvedParent = await realpath(parent).catch(() => resolve(parent));
  const target = resolve(resolvedParent, basename(site.directory));
  if (target === repository || target.startsWith(`${repository}${sep}`))
    throw invalid(`审查现场不能放在开发仓库内（${site.directory}）`);
  if (await reviewSiteIsIntact({ ...site, commit })) return;

  // eslint-disable-next-line no-restricted-syntax -- 现场目录首次创建时还不存在，stat 的 ENOENT 表示没有需要保留的既有目录
  const existing = await stat(site.directory).catch(() => undefined);
  if (existing) {
    if (!existing.isDirectory()) throw invalid(`审查现场路径不是目录（${site.directory}）`);
    if ((await readdir(site.directory)).length > 0)
      throw invalid(`审查现场目录已有内容，未覆盖（${site.directory}）`);
    await rmdir(site.directory);
  }

  await mkdir(dirname(site.directory), { recursive: true, mode: 0o700 });
  try {
    await git(site.repository, ["worktree", "add", "--detach", site.directory, commit]);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
  if (!(await reviewSiteIsIntact({ ...site, commit }))) {
    try {
      await git(site.repository, ["worktree", "remove", "--force", site.directory]);
      // eslint-disable-next-line no-restricted-syntax -- 现场刚创建却未通过核对时，移除它是清理动作；移除失败仍要报告无法确认候选，不能掩盖原始结论
    } catch {
      /* the invalid-site error below is the actionable one */
    }
    throw invalid(`审查现场创建后无法确认候选 ${commit}（${site.directory}）`);
  }
}

/**
 * Remove a Reviewer's checkout once its process has ended.
 *
 * The directory is a registered worktree, so Git owns the removal; a directory
 * already gone leaves a stale registration that `worktree prune` clears.
 */
export async function releaseReviewSite(site: ReviewSite): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- 现场目录已不存在时只需要清理旧注册，stat 失败就是“已不存在”
  const existing = await stat(site.directory).catch(() => undefined);
  if (!existing) {
    await git(site.repository, ["worktree", "prune"]);
    return;
  }
  await git(site.repository, ["worktree", "remove", "--force", site.directory]);
}
