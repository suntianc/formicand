import {
  ALIAS_LIMIT,
  ledgerAlias,
  ledgerIdentifier,
  ledgerProjectId,
  ledgerRevision,
  ProjectDataConflictError,
  ProjectDataInvalidError,
  ProjectDataNotFoundError
} from "../domain/project-ledger.js";
import {
  applyTicketWrite,
  checkTicketSet,
  storedTickets,
  type TicketSet,
  type TicketWrite
} from "../domain/development-ticket.js";
import {
  DevelopmentExistsError,
  developmentBaseline,
  developmentCompletionCriteria,
  developmentGoal,
  developmentIdentifier,
  developmentRoute,
  developmentStatus,
  developmentWorkspace,
  type DevelopmentRecord,
  type DevelopmentWorkspace
} from "../domain/project-development.js";
import { id, now } from "../domain/types.js";
import type { SqlTransaction } from "../storage/project-data/database.js";
import { lookupRequirements, type LookupEntry } from "../domain/ledger-lookup.js";

import type { DevelopmentCreate, DevelopmentUpdate } from "./project-data-gateway.js";
import type { RequirementRow } from "./project-ledger-repository.js";
import { storedJson } from "./project-data-json.js";

interface DevelopmentLedger {
  requireProject(projectId: string): Promise<unknown>;
  requireRequirement(projectId: string, requirementId: string): Promise<RequirementRow>;
  lookupEntries(projectId: string): Promise<LookupEntry[]>;
  insertAlias(
    projectId: string,
    requirementId: string,
    alias: string,
    developmentId: string,
    timestamp: string
  ): Promise<void>;
}

interface DevelopmentRow {
  project_id: string;
  development_id: string;
  requirement_id: string;
  goal: string;
  completion_criteria: string;
  route: string;
  status: string;
  revision: number;
  baseline_branch: string;
  baseline_commit: string;
  session_id: string | null;
  task_id: string | null;
  created_at: string;
  updated_at: string;
  requirement_title?: string | null;
}
interface DevelopmentWorkspaceRow {
  project_id: string;
  development_id: string;
  backend_id: string;
  workspace_id: string;
  directory: string;
  branch: string;
  base_commit: string;
  state: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}
interface TicketSetRow {
  project_id: string;
  development_id: string;
  tickets: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
function criteriaOf(raw: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProjectDataInvalidError("开发记录的完成标准已损坏");
  }
  return developmentCompletionCriteria(value);
}

function developmentOf(row: DevelopmentRow, workspace?: DevelopmentWorkspace): DevelopmentRecord {
  return {
    projectId: row.project_id,
    developmentId: row.development_id,
    requirementId: row.requirement_id,
    requirementTitle: row.requirement_title ?? "",
    goal: row.goal,
    completionCriteria: criteriaOf(row.completion_criteria),
    route: developmentRoute(row.route),
    status: developmentStatus(row.status),
    revision: Number(row.revision),
    baseline: developmentBaseline({ branch: row.baseline_branch, commit: row.baseline_commit }),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(workspace ? { workspace } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function workspaceOf(row: DevelopmentWorkspaceRow): DevelopmentWorkspace {
  return {
    workspaceId: row.workspace_id,
    backendId: row.backend_id,
    directory: row.directory,
    branch: row.branch,
    baseCommit: row.base_commit,
    state: row.state as DevelopmentWorkspace["state"],
    ...(row.error ? { error: row.error } : {})
  };
}

export class DevelopmentRepository {
  constructor(
    private readonly transaction: SqlTransaction,
    private readonly lockRows: boolean,
    private readonly ledger: DevelopmentLedger
  ) {}

  /**
   * One development record per requirement: the goal, criteria, route and
   * baseline the Main agreed before any checkout exists.
   */
  async createDevelopment(projectIdValue: unknown, input: DevelopmentCreate): Promise<DevelopmentRecord> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.ledger.requireProject(projectId);
    const requirementId = ledgerIdentifier(input.requirementId, "需求 ID");
    const requirement = await this.ledger.requireRequirement(projectId, requirementId);
    if (requirement.status !== "active")
      throw new ProjectDataConflictError("需求已停用，不能再开发", undefined, "requirement_retired");
    const existing = await this.developmentByRequirement(projectId, requirementId);
    if (existing?.status === "active")
      throw new DevelopmentExistsError(
        `该需求有一次开发还在进行（${existing.development_id}）；继续这次开发，或等它合入、撤回后再新建`,
        existing.development_id
      );
    const goal = developmentGoal(input.goal);
    const completionCriteria = developmentCompletionCriteria(input.completionCriteria);
    const route = developmentRoute(input.route);
    const baseline = developmentBaseline(input.baseline);
    const sessionId =
      input.sessionId === undefined || input.sessionId === null
        ? undefined
        : ledgerIdentifier(input.sessionId, "会话 ID");
    const taskId =
      input.taskId === undefined || input.taskId === null
        ? undefined
        : ledgerIdentifier(input.taskId, "Task ID");
    const request =
      input.request === undefined || input.request === null ? undefined : ledgerAlias(input.request);
    const timestamp = now();
    const developmentId = id("development");
    await this.transaction.execute(
      `INSERT INTO project_data_developments
         (project_id, development_id, requirement_id, goal, completion_criteria, route, status, revision,
          baseline_branch, baseline_commit, session_id, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        developmentId,
        requirementId,
        goal,
        JSON.stringify(completionCriteria),
        route,
        "active",
        1,
        baseline.branch,
        baseline.commit,
        sessionId ?? null,
        taskId ?? null,
        timestamp,
        timestamp
      ]
    );
    if (request) await this.learnAlias(projectId, requirementId, developmentId, request, timestamp);
    return developmentOf(await this.requireDevelopment(projectId, developmentId));
  }

  /**
   * Keep the user's words as an alias of the feature when lookup would not
   * have put this requirement first with confidence, so the same words find it
   * next time. The alias names the development it came from.
   */
  private async learnAlias(
    projectId: string,
    requirementId: string,
    developmentId: string,
    request: string,
    timestamp: string
  ): Promise<void> {
    const entries = await this.ledger.lookupEntries(projectId);
    const result = lookupRequirements(entries, request);
    if (result.verdict === "likely" && result.candidates[0]?.requirementId === requirementId) return;
    const entry = entries.find((item) => item.requirementId === requirementId)!;
    const known = [entry.title, ...entry.aliases].map((text) => text.toLowerCase());
    if (known.includes(request.toLowerCase()) || entry.aliases.length >= ALIAS_LIMIT) return;
    await this.ledger.insertAlias(projectId, requirementId, request, developmentId, timestamp);
  }

  /** A newer revision replaces goal, criteria or route; a stale one is refused. */
  async updateDevelopment(
    projectIdValue: unknown,
    developmentIdValue: unknown,
    input: DevelopmentUpdate,
    backendIdValue?: unknown
  ): Promise<DevelopmentRecord> {
    const projectId = ledgerProjectId(projectIdValue);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    const expectedRevision = ledgerRevision(input.expectedRevision);
    const current = await this.requireDevelopment(projectId, developmentId);
    if (Number(current.revision) !== expectedRevision)
      throw new ProjectDataConflictError(
        "开发记录已更新，请基于最新修订重试",
        Number(current.revision),
        "revision_conflict"
      );
    if (current.status !== "active")
      throw new ProjectDataConflictError(
        `这次开发已${current.status === "merged" ? "合入" : "撤回"}，不能再改；同一需求的新工作新建一次开发`,
        undefined,
        "development_closed"
      );
    const status = input.status === undefined ? "active" : developmentStatus(input.status);
    if (status === "merged")
      throw new ProjectDataInvalidError("开发记录只能改为 withdrawn；合入由交付记录写");
    if (status === "withdrawn") {
      const pending = await this.transaction.query<{ merge_id: string }>(
        "SELECT merge_id FROM project_data_development_merges WHERE project_id = ? AND development_id = ? AND state IN ('waiting', 'applying', 'merged')",
        [projectId, developmentId]
      );
      if (pending.length)
        throw new ProjectDataConflictError(
          `这次开发有合入（${pending[0].merge_id}）在排队或已合入，不能撤回`,
          undefined,
          "development_merge_pending"
        );
    }
    const goal = input.goal === undefined ? current.goal : developmentGoal(input.goal);
    const completionCriteria =
      input.completionCriteria === undefined
        ? criteriaOf(current.completion_criteria)
        : developmentCompletionCriteria(input.completionCriteria);
    const route = input.route === undefined ? developmentRoute(current.route) : developmentRoute(input.route);
    if (route !== current.route)
      checkTicketSet((await this.tickets(projectId, developmentId)).tickets, route);
    const revision = expectedRevision + 1;
    const timestamp = now();
    const changed = await this.transaction.execute(
      `UPDATE project_data_developments
          SET goal = ?, completion_criteria = ?, route = ?, status = ?, revision = ?, updated_at = ?
        WHERE project_id = ? AND development_id = ? AND revision = ?`,
      [
        goal,
        JSON.stringify(completionCriteria),
        route,
        status,
        revision,
        timestamp,
        projectId,
        developmentId,
        expectedRevision
      ]
    );
    if (changed !== 1)
      throw new ProjectDataConflictError(
        "开发记录已被另一写入更新，请重新读取",
        undefined,
        "revision_conflict"
      );
    return this.getDevelopment(projectId, developmentId, backendIdValue);
  }

  async getDevelopment(
    projectIdValue: unknown,
    developmentIdValue: unknown,
    backendIdValue?: unknown
  ): Promise<DevelopmentRecord> {
    const projectId = ledgerProjectId(projectIdValue);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    const row = await this.requireDevelopment(projectId, developmentId);
    const workspace = await this.developmentWorkspaceFor(projectId, developmentId, backendIdValue);
    return developmentOf(row, workspace);
  }

  async queryDevelopments(projectIdValue: unknown, backendIdValue?: unknown): Promise<DevelopmentRecord[]> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.ledger.requireProject(projectId);
    const rows = await this.transaction.query<DevelopmentRow>(
      `SELECT d.*, r.title AS requirement_title
         FROM project_data_developments d
         LEFT JOIN project_data_requirements r
           ON r.project_id = d.project_id AND r.requirement_id = d.requirement_id
        WHERE d.project_id = ?
        ORDER BY d.updated_at DESC, d.development_id ASC`,
      [projectId]
    );
    const workspaces = await this.developmentWorkspaces(
      projectId,
      rows.map((row) => row.development_id),
      backendIdValue
    );
    return rows.map((row) => developmentOf(row, workspaces.get(row.development_id)));
  }

  async findDevelopmentByRequirement(
    projectIdValue: unknown,
    requirementIdValue: unknown,
    backendIdValue?: unknown
  ): Promise<DevelopmentRecord | undefined> {
    const projectId = ledgerProjectId(projectIdValue);
    const requirementId = ledgerIdentifier(requirementIdValue, "需求 ID");
    const row = await this.developmentByRequirement(projectId, requirementId);
    if (!row) return undefined;
    const workspace = await this.developmentWorkspaceFor(projectId, row.development_id, backendIdValue);
    return developmentOf(row, workspace);
  }

  /**
   * Record the checkout this backend prepared (or failed to prepare). A failed
   * attempt keeps the identity and directory it last had, so the requirement
   * and its workspace remain findable instead of disappearing.
   */
  async recordDevelopmentWorkspace(
    projectIdValue: unknown,
    developmentIdValue: unknown,
    workspaceValue: unknown
  ): Promise<DevelopmentRecord> {
    const projectId = ledgerProjectId(projectIdValue);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    await this.requireDevelopment(projectId, developmentId);
    const workspace = developmentWorkspace(workspaceValue);
    const timestamp = now();
    const changed = await this.transaction.execute(
      `UPDATE project_data_development_workspaces
          SET workspace_id = ?, directory = ?, branch = ?, base_commit = ?, state = ?, error = ?, updated_at = ?
        WHERE project_id = ? AND development_id = ? AND backend_id = ?`,
      [
        workspace.workspaceId,
        workspace.directory,
        workspace.branch,
        workspace.baseCommit,
        workspace.state,
        workspace.error ?? null,
        timestamp,
        projectId,
        developmentId,
        workspace.backendId
      ]
    );
    if (!changed)
      await this.transaction.execute(
        `INSERT INTO project_data_development_workspaces
           (project_id, development_id, backend_id, workspace_id, directory, branch, base_commit, state, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          projectId,
          developmentId,
          workspace.backendId,
          workspace.workspaceId,
          workspace.directory,
          workspace.branch,
          workspace.baseCommit,
          workspace.state,
          workspace.error ?? null,
          timestamp,
          timestamp
        ]
      );
    return this.getDevelopment(projectId, developmentId, workspace.backendId);
  }

  async tickets(projectIdValue: unknown, developmentIdValue: unknown): Promise<TicketSet> {
    const projectId = ledgerProjectId(projectIdValue);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    await this.requireDevelopment(projectId, developmentId);
    const rows = await this.transaction.query<TicketSetRow>(
      `SELECT * FROM project_data_development_tickets WHERE project_id = ? AND development_id = ?`,
      [projectId, developmentId]
    );
    const row = rows.at(0);
    if (!row) return { projectId, developmentId, revision: 0, tickets: [] };
    return {
      projectId,
      developmentId,
      revision: Number(row.revision),
      tickets: storedTickets(storedJson(row.tickets, "票记录")),
      updatedAt: row.updated_at
    };
  }

  /** Apply one ticket write against the development's current route; a dry run stores nothing. */
  async writeTickets(
    projectIdValue: unknown,
    developmentIdValue: unknown,
    write: TicketWrite
  ): Promise<TicketSet> {
    const projectId = ledgerProjectId(projectIdValue);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    const development = await this.requireDevelopment(projectId, developmentId);
    const current = await this.tickets(projectId, developmentId);
    const timestamp = now();
    const next = applyTicketWrite(current, write, developmentRoute(development.route), timestamp);
    if ("dryRun" in write && write.dryRun) return next;
    const tickets = JSON.stringify(next.tickets);
    if (current.revision === 0)
      await this.transaction.execute(
        `INSERT INTO project_data_development_tickets
           (project_id, development_id, tickets, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [projectId, developmentId, tickets, next.revision, timestamp, timestamp]
      );
    else {
      const changed = await this.transaction.execute(
        `UPDATE project_data_development_tickets SET tickets = ?, revision = ?, updated_at = ?
          WHERE project_id = ? AND development_id = ? AND revision = ?`,
        [tickets, next.revision, timestamp, projectId, developmentId, current.revision]
      );
      if (changed !== 1)
        throw new ProjectDataConflictError(
          "票已被另一写入更新，请重新读取",
          undefined,
          "ticket_revision_conflict"
        );
    }
    return this.tickets(projectId, developmentId);
  }

  private async developmentByRequirement(
    projectId: string,
    requirementId: string
  ): Promise<DevelopmentRow | undefined> {
    const rows = await this.transaction.query<DevelopmentRow>(
      `SELECT d.*, r.title AS requirement_title
         FROM project_data_developments d
         LEFT JOIN project_data_requirements r
           ON r.project_id = d.project_id AND r.requirement_id = d.requirement_id
        WHERE d.project_id = ? AND d.requirement_id = ?
        ORDER BY CASE WHEN d.status = 'active' THEN 0 ELSE 1 END, d.created_at DESC, d.development_id DESC
        LIMIT 1`,
      [projectId, requirementId]
    );
    return rows[0];
  }

  async requireDevelopment(projectId: string, developmentId: string): Promise<DevelopmentRow> {
    // PostgreSQL cannot lock the nullable side of an outer join, so the row is
    // locked on its own table and the requirement title is read separately.
    const rows = await this.transaction.query<DevelopmentRow>(
      `SELECT * FROM project_data_developments
        WHERE project_id = ? AND development_id = ?${this.lockRows ? " FOR UPDATE" : ""}`,
      [projectId, developmentId]
    );
    if (!rows.length) throw new ProjectDataNotFoundError("找不到该需求的开发记录");
    const titles = await this.transaction.query<{ title: string }>(
      "SELECT title FROM project_data_requirements WHERE project_id = ? AND requirement_id = ?",
      [projectId, rows[0].requirement_id]
    );
    return { ...rows[0], requirement_title: titles[0]?.title ?? null };
  }

  private async developmentWorkspaceFor(
    projectId: string,
    developmentId: string,
    backendIdValue?: unknown
  ): Promise<DevelopmentWorkspace | undefined> {
    if (backendIdValue === undefined || backendIdValue === null) return undefined;
    const backendId = ledgerIdentifier(backendIdValue, "后端 ID");
    const rows = await this.transaction.query<DevelopmentWorkspaceRow>(
      "SELECT * FROM project_data_development_workspaces WHERE project_id = ? AND development_id = ? AND backend_id = ?",
      [projectId, developmentId, backendId]
    );
    return rows.length ? workspaceOf(rows[0]) : undefined;
  }

  private async developmentWorkspaces(
    projectId: string,
    developmentIds: string[],
    backendIdValue?: unknown
  ): Promise<Map<string, DevelopmentWorkspace>> {
    const grouped = new Map<string, DevelopmentWorkspace>();
    if (!developmentIds.length || backendIdValue === undefined || backendIdValue === null) return grouped;
    const backendId = ledgerIdentifier(backendIdValue, "后端 ID");
    const rows = await this.transaction.query<DevelopmentWorkspaceRow>(
      `SELECT * FROM project_data_development_workspaces
        WHERE project_id = ? AND backend_id = ? AND development_id IN (${developmentIds
          .map(() => "?")
          .join(", ")})`,
      [projectId, backendId, ...developmentIds]
    );
    for (const row of rows) grouped.set(row.development_id, workspaceOf(row));
    return grouped;
  }
}
