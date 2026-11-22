import {
  ledgerIdentifier,
  ledgerProjectId,
  ProjectDataConflictError,
  ProjectDataInvalidError,
  ProjectDataNotFoundError,
  type RequirementReference
} from "../domain/project-ledger.js";
import { id, now } from "../domain/types.js";
import type { SqlTransaction } from "../storage/project-data/database.js";
import {
  mainSessionEntryKind,
  mainSessionKind,
  mainSessionRunState,
  mainSessionTitle,
  mainSessionTitleFromGoal,
  type MainSession,
  type MainSessionRun,
  type MainSessionRunState
} from "../domain/main-session.js";

interface MainSessionRow {
  project_id: string;
  session_id: string;
  title: string;
  entry_kind: string;
  kind: string;
  backend_id: string;
  task_id: string;
  current_requirement_id: string | null;
  created_at: string;
  updated_at: string;
  requirement_title: string | null;
}
interface MainSessionRunRow {
  project_id: string;
  session_id: string;
  run_id: string;
  task_id: string;
  requirement_id: string | null;
  state: string;
  created_at: string;
  updated_at: string;
}

/** One session with the requirement it is on and the Runs it already owns. */
export interface MainSessionRecord {
  session: MainSession;
  currentRequirementTitle?: string;
  runs: MainSessionRun[];
}

function runOf(row: MainSessionRunRow): MainSessionRun {
  return {
    projectId: row.project_id,
    sessionId: row.session_id,
    runId: row.run_id,
    taskId: row.task_id,
    ...(row.requirement_id ? { requirementId: row.requirement_id } : {}),
    state: row.state as MainSessionRunState,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

interface MainSessionLedger {
  requireProject(projectId: string): Promise<void>;
  requireRequirement(projectId: string, requirementId: string): Promise<{ title: string }>;
  insertReferences(
    projectId: string,
    requirementId: string,
    references: Array<{ kind: RequirementReference["kind"]; value: string }>
  ): Promise<void>;
}

/**
 * Shared Main sessions and their Run ownership. Session and ledger writes
 * use the same transaction, including requirement locks and durable links.
 */
export class ProjectMainSessionRepository {
  constructor(
    private readonly transaction: SqlTransaction,
    private readonly ledger: MainSessionLedger
  ) {}

  /**
   * A project's persistent Main sessions.
   *
   * The transcript stays with the Task on the backend that holds it, so these
   * methods only carry shared identity: which project, which requirement, which
   * local history container and which backend may run it.
   */
  async createMainSession(
    projectIdValue: unknown,
    input: {
      title?: unknown;
      entryKind?: unknown;
      kind?: unknown;
      backendId: unknown;
      taskId: unknown;
      requirementId?: unknown;
    }
  ): Promise<MainSessionRecord> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.ledger.requireProject(projectId);
    const backendId = ledgerIdentifier(input.backendId, "后端 ID");
    const taskId = ledgerIdentifier(input.taskId, "Task ID");
    const existing = await this.mainSessionRow(projectId, backendId, taskId);
    if (existing) return this.mainSession(projectId, existing.session_id);
    const requirementId =
      input.requirementId === undefined || input.requirementId === null
        ? undefined
        : ledgerIdentifier(input.requirementId, "需求 ID");
    const requirement = requirementId
      ? await this.ledger.requireRequirement(projectId, requirementId)
      : undefined;
    const title = input.title === undefined ? (requirement?.title ?? taskId) : mainSessionTitle(input.title);
    const timestamp = now();
    await this.transaction.execute(
      `INSERT INTO project_data_main_sessions
         (project_id, session_id, title, entry_kind, kind, backend_id, task_id, current_requirement_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        id("session"),
        title,
        mainSessionEntryKind(input.entryKind),
        mainSessionKind(input.kind),
        backendId,
        taskId,
        requirementId ?? null,
        timestamp,
        timestamp
      ]
    );
    const row = (await this.mainSessionRow(projectId, backendId, taskId))!;
    if (requirementId)
      await this.ledger.insertReferences(projectId, requirementId, [
        { kind: "session", value: row.session_id },
        { kind: "task", value: taskId }
      ]);
    return this.mainSession(projectId, row.session_id);
  }

  /**
   * Take back a session whose Task could not be written: the backend that
   * created it removes it, with the references it made, before it ever ran.
   */
  async discardMainSession(
    projectIdValue: unknown,
    backendIdValue: unknown,
    taskIdValue: unknown
  ): Promise<boolean> {
    const projectId = ledgerProjectId(projectIdValue);
    const backendId = ledgerIdentifier(backendIdValue, "后端 ID");
    const taskId = ledgerIdentifier(taskIdValue, "Task ID");
    const row = await this.mainSessionRow(projectId, backendId, taskId);
    if (!row) return false;
    const runs = await this.mainSessionRuns(projectId, [row.session_id]);
    if (runs.get(row.session_id)?.length)
      throw new ProjectDataConflictError("会话已有运行记录，不能撤销", undefined, "main_session_started");
    await this.transaction.execute(
      "DELETE FROM project_data_references WHERE project_id = ? AND ((kind = 'session' AND value = ?) OR (kind = 'task' AND value = ?))",
      [projectId, row.session_id, taskId]
    );
    await this.transaction.execute(
      "DELETE FROM project_data_main_sessions WHERE project_id = ? AND session_id = ?",
      [projectId, row.session_id]
    );
    return true;
  }

  /**
   * Map existing Tasks into sessions without moving their history.
   *
   * A conversation that predates this table already owns its Pi directory; the
   * adoption only records the identity, so a conflict means another writer got
   * there first and is not an error.
   */
  async adoptMainSessionTasks(
    projectIdValue: unknown,
    backendIdValue: unknown,
    tasks: ReadonlyArray<{ taskId: string; title?: string; goal?: string }>
  ): Promise<number> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.ledger.requireProject(projectId);
    const backendId = ledgerIdentifier(backendIdValue, "后端 ID");
    let adopted = 0;
    for (const task of tasks) {
      const taskId = ledgerIdentifier(task.taskId, "Task ID");
      const timestamp = now();
      adopted += await this.transaction.execute(
        `INSERT INTO project_data_main_sessions
           (project_id, session_id, title, entry_kind, kind, backend_id, task_id, current_requirement_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        [
          projectId,
          id("session"),
          mainSessionTitleFromGoal(task.title ?? task.goal, taskId),
          "internal",
          "regular",
          backendId,
          taskId,
          null,
          timestamp,
          timestamp
        ]
      );
    }
    return adopted;
  }

  async mainSessions(projectIdValue: unknown): Promise<MainSessionRecord[]> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.ledger.requireProject(projectId);
    const rows = await this.transaction.query<MainSessionRow>(
      `SELECT s.*, r.title AS requirement_title
         FROM project_data_main_sessions s
         LEFT JOIN project_data_requirements r
           ON r.project_id = s.project_id AND r.requirement_id = s.current_requirement_id
        WHERE s.project_id = ?
        ORDER BY s.updated_at DESC, s.session_id ASC`,
      [projectId]
    );
    const runs = await this.mainSessionRuns(
      projectId,
      rows.map((row) => row.session_id)
    );
    return rows.map((row) => this.mainSessionRecord(row, runs.get(row.session_id) ?? []));
  }

  async mainSession(projectIdValue: unknown, sessionIdValue: unknown): Promise<MainSessionRecord> {
    const projectId = ledgerProjectId(projectIdValue);
    const row = await this.requireMainSession(projectId, sessionIdValue);
    const runs = await this.mainSessionRuns(projectId, [row.session_id]);
    return this.mainSessionRecord(row, runs.get(row.session_id) ?? []);
  }

  async mainSessionByTask(
    projectIdValue: unknown,
    backendIdValue: unknown,
    taskIdValue: unknown
  ): Promise<MainSessionRecord | undefined> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.ledger.requireProject(projectId);
    const backendId = ledgerIdentifier(backendIdValue, "后端 ID");
    const taskId = ledgerIdentifier(taskIdValue, "Task ID");
    const row = await this.mainSessionRow(projectId, backendId, taskId);
    if (!row) return undefined;
    const runs = await this.mainSessionRuns(projectId, [row.session_id]);
    return this.mainSessionRecord(row, runs.get(row.session_id) ?? []);
  }

  async setMainSessionRequirement(
    projectIdValue: unknown,
    sessionIdValue: unknown,
    requirementIdValue: unknown
  ): Promise<MainSessionRecord> {
    const projectId = ledgerProjectId(projectIdValue);
    const row = await this.requireMainSession(projectId, sessionIdValue);
    const requirementId = ledgerIdentifier(requirementIdValue, "需求 ID");
    await this.ledger.requireRequirement(projectId, requirementId);
    const timestamp = now();
    await this.transaction.execute(
      "UPDATE project_data_main_sessions SET current_requirement_id = ?, updated_at = ? WHERE project_id = ? AND session_id = ?",
      [requirementId, timestamp, projectId, row.session_id]
    );
    // The requirement records the session that accepted it, so the link survives
    // the session moving on to the next requirement.
    await this.ledger.insertReferences(projectId, requirementId, [
      { kind: "session", value: row.session_id },
      { kind: "task", value: row.task_id }
    ]);
    return this.mainSession(projectId, row.session_id);
  }

  /** Record that a Run belongs to this session; a later message on it keeps the row. */
  async recordMainSessionRun(
    projectIdValue: unknown,
    sessionIdValue: unknown,
    input: { runId: unknown; taskId: unknown; requirementId?: unknown; state?: unknown }
  ): Promise<MainSessionRun> {
    const projectId = ledgerProjectId(projectIdValue);
    const session = this.sessionOf(await this.requireMainSession(projectId, sessionIdValue));
    const runId = ledgerIdentifier(input.runId, "Run ID");
    const taskId = ledgerIdentifier(input.taskId, "Task ID");
    if (taskId !== session.taskId) throw new ProjectDataInvalidError("运行不属于该会话的历史容器");
    const requirementId =
      input.requirementId === undefined || input.requirementId === null
        ? undefined
        : ledgerIdentifier(input.requirementId, "需求 ID");
    if (requirementId) await this.ledger.requireRequirement(projectId, requirementId);
    const state = input.state === undefined ? "running" : mainSessionRunState(input.state);
    const timestamp = now();
    // A re-record carries the requirement only when the caller names one; an
    // ordinary retry or continuation must keep the link it already has.
    const changed = await this.transaction.execute(
      "UPDATE project_data_main_session_runs SET requirement_id = COALESCE(?, requirement_id), state = ?, updated_at = ? WHERE project_id = ? AND session_id = ? AND run_id = ?",
      [requirementId ?? null, state, timestamp, projectId, session.sessionId, runId]
    );
    if (!changed)
      await this.transaction.execute(
        `INSERT INTO project_data_main_session_runs
           (project_id, session_id, run_id, task_id, requirement_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [projectId, session.sessionId, runId, taskId, requirementId ?? null, state, timestamp, timestamp]
      );
    await this.transaction.execute(
      `UPDATE project_data_main_sessions
          SET current_requirement_id = COALESCE(?, current_requirement_id), updated_at = ?
        WHERE project_id = ? AND session_id = ?`,
      [requirementId ?? null, timestamp, projectId, session.sessionId]
    );
    if (requirementId)
      await this.ledger.insertReferences(projectId, requirementId, [
        { kind: "session", value: session.sessionId },
        { kind: "task", value: session.taskId }
      ]);
    const row = await this.transaction.query<MainSessionRunRow>(
      "SELECT * FROM project_data_main_session_runs WHERE project_id = ? AND session_id = ? AND run_id = ?",
      [projectId, session.sessionId, runId]
    );
    return runOf(row[0]);
  }

  /** A settled or cancelled Run keeps its owner; a later state never overwrites one. */
  async settleMainSessionRun(
    projectIdValue: unknown,
    taskIdValue: unknown,
    runIdValue: unknown,
    stateValue: unknown
  ): Promise<number> {
    const projectId = ledgerProjectId(projectIdValue);
    const taskId = ledgerIdentifier(taskIdValue, "Task ID");
    const runId = ledgerIdentifier(runIdValue, "Run ID");
    const state = mainSessionRunState(stateValue);
    return this.transaction.execute(
      `UPDATE project_data_main_session_runs SET state = ?, updated_at = ?
        WHERE project_id = ? AND task_id = ? AND run_id = ? AND state = 'running'`,
      [state, now(), projectId, taskId, runId]
    );
  }

  private async mainSessionRuns(
    projectIdValue: unknown,
    sessionIds: string[]
  ): Promise<Map<string, MainSessionRun[]>> {
    const grouped = new Map<string, MainSessionRun[]>();
    if (!sessionIds.length) return grouped;
    const rows = await this.transaction.query<MainSessionRunRow>(
      `SELECT * FROM project_data_main_session_runs
        WHERE project_id = ? AND session_id IN (${sessionIds.map(() => "?").join(", ")})
        ORDER BY created_at DESC, run_id ASC`,
      [ledgerProjectId(projectIdValue), ...sessionIds]
    );
    for (const row of rows) {
      const list = grouped.get(row.session_id) ?? [];
      // A session list stays readable; the newest Runs describe its recent work.
      if (list.length < 50) list.push(runOf(row));
      grouped.set(row.session_id, list);
    }
    return grouped;
  }

  private sessionOf(row: MainSessionRow): MainSession {
    return {
      sessionId: row.session_id,
      projectId: row.project_id,
      title: row.title,
      entryKind: row.entry_kind as MainSession["entryKind"],
      kind: row.kind as MainSession["kind"],
      backendId: row.backend_id,
      taskId: row.task_id,
      ...(row.current_requirement_id ? { currentRequirementId: row.current_requirement_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mainSessionRecord(row: MainSessionRow, runs: MainSessionRun[]): MainSessionRecord {
    return {
      session: this.sessionOf(row),
      ...(row.requirement_title ? { currentRequirementTitle: row.requirement_title } : {}),
      runs
    };
  }

  private async mainSessionRow(
    projectId: string,
    backendId: string,
    taskId: string
  ): Promise<MainSessionRow | undefined> {
    const rows = await this.transaction.query<MainSessionRow>(
      `SELECT s.*, r.title AS requirement_title
         FROM project_data_main_sessions s
         LEFT JOIN project_data_requirements r
           ON r.project_id = s.project_id AND r.requirement_id = s.current_requirement_id
        WHERE s.project_id = ? AND s.backend_id = ? AND s.task_id = ?`,
      [projectId, backendId, taskId]
    );
    return rows[0];
  }

  private async requireMainSession(projectId: string, sessionIdValue: unknown): Promise<MainSessionRow> {
    const sessionId = ledgerIdentifier(sessionIdValue, "会话 ID");
    const rows = await this.transaction.query<MainSessionRow>(
      `SELECT s.*, r.title AS requirement_title
         FROM project_data_main_sessions s
         LEFT JOIN project_data_requirements r
           ON r.project_id = s.project_id AND r.requirement_id = s.current_requirement_id
        WHERE s.project_id = ? AND s.session_id = ?`,
      [projectId, sessionId]
    );
    if (!rows.length) throw new ProjectDataNotFoundError("找不到该 Main 会话");
    return rows[0];
  }
}
