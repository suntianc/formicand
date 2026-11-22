import {
  ledgerIdentifier,
  ledgerProjectId,
  ProjectDataConflictError,
  ProjectDataNotFoundError
} from "../domain/project-ledger.js";
import { reviewCandidate } from "../domain/development-review.js";
import {
  mergeAcceptance,
  mergeCheckCommands,
  mergeCheckResults,
  mergeClaim,
  mergeCommit,
  mergeCreate,
  mergeReceipt,
  mergeReasons,
  mergeState,
  mergeUpdate,
  type DevelopmentMerge,
  type MergeCheck,
  type MergeCreate
} from "../domain/development-merge.js";
import {
  developmentIdentifier,
  mergeExecutionBackendId,
  mergeRepository,
  mergeTargetBranch,
  type MergeConfig
} from "../domain/project-development.js";
import { id, now } from "../domain/types.js";
import type { SqlTransaction } from "../storage/project-data/database.js";

import type { MergeConfigInput } from "./project-data-gateway.js";
import type { DevelopmentRepository } from "./development-repository.js";
import { storedArray, storedJson, recordOf } from "./project-data-json.js";

interface MergeConfigRow {
  project_id: string;
  repository: string;
  target_branch: string;
  execution_backend_id: string;
  created_at: string;
  updated_at: string;
}
interface MergeRow {
  project_id: string;
  merge_id: string;
  development_id: string;
  requirement_id: string;
  state: string;
  revision: number;
  requested_by: string;
  execution_backend_id: string;
  target_branch: string;
  candidate: string;
  candidate_commit: string;
  acceptance: string;
  checks: string;
  reasons: string;
  combined_base: string | null;
  expected_target: string | null;
  merge_commit: string | null;
  owner_started_at: string | null;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

function mergeConfigOf(row: MergeConfigRow): MergeConfig {
  return {
    projectId: row.project_id,
    repository: row.repository,
    targetBranch: row.target_branch,
    executionBackendId: row.execution_backend_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mergeOf(row: MergeRow): DevelopmentMerge {
  const merge: DevelopmentMerge = {
    projectId: row.project_id,
    mergeId: row.merge_id,
    developmentId: row.development_id,
    requirementId: row.requirement_id,
    state: mergeState(row.state),
    revision: Number(row.revision),
    requestedBy: row.requested_by,
    executionBackendId: row.execution_backend_id,
    targetBranch: row.target_branch,
    candidate: reviewCandidate(storedJson(row.candidate, "合入候选")),
    acceptance: mergeAcceptance(storedJson(row.acceptance, "合入验收")),
    checks: storedMergeChecks(row.checks),
    reasons: mergeReasons(storedArray(row.reasons, "合入原因")),
    ...(row.combined_base ? { combinedBase: row.combined_base } : {}),
    ...(row.expected_target ? { expectedTarget: row.expected_target } : {}),
    ...(row.merge_commit ? { mergeCommit: row.merge_commit } : {}),
    ...(row.owner_started_at ? { ownerStartedAt: row.owner_started_at } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  const receipt = mergeReceipt(merge);
  return receipt ? { ...merge, receipt } : merge;
}

/** A queued operation stores commands; a run operation stores the real receipts. */
function storedMergeChecks(raw: string): MergeCheck[] {
  const value = storedArray(raw, "合入检查");
  const hasResults = value.some(
    (entry) => entry && typeof entry === "object" && "exitCode" in (entry as Record<string, unknown>)
  );
  return hasResults ? mergeCheckResults(value) : mergeCheckCommands(value);
}

export class DevelopmentMergeRepository {
  constructor(
    private readonly transaction: SqlTransaction,
    private readonly lockRows: boolean,
    private readonly requireProject: (projectId: string) => Promise<unknown>,
    private readonly developments: Pick<DevelopmentRepository, "requireDevelopment">
  ) {}

  /**
   * The project's single merge entry. It is shared configuration, while the
   * checkout each backend prepares from it stays that backend's own fact.
   */
  async mergeConfig(projectIdValue: unknown): Promise<MergeConfig | undefined> {
    const projectId = ledgerProjectId(projectIdValue);
    const rows = await this.transaction.query<MergeConfigRow>(
      "SELECT * FROM project_data_merge_configs WHERE project_id = ?",
      [projectId]
    );
    return rows.length ? mergeConfigOf(rows[0]) : undefined;
  }

  async setMergeConfig(
    projectIdValue: unknown,
    input: MergeConfigInput,
    backendIdValue: unknown
  ): Promise<MergeConfig> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.requireProject(projectId);
    const repository = mergeRepository(input.repository);
    const targetBranch = mergeTargetBranch(input.targetBranch);
    const executionBackendId =
      input.executionBackendId === undefined
        ? ledgerIdentifier(backendIdValue, "后端 ID")
        : mergeExecutionBackendId(input.executionBackendId);
    const timestamp = now();
    const changed = await this.transaction.execute(
      `UPDATE project_data_merge_configs
          SET repository = ?, target_branch = ?, execution_backend_id = ?, updated_at = ?
        WHERE project_id = ?`,
      [repository, targetBranch, executionBackendId, timestamp, projectId]
    );
    if (!changed)
      await this.transaction.execute(
        `INSERT INTO project_data_merge_configs
           (project_id, repository, target_branch, execution_backend_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [projectId, repository, targetBranch, executionBackendId, timestamp, timestamp]
      );
    return (await this.mergeConfig(projectId))!;
  }

  /**
   * Queue one candidate for this project's target branch.
   *
   * The row is shared state, not this backend's private queue: the execution
   * backend claims it later and every other reader sees the same order.
   */
  async createMerge(
    projectIdValue: unknown,
    developmentIdValue: unknown,
    inputValue: MergeCreate
  ): Promise<DevelopmentMerge> {
    const projectId = ledgerProjectId(projectIdValue);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    const development = await this.developments.requireDevelopment(projectId, developmentId);
    const input = mergeCreate(recordOf(inputValue));
    // Serialise the duplicate check with other creates and claims. A retry for
    // the same candidate returns the existing open or merged operation instead
    // of enqueueing a second application of the same version.
    if (this.lockRows)
      await this.transaction.query(
        "SELECT project_id FROM project_data_merge_configs WHERE project_id = ? FOR UPDATE",
        [projectId]
      );
    const existing = await this.transaction.query<MergeRow>(
      `SELECT * FROM project_data_development_merges
        WHERE project_id = ? AND development_id = ? AND state IN ('waiting', 'applying', 'merged')`,
      [projectId, developmentId]
    );
    const duplicate = existing
      .map(mergeOf)
      .find((entry) => entry.candidate.commit === input.candidate.commit);
    if (duplicate) return duplicate;
    const mergeId = id("merge");
    const timestamp = now();
    await this.transaction.execute(
      `INSERT INTO project_data_development_merges
         (project_id, merge_id, development_id, requirement_id, state, revision, requested_by,
          execution_backend_id, target_branch, candidate, candidate_commit, acceptance, checks, reasons,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        mergeId,
        developmentId,
        development.requirement_id,
        "waiting",
        1,
        input.requestedBy,
        input.executionBackendId,
        input.targetBranch,
        JSON.stringify(input.candidate),
        input.candidate.commit,
        JSON.stringify(input.acceptance),
        JSON.stringify(input.checks),
        "[]",
        timestamp,
        timestamp
      ]
    );
    return this.getMerge(projectId, mergeId);
  }

  async getMerge(projectIdValue: unknown, mergeIdValue: unknown): Promise<DevelopmentMerge> {
    const projectId = ledgerProjectId(projectIdValue);
    const mergeId = ledgerIdentifier(mergeIdValue, "合入操作 ID");
    return mergeOf(await this.requireMerge(projectId, mergeId));
  }

  async queryMerges(projectIdValue: unknown, developmentIdValue?: unknown): Promise<DevelopmentMerge[]> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.requireProject(projectId);
    const developmentId =
      developmentIdValue === undefined ? undefined : developmentIdentifier(developmentIdValue, "开发记录 ID");
    const rows = await this.transaction.query<MergeRow>(
      `SELECT * FROM project_data_development_merges
        WHERE project_id = ?${developmentId ? " AND development_id = ?" : ""}
        ORDER BY created_at ASC, merge_id ASC`,
      developmentId ? [projectId, developmentId] : [projectId]
    );
    return rows.map(mergeOf);
  }

  /**
   * Move one waiting operation to `applying` with a compare-and-set.
   *
   * This is the cross-backend serialisation: a project has at most one applying
   * operation (enforced by the partial unique index) and every claim re-reads
   * the row it expected. A per-requirement lock is not the project's coordination.
   */
  async claimMerge(
    projectIdValue: unknown,
    mergeIdValue: unknown,
    inputValue: unknown
  ): Promise<DevelopmentMerge> {
    const projectId = ledgerProjectId(projectIdValue);
    const mergeId = ledgerIdentifier(mergeIdValue, "合入操作 ID");
    const input = mergeClaim(recordOf(inputValue));
    // A stable project row serialises concurrent claims on PostgreSQL; SQLite
    // already runs one BEGIN IMMEDIATE writer at a time.
    if (this.lockRows)
      await this.transaction.query(
        "SELECT project_id FROM project_data_merge_configs WHERE project_id = ? FOR UPDATE",
        [projectId]
      );
    const current = await this.requireMerge(projectId, mergeId);
    if (current.state !== "waiting")
      throw new ProjectDataConflictError(
        `合入操作已是 ${current.state}，不能重复领取`,
        undefined,
        "merge_not_claimable"
      );
    const busy = await this.transaction.query<{ merge_id: string }>(
      "SELECT merge_id FROM project_data_development_merges WHERE project_id = ? AND state = 'applying'",
      [projectId]
    );
    if (busy.length)
      throw new ProjectDataConflictError(
        "该项目仍有一个合入操作在更新目标分支，请按顺序处理",
        undefined,
        "merge_busy"
      );
    const timestamp = now();
    const changed = await this.transaction.execute(
      `UPDATE project_data_development_merges
          SET state = 'applying', revision = revision + 1, owner_started_at = ?, updated_at = ?
        WHERE project_id = ? AND merge_id = ? AND revision = ? AND state = 'waiting'`,
      [input.ownerStartedAt, timestamp, projectId, mergeId, input.expectedRevision]
    );
    if (changed !== 1)
      throw new ProjectDataConflictError(
        "合入操作已被另一调用领取，请重新读取",
        undefined,
        "merge_not_claimable"
      );
    return this.getMerge(projectId, mergeId);
  }

  /** Record one operation's own facts; a stale revision is refused like a record update. */
  async updateMerge(
    projectIdValue: unknown,
    mergeIdValue: unknown,
    inputValue: unknown
  ): Promise<DevelopmentMerge> {
    const projectId = ledgerProjectId(projectIdValue);
    const mergeId = ledgerIdentifier(mergeIdValue, "合入操作 ID");
    const current = await this.requireMerge(projectId, mergeId);
    const input = mergeUpdate(recordOf(inputValue));
    const timestamp = now();
    const changed = await this.transaction.execute(
      `UPDATE project_data_development_merges
          SET state = ?, revision = ?, checks = ?, reasons = ?, combined_base = ?,
              expected_target = ?, merge_commit = ?, detail = ?, updated_at = ?
        WHERE project_id = ? AND merge_id = ? AND revision = ?`,
      [
        input.state ?? current.state,
        Number(current.revision) + 1,
        input.checks === undefined ? current.checks : JSON.stringify(input.checks),
        input.reasons === undefined ? current.reasons : JSON.stringify(input.reasons),
        input.combinedBase === undefined ? current.combined_base : input.combinedBase,
        input.expectedTarget === undefined ? current.expected_target : input.expectedTarget,
        input.mergeCommit === undefined ? current.merge_commit : input.mergeCommit,
        input.detail === undefined ? current.detail : input.detail,
        timestamp,
        projectId,
        mergeId,
        input.expectedRevision
      ]
    );
    if (changed !== 1)
      throw new ProjectDataConflictError(
        "合入操作已被另一写入更新，请重新读取",
        undefined,
        "revision_conflict"
      );
    return this.getMerge(projectId, mergeId);
  }

  private async requireMerge(projectId: string, mergeId: string): Promise<MergeRow> {
    const rows = await this.transaction.query<MergeRow>(
      `SELECT * FROM project_data_development_merges
        WHERE project_id = ? AND merge_id = ?${this.lockRows ? " FOR UPDATE" : ""}`,
      [projectId, mergeId]
    );
    if (!rows.length) throw new ProjectDataNotFoundError("合入操作不存在");
    return rows[0];
  }
}
