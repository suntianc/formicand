import { execFile } from "node:child_process";
import { mkdir, readdir, realpath, rmdir, stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { utilityCommand } from "../platform/utility-command.js";
import { promisify } from "node:util";
import { isDocument } from "../domain/project-documents.js";
import { ProjectDataError, ProjectDataInvalidError } from "../domain/project-ledger.js";

const execute = promisify(execFile);
export const GIT_TIMEOUT_MS = 20_000;
const MAX_BUFFER = 4 * 1024 * 1024;

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly code: number | string | undefined,
    readonly stderr: string,
    cause: unknown
  ) {
    super(message, { cause });
    this.name = "GitCommandError";
  }
}

function gitFailure(repository: string, error: unknown): GitCommandError {
  const detail = error as { code?: number | string; stderr?: string; message?: string };
  const stderr = (detail.stderr ?? "").trim();
  const message =
    detail.code === "ENOENT"
      ? "找不到 git 可执行文件，无法准备需求现场"
      : `git 在 ${repository} 执行失败：${stderr || detail.message || "未知错误"}`;
  return new GitCommandError(message, detail.code, stderr, error);
}

/**
 * Run one git command in a repository or a linked worktree. Paths come out as
 * they are: by default git quotes and escapes a non-ASCII one ("docs/\344…").
 */
export async function git(repository: string, args: string[], priority?: "utility"): Promise<string> {
  return (await run(repository, args, undefined, priority)).stdout.trim();
}

/** Use with Git queries whose exit 1 means the requested condition is false. */
export async function gitProbe(repository: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(repository, args);
  } catch (error) {
    if (error instanceof GitCommandError && error.code === 1) return undefined;
    throw error;
  }
}

export function gitCommit(repository: string, revision: string): Promise<string | undefined> {
  return gitProbe(repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${revision}^{commit}`
  ]);
}

/**
 * The paths a listing command prints, read NUL-separated: even with
 * `core.quotePath` off git quotes a name holding a quote or a backslash.
 */
export async function gitPaths(repository: string, args: string[]): Promise<string[]> {
  const { stdout } = await run(repository, [...args.slice(0, 1), "-z", ...args.slice(1)]);
  return stdout.split("\0").filter(Boolean);
}

async function run(
  repository: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  priority?: "utility"
): Promise<{ stdout: string; stderr: string }> {
  try {
    const argv = ["-C", repository, "-c", "core.quotePath=false", ...args];
    const [command, commandArgs] =
      priority === "utility" ? utilityCommand("git", argv) : (["git", argv] as const);
    return await execute(command, commandArgs, {
      env,
      timeout: priority === "utility" ? 120_000 : GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true
    });
  } catch (error) {
    throw gitFailure(repository, error);
  }
}

/**
 * Whether `to` is `from` plus commits that change only files under `directory`:
 * a requirement's retro writes its pitfalls on top of the approved version, and
 * that is the one change the approval carries over. The same commit is not a
 * delta; `from` must be an ancestor of `to`.
 */
export async function onlyChangesUnder(
  repository: string,
  from: string,
  to: string,
  directory: string
): Promise<boolean> {
  if (from === to) return false;
  if ((await git(repository, ["merge-base", from, to])) !== from) return false;
  const files = await gitPaths(repository, ["diff", "--name-only", "--no-renames", `${from}..${to}`]);
  return files.length > 0 && files.every((file) => file.startsWith(directory));
}

/** Every Markdown document a commit holds. */
export async function documentsAt(repository: string, commit: string): Promise<string[]> {
  return (await gitPaths(repository, ["ls-tree", "-r", "--name-only", commit])).filter(isDocument);
}

/** The Markdown documents added or renamed between two commits. */
export async function documentsAdded(repository: string, from: string, to: string): Promise<string[]> {
  return (
    await gitPaths(repository, ["diff", "--name-only", "--diff-filter=AR", "-M", `${from}..${to}`])
  ).filter(isDocument);
}

/**
 * The top-level files under `directory` that changed between two commits, by
 * file name, with their text at `to` (undefined when removed there).
 */
export async function changedPagesUnder(
  repository: string,
  from: string,
  to: string,
  directory: string
): Promise<Record<string, string | undefined>> {
  const names = (
    await gitPaths(repository, ["diff", "--name-only", "--no-renames", `${from}..${to}`, "--", directory])
  ).filter((file) => !file.slice(directory.length).includes("/"));
  return Object.fromEntries(
    await Promise.all(
      names.map(async (file) => [file.slice(directory.length), await fileAt(repository, to, file)] as const)
    )
  );
}

/** A file's text at a commit, or undefined when the commit does not have it. */
export async function fileAt(repository: string, commit: string, path: string): Promise<string | undefined> {
  const present = await git(repository, ["ls-tree", "--name-only", commit, "--", path]);
  return present ? git(repository, ["show", `${commit}:${path}`]) : undefined;
}

function invalid(message: string): ProjectDataInvalidError {
  return new ProjectDataInvalidError(message);
}

/** A locatable configuration refusal, distinct from a malformed request body. */
function invalidConfig(message: string): ProjectDataError {
  return new ProjectDataError(message, 400, "project_git_invalid");
}

/** A local, non-bare Git repository; the message names the path that failed. */
export async function assertRepository(repository: string): Promise<void> {
  let directory;
  try {
    directory = await stat(repository);
  } catch {
    throw invalidConfig(`项目合入配置不可用：仓库路径不存在（${repository}）`);
  }
  if (!directory.isDirectory()) throw invalidConfig(`项目合入配置不可用：仓库路径不是目录（${repository}）`);
  try {
    const bare = await git(repository, ["rev-parse", "--is-bare-repository"]);
    if (bare === "true") throw invalidConfig(`项目合入配置不可用：${repository} 是裸仓库，不能创建需求现场`);
  } catch (error) {
    // Keep an explicit refusal (bare repository, missing executable, path
    // trouble) as its own locatable reason instead of relabelling it.
    if (error instanceof ProjectDataError) throw error;
    throw invalidConfig(`项目合入配置不可用：${repository} 不是 Git 仓库`);
  }
}

/**
 * The branch a project folder has checked out, when the folder is a Git
 * repository whose current branch has a commit; undefined otherwise.
 */
export async function checkedOutBranch(directory: string): Promise<string | undefined> {
  try {
    const branch = await git(directory, ["symbolic-ref", "--short", "-q", "HEAD"]);
    if (!branch) return undefined;
    await git(directory, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    return branch;
    // eslint-disable-next-line no-restricted-syntax -- 不是 Git 仓库、分离 HEAD 或分支还没有提交都表示没有可用的当前分支，调用方据此要求人来配置
  } catch {
    return undefined;
  }
}

async function legacyBranchExists(repository: string, ref: string): Promise<boolean> {
  if ((await gitProbe(repository, ["show-ref", "--verify", "--quiet", ref])) !== undefined) return true;
  // The older exact check uses the same exit code for missing and broken refs.
  // Inspect only the broken-ref diagnostic, even when Git resolved a namesake tag.
  const { stderr } = await run(repository, ["rev-parse", "--verify", "--quiet", "--end-of-options", ref], {
    ...process.env,
    LC_ALL: "C"
  }).catch((error: unknown) => {
    if (error instanceof GitCommandError && error.code === 1) return { stderr: error.stderr };
    throw error;
  });
  const diagnostic = /^warning: ignoring (?:broken ref|dangling symref) .+$/m.exec(stderr)?.[0];
  if (diagnostic) throw new Error(`git 在 ${repository} 查询分支失败：${diagnostic}`);
  return false;
}

async function branchExists(repository: string, ref: string): Promise<boolean> {
  try {
    await git(repository, ["show-ref", "--exists", ref]);
    return true;
  } catch (error) {
    if (!(error instanceof GitCommandError)) throw error;
    if (error.code === 2) return false;
    if (error.code === 129) return legacyBranchExists(repository, ref);
    throw error;
  }
}

/** The commit of an exact local branch. Git's other failures are operational errors. */
export async function branchTip(repository: string, branch: string): Promise<string | undefined> {
  const ref = `refs/heads/${branch}`;
  if (!(await branchExists(repository, ref))) return undefined;
  const object = await git(repository, ["show-ref", "--verify", "--hash", ref]);
  return git(repository, ["rev-parse", "--verify", "--end-of-options", `${object}^{commit}`]);
}

/** Resolve the baseline branch's current commit; a missing branch is named. */
export async function resolveDevelopmentBaseline(input: {
  repository: string;
  branch: string;
}): Promise<{ branch: string; commit: string }> {
  await assertRepository(input.repository);
  const commit = await branchTip(input.repository, input.branch);
  if (!commit) throw invalidConfig(`项目合入配置不可用：目标分支 ${input.branch} 不存在`);
  return { branch: input.branch, commit };
}

interface GitWorktree {
  directory: string;
  branch?: string;
}

function unquoteGitPath(path: string): string {
  if (!path.startsWith('"')) return path;
  const escapes: Partial<Record<string, string>> = {
    a: "\x07",
    b: "\b",
    t: "\t",
    n: "\n",
    v: "\v",
    f: "\f",
    r: "\r",
    '"': '"',
    "\\": "\\"
  };
  return path
    .slice(1, -1)
    .replace(
      /\\([abtnvfr"\\]|[0-3][0-7]{2})/g,
      (_match, escaped: string) => escapes[escaped] ?? String.fromCharCode(Number.parseInt(escaped, 8))
    );
}

/** NUL-separated records keep whitespace and quoted paths intact. */
export async function gitWorktrees(repository: string): Promise<GitWorktree[]> {
  const args = ["worktree", "list", "--porcelain"];
  let separator = "\0";
  let listing: string;
  try {
    ({ stdout: listing } = await run(repository, [...args, "-z"]));
  } catch (error) {
    // Older Git supports the porcelain listing without its NUL option.
    if (!(error instanceof GitCommandError) || error.code !== 129) throw error;
    separator = "\n";
    ({ stdout: listing } = await run(repository, args));
  }
  const worktrees: GitWorktree[] = [];
  for (const entry of listing.split(separator + separator)) {
    const [directory, ...fields] = entry.split(separator);
    if (!directory.startsWith("worktree ")) continue;
    const branch = fields.find((field) => field.startsWith("branch "));
    const path = directory.slice("worktree ".length);
    worktrees.push({
      directory: separator === "\n" ? unquoteGitPath(path) : path,
      ...(branch ? { branch: branch.slice("branch ".length) } : {})
    });
  }
  return worktrees;
}

export async function isRegisteredWorktree(repository: string, directory: string): Promise<boolean> {
  const target = await realpath(directory);
  for (const worktree of await gitWorktrees(repository)) {
    try {
      if ((await realpath(worktree.directory)) === target) return true;
      // eslint-disable-next-line no-restricted-syntax -- 旧注册可能已经失效，继续检查其余工作树以确认目标目录
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * The checkout is still the one this record owns: the directory exists, the
 * repository still lists it as a worktree, and it is on the recorded branch.
 */
export async function developmentWorkspaceIsIntact(input: {
  repository: string;
  directory: string;
  branch: string;
}): Promise<boolean> {
  try {
    const directory = await stat(input.directory);
    if (!directory.isDirectory()) return false;
    if (!(await isRegisteredWorktree(input.repository, input.directory))) return false;
    const current = await git(input.directory, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return current === input.branch;
    // eslint-disable-next-line no-restricted-syntax -- 目录不存在或 git 查询失败都说明现场已不可用，false 就是结论
  } catch {
    return false;
  }
}

async function emptyDirectory(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length === 0;
    // eslint-disable-next-line no-restricted-syntax -- 目录不可读时按非空处理，宁可拒绝复用也不覆盖用户内容
  } catch {
    return false;
  }
}

/**
 * Create the isolated checkout for one development.
 *
 * It is a real `git worktree` outside the repository, so the user's own working
 * tree, staged reservation and untracked files are never touched. An empty
 * directory left by an interrupted attempt is reused; anything with content is
 * preserved and reported instead of deleted.
 */
export async function prepareDevelopmentWorkspace(input: {
  repository: string;
  branch: string;
  commit: string;
  directory: string;
}): Promise<void> {
  await assertRepository(input.repository);
  const repository = await realpath(input.repository);
  // Compare the checkout's own path, resolving the parent when it exists, so a
  // workspace can never be created inside the user's working copy.
  const parent = dirname(input.directory);
  // eslint-disable-next-line no-restricted-syntax -- 目标父目录此时可能还不存在，realpath 失败时回退到未解析路径只用于越界比较
  const resolvedParent = await realpath(parent).catch(() => resolve(parent));
  const target = resolve(resolvedParent, basename(input.directory));
  if (target === repository || target.startsWith(`${repository}${sep}`))
    throw invalid("需求现场不能放在用户仓库目录内");

  const existing = await branchTip(input.repository, input.branch);
  if (existing && existing !== input.commit)
    throw invalid(`现场分支 ${input.branch} 已存在且不在基线 ${input.commit} 上`);

  try {
    const directory = await stat(input.directory);
    if (!directory.isDirectory()) throw invalid(`需求现场路径已存在且不是目录（${input.directory}）`);
    if (!(await emptyDirectory(input.directory)))
      throw invalid(`需求现场目录已有内容，未覆盖（${input.directory}）`);
    await rmdir(input.directory);
  } catch (error) {
    if (error instanceof ProjectDataInvalidError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(dirname(input.directory), { recursive: true, mode: 0o700 });
  try {
    if (existing) await git(input.repository, ["worktree", "add", input.directory, input.branch]);
    else await git(input.repository, ["worktree", "add", "-b", input.branch, input.directory, input.commit]);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
  if (!(await developmentWorkspaceIsIntact(input)))
    throw invalid(`需求现场创建后无法确认分支 ${input.branch}（${input.directory}）`);
}
