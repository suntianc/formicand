import {
  describeFeature,
  ledgerAliases,
  ledgerDescription,
  ledgerHistoryText,
  ledgerIdentifier,
  ledgerNote,
  ledgerProjectDirectory,
  ledgerProjectId,
  ledgerProjectName,
  ledgerReferences,
  ledgerRevision,
  ledgerSearchText,
  ledgerSource,
  ledgerStatus,
  ledgerSummary,
  ledgerTaskId,
  ledgerTitle,
  ProjectDataConflictError,
  ProjectDataInvalidError,
  ProjectDataNotFoundError,
  type LedgerSource,
  type ProjectIdentity,
  type RequirementAlias,
  type RequirementDetail,
  type RequirementHistoryEntry,
  type RequirementKind,
  type RequirementReference,
  type RequirementRevision,
  type RequirementStatus,
  type RequirementSummary,
  type SharedProject
} from "../domain/project-ledger.js";
import { mergeCommit, type MergeLedgerUpdate } from "../domain/development-merge.js";
import { developmentBranch } from "../domain/project-development.js";
import { id, now } from "../domain/types.js";
import type { SqlTransaction } from "../storage/project-data/database.js";
import { insertMiscRequirement } from "../storage/project-data/migrations.js";

import type { RequirementCreate, RequirementQuery, RequirementUpdate } from "./project-data-gateway.js";
export interface ProjectRow {
  project_id: string;
  project_name: string;
  ledger_tidied_at: string | null;
  ledger_clock: string | null;
  created_at: string;
  updated_at: string;
}
export interface RequirementRow {
  project_id: string;
  requirement_id: string;
  kind: string;
  title: string;
  description: string;
  summary: string;
  source_kind: string;
  source_reference: string | null;
  status: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface RevisionRow {
  revision: number;
  title: string;
  description: string;
  summary: string;
  status: string;
  source_kind: string;
  source_reference: string | null;
  note: string | null;
  task_id: string | null;
  created_at: string;
}
export interface AliasRow {
  alias: string;
  development_id: string | null;
  created_at: string;
}
export interface HistoryRow {
  entry_id: string;
  day: string;
  text: string;
  development_id: string | null;
  created_at: string;
}
export interface ReferenceRow {
  reference_id: string;
  kind: string;
  value: string;
  created_at: string;
}
export function sourceOf(kind: string, reference: string | null): LedgerSource {
  return { kind: kind as LedgerSource["kind"], ...(reference ? { reference } : {}) };
}

function aliasOf(row: AliasRow): RequirementAlias {
  return {
    alias: row.alias,
    ...(row.development_id ? { developmentId: row.development_id } : {}),
    createdAt: row.created_at
  };
}

function historyOf(row: HistoryRow): RequirementHistoryEntry {
  return {
    entryId: row.entry_id,
    day: row.day,
    text: row.text,
    ...(row.development_id ? { developmentId: row.development_id } : {}),
    createdAt: row.created_at
  };
}

function revisionOf(row: RevisionRow): RequirementRevision {
  return {
    revision: Number(row.revision),
    title: row.title,
    description: row.description,
    summary: row.summary,
    status: row.status as RequirementStatus,
    source: sourceOf(row.source_kind, row.source_reference),
    ...(row.note ? { note: row.note } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    createdAt: row.created_at
  };
}

function referenceOf(row: ReferenceRow): RequirementReference {
  return {
    referenceId: row.reference_id,
    kind: row.kind as RequirementReference["kind"],
    value: row.value,
    createdAt: row.created_at
  };
}

function likePattern(text: string): string {
  return `%${text.toLowerCase().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

/**
 * Ledger writes inside one transaction.
 *
 * Every method here runs on the caller's transaction, so a future board entry
 * can be committed together with the requirement it projects.
 */
export class ProjectLedgerRepository {
  constructor(
    protected readonly transaction: SqlTransaction,
    protected readonly lockRows = false
  ) {}

  /** Record the shared identity and this backend's directory binding, keeping both apart. */
  async ensureProject(input: {
    projectId: unknown;
    projectName: unknown;
    projectDirectory: unknown;
    backendId: string;
  }): Promise<ProjectIdentity> {
    const projectId = ledgerProjectId(input.projectId);
    const projectName = ledgerProjectName(input.projectName);
    const projectDirectory = ledgerProjectDirectory(input.projectDirectory);
    const timestamp = now();
    const existing = await this.transaction.query<ProjectRow>(
      "SELECT * FROM project_data_projects WHERE project_id = ?",
      [projectId]
    );
    let createdAt = timestamp;
    if (existing.length) {
      createdAt = existing[0].created_at;
      if (existing[0].project_name !== projectName)
        await this.transaction.execute(
          "UPDATE project_data_projects SET project_name = ?, updated_at = ? WHERE project_id = ?",
          [projectName, timestamp, projectId]
        );
    } else {
      await this.transaction.execute(
        "INSERT INTO project_data_projects (project_id, project_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        [projectId, projectName, timestamp, timestamp]
      );
      await insertMiscRequirement(this.transaction, projectId, timestamp);
    }
    const binding = await this.transaction.query<{ local_directory: string }>(
      "SELECT local_directory FROM project_data_bindings WHERE backend_id = ? AND project_id = ?",
      [input.backendId, projectId]
    );
    if (!binding.length)
      await this.transaction.execute(
        "INSERT INTO project_data_bindings (backend_id, project_id, local_directory, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [input.backendId, projectId, projectDirectory, timestamp, timestamp]
      );
    else if (binding[0].local_directory !== projectDirectory)
      await this.transaction.execute(
        "UPDATE project_data_bindings SET local_directory = ?, updated_at = ? WHERE backend_id = ? AND project_id = ?",
        [projectDirectory, timestamp, input.backendId, projectId]
      );
    return { projectId, projectName, projectDirectory, createdAt, updatedAt: timestamp };
  }

  async projects(): Promise<SharedProject[]> {
    const rows = await this.transaction.query<ProjectRow>(
      "SELECT * FROM project_data_projects ORDER BY updated_at DESC, project_id ASC"
    );
    return rows.map((row) => ({
      projectId: row.project_id,
      projectName: row.project_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  async createRequirement(projectIdValue: unknown, input: RequirementCreate): Promise<RequirementDetail> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.requireProject(projectId);
    const requirementId = id("requirement");
    const title = ledgerTitle(input.title);
    const summary = ledgerSummary(input.summary);
    const description =
      input.description === undefined || input.description === null
        ? describeFeature(summary, title)
        : ledgerDescription(input.description);
    const aliases = ledgerAliases(input.aliases);
    const source = ledgerSource(input.source);
    const references = ledgerReferences(input.references);
    const timestamp = now();
    await this.transaction.execute(
      `INSERT INTO project_data_requirements
         (project_id, requirement_id, kind, title, description, summary, source_kind, source_reference, status, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        requirementId,
        "feature",
        title,
        description,
        summary,
        source.kind,
        source.reference ?? null,
        "active",
        1,
        timestamp,
        timestamp
      ]
    );
    await this.insertRevision(projectId, requirementId, {
      revision: 1,
      title,
      description,
      summary,
      status: "active",
      source,
      createdAt: timestamp
    });
    for (const alias of aliases)
      await this.insertAlias(projectId, requirementId, alias, undefined, timestamp);
    for (const reference of references)
      await this.transaction.execute(
        "INSERT INTO project_data_references (project_id, requirement_id, reference_id, kind, value, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [projectId, requirementId, id("reference"), reference.kind, reference.value, timestamp]
      );
    return this.requirement(projectId, requirementId);
  }

  async updateRequirement(
    projectIdValue: unknown,
    requirementIdValue: unknown,
    input: RequirementUpdate
  ): Promise<RequirementDetail> {
    const projectId = ledgerProjectId(projectIdValue);
    const requirementId = ledgerIdentifier(requirementIdValue, "需求 ID");
    const expectedRevision = ledgerRevision(input.expectedRevision);
    const current = await this.requireRequirement(projectId, requirementId);
    if (Number(current.revision) !== expectedRevision)
      throw new ProjectDataConflictError(
        "需求已更新，请基于最新修订重试",
        Number(current.revision),
        "revision_conflict"
      );
    const title = input.title === undefined ? current.title : ledgerTitle(input.title);
    const description =
      input.description === undefined ? current.description : ledgerDescription(input.description);
    const summary = input.summary === undefined ? current.summary : ledgerSummary(input.summary);
    const status = ledgerStatus(input.status, current.status as RequirementStatus);
    if (
      current.kind === "misc" &&
      (status !== "active" || title !== current.title || description !== current.description)
    )
      throw new ProjectDataConflictError(
        "杂项需求不能改名、改描述或停用",
        undefined,
        "requirement_misc_fixed"
      );
    const aliases = input.aliases === undefined ? undefined : ledgerAliases(input.aliases);
    const history = input.history === undefined ? undefined : ledgerHistoryText(input.history);
    const note = ledgerNote(input.note);
    const taskId = ledgerTaskId(input.taskId);
    const revision = expectedRevision + 1;
    const timestamp = now();
    await this.insertRevision(projectId, requirementId, {
      revision,
      title,
      description,
      summary,
      status,
      source: sourceOf(current.source_kind, current.source_reference),
      note,
      taskId,
      createdAt: timestamp
    });
    const changed = await this.transaction.execute(
      `UPDATE project_data_requirements
          SET title = ?, description = ?, summary = ?, status = ?, revision = ?, updated_at = ?
        WHERE project_id = ? AND requirement_id = ? AND revision = ?`,
      [title, description, summary, status, revision, timestamp, projectId, requirementId, expectedRevision]
    );
    if (changed !== 1)
      throw new ProjectDataConflictError("需求已被另一写入更新，请重新读取", undefined, "revision_conflict");
    if (aliases) {
      const kept = (await this.aliases(projectId, [requirementId])).get(requirementId) ?? [];
      for (const alias of kept.filter((item) => !aliases.includes(item.alias)))
        await this.transaction.execute(
          "DELETE FROM project_data_requirement_aliases WHERE project_id = ? AND requirement_id = ? AND alias = ?",
          [projectId, requirementId, alias.alias]
        );
      for (const alias of aliases.filter((item) => !kept.some((entry) => entry.alias === item)))
        await this.insertAlias(projectId, requirementId, alias, undefined, timestamp);
    }
    if (history) await this.insertHistory(projectId, requirementId, history, undefined, timestamp);
    return this.requirement(projectId, requirementId);
  }

  async requirement(projectIdValue: unknown, requirementIdValue: unknown): Promise<RequirementDetail> {
    const projectId = ledgerProjectId(projectIdValue);
    const requirementId = ledgerIdentifier(requirementIdValue, "需求 ID");
    const row = await this.requireRequirement(projectId, requirementId);
    // One client per transaction: queries stay sequential rather than racing it.
    const aliases = await this.aliases(projectId, [requirementId]);
    const references = await this.references(projectId, [requirementId]);
    const developments = await this.developmentCounts(projectId, [requirementId]);
    const history = await this.transaction.query<HistoryRow>(
      "SELECT * FROM project_data_requirement_history WHERE project_id = ? AND requirement_id = ? ORDER BY day ASC, created_at ASC, entry_id ASC",
      [projectId, requirementId]
    );
    const revisions = await this.transaction.query<RevisionRow>(
      "SELECT * FROM project_data_requirement_revisions WHERE project_id = ? AND requirement_id = ? ORDER BY revision ASC",
      [projectId, requirementId]
    );
    return {
      ...this.summaryOf(row, aliases, references, developments),
      history: history.map(historyOf),
      revisions: revisions.map(revisionOf)
    };
  }

  async query(projectIdValue: unknown, query: RequirementQuery = {}): Promise<RequirementSummary[]> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.requireProject(projectId);
    const text = ledgerSearchText(query.text);
    const status = query.status === undefined ? undefined : ledgerStatus(query.status);
    const limit = query.limit === undefined ? 50 : query.limit;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new ProjectDataInvalidError("limit 须为 1–200 的整数");
    const offset = query.offset === undefined ? 0 : query.offset;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
      throw new ProjectDataInvalidError("offset 须为不小于 0 的整数");
    const filters = ["project_id = ?"];
    const params: Array<string | number> = [projectId];
    if (status) {
      filters.push("status = ?");
      params.push(status);
    }
    if (text) {
      filters.push(
        `(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(description) LIKE ? ESCAPE '\\' OR LOWER(summary) LIKE ? ESCAPE '\\' OR EXISTS (
           SELECT 1 FROM project_data_requirement_aliases a
            WHERE a.project_id = project_data_requirements.project_id
              AND a.requirement_id = project_data_requirements.requirement_id
              AND LOWER(a.alias) LIKE ? ESCAPE '\\'))`
      );
      const pattern = likePattern(text);
      params.push(pattern, pattern, pattern, pattern);
    }
    params.push(limit, offset);
    const rows = await this.transaction.query<RequirementRow>(
      `SELECT * FROM project_data_requirements WHERE ${filters.join(" AND ")}
        ORDER BY updated_at DESC, requirement_id ASC LIMIT ? OFFSET ?`,
      params
    );
    const ids = rows.map((row) => row.requirement_id);
    const aliases = await this.aliases(projectId, ids);
    const references = await this.references(projectId, ids);
    const developments = await this.developmentCounts(projectId, ids);
    return rows.map((row) => this.summaryOf(row, aliases, references, developments));
  }

  /** Append only the links a requirement does not already carry. */
  protected async insertReferences(
    projectId: string,
    requirementId: string,
    references: Array<{ kind: RequirementReference["kind"]; value: string }>
  ): Promise<void> {
    const existing = await this.transaction.query<ReferenceRow>(
      "SELECT reference_id, kind, value FROM project_data_references WHERE project_id = ? AND requirement_id = ?",
      [projectId, requirementId]
    );
    const known = new Set(existing.map((row) => `${row.kind}\u0000${row.value}`));
    for (const reference of references) {
      if (known.has(`${reference.kind}\u0000${reference.value}`)) continue;
      known.add(`${reference.kind}\u0000${reference.value}`);
      await this.transaction.execute(
        "INSERT INTO project_data_references (project_id, requirement_id, reference_id, kind, value, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [projectId, requirementId, id("reference"), reference.kind, reference.value, now()]
      );
    }
  }

  private summaryOf(
    row: RequirementRow,
    aliases: Map<string, RequirementAlias[]>,
    references: Map<string, RequirementReference[]>,
    developments: Map<string, number>
  ): RequirementSummary {
    return {
      projectId: row.project_id,
      requirementId: row.requirement_id,
      kind: row.kind as RequirementKind,
      title: row.title,
      description: row.description,
      summary: row.summary,
      aliases: aliases.get(row.requirement_id) ?? [],
      source: sourceOf(row.source_kind, row.source_reference),
      status: row.status as RequirementStatus,
      revision: Number(row.revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      references: references.get(row.requirement_id) ?? [],
      developments: developments.get(row.requirement_id) ?? 0
    };
  }

  protected async insertAlias(
    projectId: string,
    requirementId: string,
    alias: string,
    developmentId: string | undefined,
    timestamp: string
  ): Promise<void> {
    await this.transaction.execute(
      "INSERT INTO project_data_requirement_aliases (project_id, requirement_id, alias, development_id, created_at) VALUES (?, ?, ?, ?, ?)",
      [projectId, requirementId, alias, developmentId ?? null, timestamp]
    );
  }

  protected async insertHistory(
    projectId: string,
    requirementId: string,
    text: string,
    developmentId: string | undefined,
    timestamp: string
  ): Promise<void> {
    await this.transaction.execute(
      "INSERT INTO project_data_requirement_history (project_id, requirement_id, entry_id, day, text, development_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        projectId,
        requirementId,
        id("history"),
        timestamp.slice(0, 10),
        text,
        developmentId ?? null,
        timestamp
      ]
    );
  }

  protected async insertRevision(
    projectId: string,
    requirementId: string,
    revision: RequirementRevision
  ): Promise<void> {
    await this.transaction.execute(
      `INSERT INTO project_data_requirement_revisions
         (project_id, requirement_id, revision, title, description, summary, status, source_kind, source_reference, note, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        requirementId,
        revision.revision,
        revision.title,
        revision.description,
        revision.summary,
        revision.status,
        revision.source.kind,
        revision.source.reference ?? null,
        revision.note ?? null,
        revision.taskId ?? null,
        revision.createdAt
      ]
    );
  }

  /** Serialize snapshot and delivery timestamps even if the host clocks tie or move backwards. */
  async nextLedgerTime(projectId: string): Promise<{ timestamp: string; tidiedAt: string | null }> {
    const project = await this.requireProject(projectId, true);
    const timestamp = new Date(
      Math.max(Date.now(), project.ledger_clock ? Date.parse(project.ledger_clock) + 1 : 0)
    ).toISOString();
    await this.transaction.execute("UPDATE project_data_projects SET ledger_clock = ? WHERE project_id = ?", [
      timestamp,
      projectId
    ]);
    return { timestamp, tidiedAt: project.ledger_tidied_at };
  }

  protected async requireProject(projectId: string, lock = false): Promise<ProjectRow> {
    const rows = await this.transaction.query<ProjectRow>(
      `SELECT * FROM project_data_projects WHERE project_id = ?${lock && this.lockRows ? " FOR UPDATE" : ""}`,
      [projectId]
    );
    if (!rows.length) throw new ProjectDataNotFoundError("找不到该项目的共享记录");
    return rows[0];
  }

  protected async requireRequirement(projectId: string, requirementId: string): Promise<RequirementRow> {
    const rows = await this.transaction.query<RequirementRow>(
      `SELECT * FROM project_data_requirements WHERE project_id = ? AND requirement_id = ?${
        this.lockRows ? " FOR UPDATE" : ""
      }`,
      [projectId, requirementId]
    );
    if (!rows.length) throw new ProjectDataNotFoundError("找不到该需求");
    return rows[0];
  }

  /** How many developments each requirement has had. */
  private async developmentCounts(projectId: string, requirementIds: string[]): Promise<Map<string, number>> {
    if (!requirementIds.length) return new Map();
    const rows = await this.transaction.query<{ requirement_id: string; count: number | string }>(
      `SELECT requirement_id, COUNT(*) AS count FROM project_data_developments WHERE project_id = ? AND requirement_id IN (${requirementIds
        .map(() => "?")
        .join(", ")}) GROUP BY requirement_id`,
      [projectId, ...requirementIds]
    );
    return new Map(rows.map((row) => [row.requirement_id, Number(row.count)]));
  }

  protected async aliases(
    projectId: string,
    requirementIds: string[]
  ): Promise<Map<string, RequirementAlias[]>> {
    const grouped = new Map<string, RequirementAlias[]>();
    if (!requirementIds.length) return grouped;
    const rows = await this.transaction.query<AliasRow & { requirement_id: string }>(
      `SELECT * FROM project_data_requirement_aliases WHERE project_id = ? AND requirement_id IN (${requirementIds
        .map(() => "?")
        .join(", ")}) ORDER BY created_at ASC, alias ASC`,
      [projectId, ...requirementIds]
    );
    for (const row of rows) {
      const list = grouped.get(row.requirement_id) ?? [];
      list.push(aliasOf(row));
      grouped.set(row.requirement_id, list);
    }
    return grouped;
  }

  private async references(
    projectId: string,
    requirementIds: string[]
  ): Promise<Map<string, RequirementReference[]>> {
    const grouped = new Map<string, RequirementReference[]>();
    if (!requirementIds.length) return grouped;
    const rows = await this.transaction.query<ReferenceRow & { requirement_id: string }>(
      `SELECT * FROM project_data_references WHERE project_id = ? AND requirement_id IN (${requirementIds
        .map(() => "?")
        .join(", ")}) ORDER BY created_at ASC, reference_id ASC`,
      [projectId, ...requirementIds]
    );
    for (const row of rows) {
      const list = grouped.get(row.requirement_id) ?? [];
      list.push(referenceOf(row));
      grouped.set(row.requirement_id, list);
    }
    return grouped;
  }

  /**
   * Record one real merge on the requirement and close its development.
   *
   * A revision note and a `delivery` reference carrying the actual merge commit
   * are written together, and the development becomes `merged`, which frees
   * the requirement for its next development. The requirement stays active: a
   * delivery is the development's outcome. Repeating the same merge is a no-op,
   * so a retried synchronization never appends a second delivery revision.
   */
  async recordRequirementDelivery(
    projectIdValue: unknown,
    requirementIdValue: unknown,
    timestamp: string,
    input: {
      developmentId: unknown;
      mergeId: unknown;
      mergedCommit: unknown;
      targetBranch: unknown;
      /** What Main said the ledger is after this development, checked when the merge was requested. */
      ledger?: MergeLedgerUpdate;
    }
  ): Promise<RequirementDetail> {
    const projectId = ledgerProjectId(projectIdValue);
    const requirementId = ledgerIdentifier(requirementIdValue, "需求 ID");
    const developmentId = ledgerIdentifier(input.developmentId, "开发记录 ID");
    const mergeId = ledgerIdentifier(input.mergeId, "合入操作 ID");
    const mergedCommit = mergeCommit(input.mergedCommit, "合入提交");
    const targetBranch = developmentBranch(input.targetBranch, "合入目标分支");
    const current = await this.requireRequirement(projectId, requirementId);
    await this.transaction.execute(
      "UPDATE project_data_developments SET status = 'merged', updated_at = ? WHERE project_id = ? AND development_id = ? AND status = 'active'",
      [now(), projectId, developmentId]
    );
    const delivered = await this.transaction.query<ReferenceRow>(
      "SELECT * FROM project_data_references WHERE project_id = ? AND requirement_id = ? AND kind = 'delivery' AND value = ?",
      [projectId, requirementId, mergedCommit]
    );
    if (delivered.length) return this.requirement(projectId, requirementId);
    const revision = Number(current.revision) + 1;
    const note = `合入 ${targetBranch} · ${mergedCommit.slice(0, 12)} · ${mergeId}`;
    const summary = input.ledger?.summary ?? current.summary;
    const description = input.ledger?.description ?? current.description;
    await this.insertRevision(projectId, requirementId, {
      revision,
      title: current.title,
      description,
      summary,
      status: current.status as RequirementStatus,
      source: sourceOf(current.source_kind, current.source_reference),
      note: note.slice(0, 2000),
      createdAt: timestamp
    });
    const changed = await this.transaction.execute(
      `UPDATE project_data_requirements
          SET revision = ?, summary = ?, description = ?, updated_at = ?
        WHERE project_id = ? AND requirement_id = ? AND revision = ?`,
      [revision, summary, description, timestamp, projectId, requirementId, Number(current.revision)]
    );
    if (changed !== 1)
      throw new ProjectDataConflictError("需求已被另一写入更新，请重新读取", undefined, "revision_conflict");
    if (input.ledger)
      await this.insertHistory(projectId, requirementId, input.ledger.history, developmentId, timestamp);
    await this.insertReferences(projectId, requirementId, [{ kind: "delivery", value: mergedCommit }]);
    return this.requirement(projectId, requirementId);
  }
}
