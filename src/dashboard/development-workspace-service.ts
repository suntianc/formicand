import { conflict } from "./development-errors.js";
import { join } from "node:path";
import { withFileLock } from "../storage/file-lock.js";
import { type ReviewCandidate } from "../domain/development-review.js";
import {
  DevelopmentExistsError,
  developmentIdentifier,
  mergeExecutionBackendId,
  mergeRepository,
  mergeTargetBranch,
  type DevelopmentRecord,
  type MergeConfig
} from "../domain/project-development.js";
import { ProjectDataConflictError, ProjectDataNotFoundError } from "../domain/project-ledger.js";
import { id } from "../domain/types.js";
import type {
  DevelopmentCreate,
  MergeConfigInput,
  ProjectDataGateway
} from "../workspace/project-data-service.js";
import {
  checkedOutBranch,
  developmentWorkspaceIsIntact,
  git,
  prepareDevelopmentWorkspace,
  resolveDevelopmentBaseline
} from "../workspace/development-workspace.js";
import type {
  DevelopmentProject,
  ProjectDevelopmentPorts,
  WorkItemCallFact
} from "./project-development-service.js";

/**
 * The refusal when a project has no merge entry and none can be inferred.
 * It is read by Main: it says what the person must do and forbids working
 * around it, because a Main once went looking for the backend's credential.
 */
const MISSING_MERGE_CONFIG =
  "项目合入配置缺失：项目文件夹不是带有已提交当前分支的 Git 仓库，无法确定合入到哪里。" +
  "请停止开发并告诉用户：在项目文件夹初始化 Git 仓库、提交一次并切到要合入的分支后再继续。" +
  "不要查找、读取或修改 CoworkOS 自己的数据、凭据或接口来绕过这一步。";

export function createDevelopmentWorkspaceService({
  gateway,
  ports
}: {
  gateway: () => Promise<ProjectDataGateway>;
  ports: Pick<ProjectDevelopmentPorts, "backendId" | "project" | "taskProject" | "developmentRoot" | "call">;
}) {
  async function bind(project: DevelopmentProject) {
    if (!project.projectDirectory) return;
    const service = await gateway();
    await service.ensureProject({
      projectId: project.projectId,
      projectName: project.projectName,
      projectDirectory: project.projectDirectory,
      backendId: ports.backendId
    });
  }

  async function project(projectId: string): Promise<DevelopmentProject> {
    const found = await ports.project(projectId);
    if (found) {
      await bind(found);
      return found;
    }
    // A secondary backend's project is not in this catalog. The shared
    // identity must exist; its directory stays that other backend's fact.
    const service = await gateway();
    const shared = await service.projects();
    if (!shared.some((entry) => entry.projectId === projectId))
      throw new ProjectDataNotFoundError("项目不存在");
    return { projectId, projectName: projectId, projectDirectory: "" };
  }

  async function taskProject(taskId: string): Promise<DevelopmentProject> {
    const found = await ports.taskProject(taskId);
    if (!found) throw new ProjectDataNotFoundError("会话不属于任何项目");
    await bind(found);
    return found;
  }

  const workspaceDirectory = (developmentId: string) => join(ports.developmentRoot, developmentId);

  const workspaceBranch = (developmentId: string) => `coworkos/development/${developmentId}`;

  /**
   * The project's merge entry.
   *
   * Every backend that can see the configured repository may prepare its own
   * isolated checkout; only the named execution backend claims an operation and
   * updates the target. Preparation is therefore not an ownership refusal.
   */
  async function requiredMergeConfig(projectId: string): Promise<MergeConfig> {
    const service = await gateway();
    const config = (await service.mergeConfig(projectId)) ?? (await defaultMergeConfig(projectId));
    if (!config) throw new ProjectDataConflictError(MISSING_MERGE_CONFIG, undefined, "project_git_missing");
    return config;
  }

  /**
   * A local project whose folder is a Git repository merges into the branch it
   * has checked out, on this backend. Nothing in the app sets a merge entry, so
   * without this default every new project stopped at its first development.
   */
  async function defaultMergeConfig(projectId: string): Promise<MergeConfig | undefined> {
    const local = await ports.project(projectId);
    if (!local?.projectDirectory) return undefined;
    const branch = await checkedOutBranch(local.projectDirectory);
    if (!branch) return undefined;
    return saveMergeConfig(projectId, { repository: local.projectDirectory, targetBranch: branch });
  }

  async function saveMergeConfig(projectId: string, input: MergeConfigInput): Promise<MergeConfig> {
    await project(projectId);
    const repository = mergeRepository(input.repository);
    const targetBranch = mergeTargetBranch(input.targetBranch);
    const executionBackendId =
      input.executionBackendId === undefined ? undefined : mergeExecutionBackendId(input.executionBackendId);
    await resolveDevelopmentBaseline({ repository, branch: targetBranch });
    return (await gateway()).setMergeConfig(
      projectId,
      { repository, targetBranch, executionBackendId },
      ports.backendId
    );
  }

  async function markFailed(
    projectId: string,
    record: DevelopmentRecord,
    directory: string,
    branch: string,
    error: string
  ): Promise<DevelopmentRecord> {
    return (await gateway()).recordDevelopmentWorkspace(projectId, record.developmentId, {
      workspaceId: record.workspace?.workspaceId ?? id("workspace"),
      backendId: ports.backendId,
      directory: record.workspace?.directory ?? directory,
      branch: record.workspace?.branch ?? branch,
      baseCommit: record.workspace?.baseCommit ?? record.baseline.commit,
      state: "failed",
      error
    });
  }

  async function prepare(
    projectId: string,
    record: DevelopmentRecord,
    repository: string
  ): Promise<DevelopmentRecord> {
    const directory = record.workspace?.directory ?? workspaceDirectory(record.developmentId);
    const branch = record.workspace?.branch ?? workspaceBranch(record.developmentId);
    try {
      await prepareDevelopmentWorkspace({
        repository,
        branch,
        commit: record.baseline.commit,
        directory
      });
      const service = await gateway();
      return await service.recordDevelopmentWorkspace(projectId, record.developmentId, {
        workspaceId: record.workspace?.workspaceId ?? id("workspace"),
        backendId: ports.backendId,
        directory,
        branch,
        baseCommit: record.baseline.commit,
        state: "ready"
      });
    } catch (error) {
      return markFailed(
        projectId,
        record,
        directory,
        branch,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async function create(
    projectId: string,
    input: DevelopmentCreate,
    taskId?: string
  ): Promise<DevelopmentRecord> {
    await project(projectId);
    const service = await gateway();
    const requirementId = developmentIdentifier(input.requirementId, "需求 ID");
    // Resolve the requirement before any record or checkout exists.
    await service.getRequirement(projectId, requirementId);
    const existing = await service.findDevelopmentByRequirement(projectId, requirementId, ports.backendId);
    if (existing?.status === "active")
      throw new DevelopmentExistsError(
        `该需求有一次开发还在进行（${existing.developmentId}）；继续这次开发，或等它合入、撤回后再新建`,
        existing.developmentId
      );
    let sessionId = input.sessionId;
    if (taskId) {
      const session = await service.findMainSessionByTask(projectId, ports.backendId, taskId);
      sessionId = session?.session.sessionId;
    } else if (sessionId) await service.getMainSession(projectId, sessionId);
    const config = await requiredMergeConfig(projectId);
    // The baseline is the configured target branch as it exists right now.
    const baseline = await resolveDevelopmentBaseline({
      repository: config.repository,
      branch: config.targetBranch
    });
    const record = await service.createDevelopment(projectId, {
      requirementId,
      request: input.request,
      goal: input.goal,
      completionCriteria: input.completionCriteria,
      route: input.route,
      baseline,
      sessionId,
      taskId
    });
    return prepare(projectId, record, config.repository);
  }

  async function ensureWorkspace(projectId: string, developmentId: string): Promise<DevelopmentRecord> {
    await project(projectId);
    const service = await gateway();
    const record = await service.getDevelopment(projectId, developmentId, ports.backendId);
    const directory = record.workspace?.directory ?? workspaceDirectory(record.developmentId);
    const branch = record.workspace?.branch ?? workspaceBranch(record.developmentId);
    const config = await service.mergeConfig(projectId);
    if (!config) return markFailed(projectId, record, directory, branch, MISSING_MERGE_CONFIG);
    if (
      record.workspace &&
      (await developmentWorkspaceIsIntact({
        repository: config.repository,
        directory: record.workspace.directory,
        branch: record.workspace.branch
      }))
    ) {
      if (record.workspace.state === "ready") return record;
      // A failed marker after a successful checkout (for example a ready-write
      // failure) is reconciled without creating a second worktree or resetting
      // the user's work.
      const service = await gateway();
      return await service.recordDevelopmentWorkspace(projectId, record.developmentId, {
        workspaceId: record.workspace.workspaceId,
        backendId: ports.backendId,
        directory: record.workspace.directory,
        branch: record.workspace.branch,
        baseCommit: record.workspace.baseCommit,
        state: "ready"
      });
    }
    return prepare(projectId, record, config.repository);
  }

  // ---- fixed-candidate review -------------------------------------------------
  // The program owns versions, identities, drift and delivery prerequisites.
  // Main owns the judgement: which candidate to freeze, what a finding means,
  // whether to fix or dismiss it, and whether a Reviewer is needed at all.

  async function reviewDevelopment(
    projectId: string,
    developmentIdValue: unknown
  ): Promise<DevelopmentRecord> {
    await project(projectId);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    const record = await (await gateway()).getDevelopment(projectId, developmentId, ports.backendId);
    if (!record.workspace || record.workspace.state !== "ready")
      throw conflict("开发记录没有就绪的本机现场；先 ensure_workspace", "review_workspace_not_ready");
    return record;
  }

  /** A development still being worked on: the writes below refuse a merged or withdrawn one. */
  async function openDevelopment(projectId: string, developmentIdValue: unknown): Promise<DevelopmentRecord> {
    const record = await reviewDevelopment(projectId, developmentIdValue);
    if (record.status !== "active")
      throw conflict(
        `这次开发已${record.status === "merged" ? "合入" : "撤回"}；同一需求的新工作新建一次开发`,
        "development_closed"
      );
    return record;
  }

  async function inspectWorkspace(record: DevelopmentRecord): Promise<ReviewCandidate & { changes: string }> {
    const workspace = record.workspace!;
    try {
      const [commit, tree, changes] = await Promise.all([
        git(workspace.directory, ["rev-parse", "HEAD"]),
        git(workspace.directory, ["rev-parse", "HEAD^{tree}"]),
        git(workspace.directory, ["status", "--porcelain"])
      ]);
      return { commit, tree, branch: workspace.branch, workspace: workspace.directory, changes };
    } catch (error) {
      throw conflict(
        `无法读取需求现场 ${workspace.directory}：${error instanceof Error ? error.message : String(error)}`,
        "review_site_unavailable"
      );
    }
  }

  async function currentCandidate(record: DevelopmentRecord): Promise<ReviewCandidate> {
    const current = await inspectWorkspace(record);
    if (current.changes)
      throw conflict("候选现场有未提交改动；先提交或清理再冻结候选", "review_candidate_dirty");
    return {
      commit: current.commit,
      tree: current.tree,
      branch: current.branch,
      workspace: current.workspace
    };
  }

  async function requireCall(taskId: string | undefined, callIdValue: unknown): Promise<WorkItemCallFact> {
    const callId = developmentIdentifier(callIdValue, "工作项 callId");
    if (!taskId) throw conflict("审查操作须来自一个 Main 会话", "review_task_required");
    if (!ports.call) throw conflict("当前服务无法读取工作项身份", "review_call_source_missing");
    const fact = await ports.call(taskId, callId);
    if (!fact) throw conflict(`当前运行没有工作项 ${callId}`, "review_call_unknown");
    return fact;
  }

  /**
   * Ticket integrations whose checks are still running here, by development.
   * They hold the checkout lock until they finish; a call that would wait on
   * that lock is refused instead, since its caller gives up long before.
   */
  const integrating = new Map<string, string>();

  /** A check and its rollback share one checkout lock with all backend processes. */
  async function inDevelopment<T>(
    projectId: string,
    input: Record<string, unknown>,
    action: (record: DevelopmentRecord) => Promise<T>
  ) {
    const developmentId = developmentIdentifier(input.developmentId, "开发记录 ID");
    const running = integrating.get(developmentId);
    if (running)
      throw conflict(
        `票 ${running} 正在并入需求现场并运行检查；完成后会通知 Main，在此之前需求现场不能操作`,
        "ticket_integration_running"
      );
    const { workspace } = await (await gateway()).getDevelopment(projectId, developmentId, ports.backendId);
    const directory = workspace?.directory ?? workspaceDirectory(developmentId);
    return withFileLock(
      directory,
      async () => {
        const record = await openDevelopment(projectId, developmentId);
        if (record.workspace!.directory !== directory)
          throw conflict("等待期间需求现场已变更，请重试", "review_workspace_not_ready");
        return action(record);
      },
      { timeoutMs: Infinity }
    );
  }

  return {
    project,
    taskProject,
    requiredMergeConfig,
    saveMergeConfig,
    create,
    ensureWorkspace,
    reviewDevelopment,
    openDevelopment,
    inspectWorkspace,
    currentCandidate,
    requireCall,
    inDevelopment,
    integrating
  };
}
