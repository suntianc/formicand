import { documentsNext, tidyDocumentsInput } from "../domain/project-documents.js";
import {
  ledgerIdentifier,
  ledgerProjectId,
  ledgerRequestText,
  ledgerRevision,
  ledgerSummary,
  ledgerTaskId,
  ProjectDataConflictError,
  ProjectDataInvalidError,
  ProjectDataNotFoundError,
  type RequirementAlias,
  type RequirementDetail,
  type RequirementKind,
  type RequirementRevision,
  type RequirementStatus
} from "../domain/project-ledger.js";
import { now } from "../domain/types.js";
import type { SqlTransaction } from "../storage/project-data/database.js";
import {
  catalogOf,
  lookupRequirements,
  type LookupEntry,
  type LookupResult
} from "../domain/ledger-lookup.js";

import type { LedgerTidy, LedgerTidyFinished, RequirementMerge } from "./project-data-gateway.js";
import {
  sourceOf,
  type HistoryRow,
  type RequirementRow,
  type ProjectRow
} from "./project-ledger-repository.js";

interface LedgerMaintenanceLedger {
  requireProject(projectId: string): Promise<ProjectRow>;
  requireRequirement(projectId: string, requirementId: string): Promise<RequirementRow>;
  aliases(projectId: string, requirementIds: string[]): Promise<Map<string, RequirementAlias[]>>;
  insertAlias(
    projectId: string,
    requirementId: string,
    alias: string,
    developmentId: string | undefined,
    timestamp: string
  ): Promise<void>;
  insertHistory(
    projectId: string,
    requirementId: string,
    text: string,
    developmentId: string | undefined,
    timestamp: string
  ): Promise<void>;
  insertRevision(projectId: string, requirementId: string, revision: RequirementRevision): Promise<void>;
  requirement(projectId: string, requirementId: string): Promise<RequirementDetail>;
  nextLedgerTime(projectId: string): Promise<{ timestamp: string; tidiedAt: string | null }>;
}

// A v13 wall-clock reading cannot identify which side of a same-millisecond delivery it observed.
const tidySnapshotPrefix = (projectId: string) => `tidy/1/${projectId}/`;

export class LedgerMaintenanceRepository {
  constructor(
    private readonly transaction: SqlTransaction,
    private readonly ledger: LedgerMaintenanceLedger
  ) {}

  async lookup(projectIdValue: unknown, requestValue: unknown): Promise<LookupResult> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.ledger.requireProject(projectId);
    return lookupRequirements(await this.lookupEntries(projectId), ledgerRequestText(requestValue));
  }

  async mergedSinceTidy(projectIdValue: unknown): Promise<number> {
    const rows = await this.transaction.query<{ merged: number | string }>(
      `SELECT COUNT(d.delivery_id) AS merged FROM project_data_projects p
         LEFT JOIN project_data_deliveries d ON d.project_id = p.project_id AND d.created_at > COALESCE(p.ledger_tidied_at, '')
         WHERE p.project_id = ? GROUP BY p.project_id`,
      [ledgerProjectId(projectIdValue)]
    );
    if (!rows.length) throw new ProjectDataNotFoundError("找不到该项目的共享记录");
    return Number(rows[0].merged);
  }

  /**
   * Developments recorded since the last tidy, and the whole catalog for Main
   * to compare. A read reserves its ordered time but never moves the completed
   * tidy mark. Deliveries count by when they were recorded,
   * so one replayed late is still after the mark.
   */
  async tidy(projectIdValue: unknown): Promise<LedgerTidy> {
    const projectId = ledgerProjectId(projectIdValue);
    const { tidiedAt, timestamp } = await this.ledger.nextLedgerTime(projectId);
    const from = tidiedAt ?? "";
    const merged = await this.mergedSinceTidy(projectId);
    const changes = await this.transaction.query<{ requirement_id: string; title: string; text: string }>(
      `SELECT h.requirement_id, r.title, h.text FROM project_data_requirement_history h
        JOIN project_data_requirements r ON r.project_id = h.project_id AND r.requirement_id = h.requirement_id
        WHERE h.project_id = ? AND h.development_id IS NOT NULL AND h.created_at > ? AND h.created_at <= ?
        ORDER BY h.created_at ASC, h.entry_id ASC`,
      [projectId, from, timestamp]
    );
    return {
      merged,
      ...(tidiedAt ? { tidiedAt } : {}),
      readAt: tidySnapshotPrefix(projectId) + timestamp,
      catalog: catalogOf(await this.lookupEntries(projectId)),
      changes: changes.map((row) => ({
        requirementId: row.requirement_id,
        title: row.title,
        history: row.text
      }))
    };
  }

  /**
   * Mark the tidy done up to where it read: Main hands back the `readAt` its
   * tidy returned, and what was recorded after it counts toward the next one.
   * A read older than the mark was already covered by a later tidy. Main hands
   * in its verdict on the documents; an update list becomes the next
   * development, on the misc requirement.
   */
  async finishTidy(
    projectIdValue: unknown,
    documentsValue: unknown,
    readAtValue: unknown
  ): Promise<LedgerTidyFinished> {
    const projectId = ledgerProjectId(projectIdValue);
    const project = await this.ledger.requireProject(projectId);
    const documents = tidyDocumentsInput(documentsValue);
    if (!documents)
      throw new ProjectDataConflictError(
        "完成台账维护时交上文档的结论：documents.update 列出跟不上代码的文档和原因，或 documents.unchanged 写明为什么都不用改",
        undefined,
        "documents_verdict_missing"
      );
    const prefix = tidySnapshotPrefix(projectId);
    const tidiedAt =
      typeof readAtValue === "string" && readAtValue.startsWith(prefix)
        ? readAtValue.slice(prefix.length)
        : "";
    if (new Date(tidiedAt).toJSON() !== tidiedAt || !project.ledger_clock || tidiedAt > project.ledger_clock)
      throw new ProjectDataInvalidError("readAt 须为这次 tidy 返回的 readAt；先用 tidy 读取台账");
    const changed = await this.transaction.execute(
      `UPDATE project_data_projects SET ledger_tidied_at = ?, updated_at = ? WHERE project_id = ?
         AND (ledger_tidied_at IS NULL OR ledger_tidied_at < ?)`,
      [tidiedAt, now(), projectId, tidiedAt]
    );
    if (!changed)
      throw new ProjectDataConflictError(
        "这次读取之后已有一次维护完成并覆盖了它；重新 tidy 再完成",
        undefined,
        "tidy_stale"
      );
    if (!("update" in documents)) return { tidiedAt, documents };
    const misc = await this.transaction.query<{ requirement_id: string }>(
      "SELECT requirement_id FROM project_data_requirements WHERE project_id = ? AND kind = 'misc'",
      [projectId]
    );
    return { tidiedAt, documents, next: documentsNext(documents.update, misc[0]?.requirement_id) };
  }

  /**
   * Fold `from` into `into`: its developments, board cards, merges,
   * deliveries, history, references and aliases move over, its title becomes
   * an alias, and `into` takes the summary Main wrote for both. Then `from` is
   * deleted; no record of work is lost, only the duplicate requirement.
   */
  async mergeRequirements(projectIdValue: unknown, input: RequirementMerge): Promise<RequirementDetail> {
    const projectId = ledgerProjectId(projectIdValue);
    const fromId = ledgerIdentifier(input.from, "被合并的需求 ID");
    const intoId = ledgerIdentifier(input.into, "保留的需求 ID");
    if (fromId === intoId) throw new ProjectDataInvalidError("不能把需求合并到它自己");
    const expectedRevision = ledgerRevision(input.expectedRevision);
    if (input.fromRevision === undefined)
      throw new ProjectDataInvalidError("合并须带 fromRevision：被合并的需求最后读到的修订号");
    const fromRevision = ledgerRevision(input.fromRevision);
    if (input.summary === undefined) throw new ProjectDataInvalidError("合并须写明合并后的现状");
    const summary = ledgerSummary(input.summary);
    const taskId = ledgerTaskId(input.taskId);
    const from = await this.ledger.requireRequirement(projectId, fromId);
    const into = await this.ledger.requireRequirement(projectId, intoId);
    if (from.kind === "misc")
      throw new ProjectDataConflictError("杂项需求不能被合并掉", undefined, "requirement_misc_fixed");
    if (Number(into.revision) !== expectedRevision)
      throw new ProjectDataConflictError(
        "需求已更新，请基于最新修订重试",
        Number(into.revision),
        "revision_conflict"
      );
    if (Number(from.revision) !== fromRevision)
      throw new ProjectDataConflictError(
        "被合并的需求已更新，请重新读取两条需求后重试",
        Number(from.revision),
        "revision_conflict"
      );
    // Each requirement keeps at most one active development and one open card.
    const busy = async (table: string, open: string) => {
      const rows = await this.transaction.query<{ requirement_id: string }>(
        `SELECT DISTINCT requirement_id FROM ${table} WHERE project_id = ? AND requirement_id IN (?, ?) AND ${open}`,
        [projectId, fromId, intoId]
      );
      return rows.length === 2;
    };
    if (await busy("project_data_developments", "status = 'active'"))
      throw new ProjectDataConflictError(
        "两条需求都有进行中的开发，等其中一条合入或撤回后再合并",
        undefined,
        "requirement_merge_busy"
      );
    if (await busy("project_data_board_entries", "state NOT IN ('cancelled', 'pending_release')"))
      throw new ProjectDataConflictError(
        "两条需求都有未完成的看板卡，等其中一张完成后再合并",
        undefined,
        "requirement_merge_busy"
      );
    const timestamp = now();
    for (const table of [
      "project_data_developments",
      "project_data_board_entries",
      "project_data_development_merges",
      "project_data_deliveries",
      "project_data_requirement_history",
      "project_data_references",
      "project_data_main_session_runs"
    ])
      await this.transaction.execute(
        `UPDATE ${table} SET requirement_id = ? WHERE project_id = ? AND requirement_id = ?`,
        [intoId, projectId, fromId]
      );
    await this.transaction.execute(
      "UPDATE project_data_main_sessions SET current_requirement_id = ? WHERE project_id = ? AND current_requirement_id = ?",
      [intoId, projectId, fromId]
    );
    const aliases = await this.ledger.aliases(projectId, [fromId, intoId]);
    const known = new Set(
      [into.title, ...(aliases.get(intoId) ?? []).map((alias) => alias.alias)].map((text) =>
        text.toLowerCase()
      )
    );
    const moved: RequirementAlias[] = [
      { alias: from.title, createdAt: timestamp },
      ...(aliases.get(fromId) ?? [])
    ];
    await this.transaction.execute(
      "DELETE FROM project_data_requirement_aliases WHERE project_id = ? AND requirement_id = ?",
      [projectId, fromId]
    );
    for (const alias of moved) {
      if (known.has(alias.alias.toLowerCase())) continue;
      known.add(alias.alias.toLowerCase());
      await this.ledger.insertAlias(projectId, intoId, alias.alias, alias.developmentId, alias.createdAt);
    }
    await this.ledger.insertHistory(
      projectId,
      intoId,
      `合并了重复的需求「${from.title}」`,
      undefined,
      timestamp
    );
    const revision = expectedRevision + 1;
    await this.ledger.insertRevision(projectId, intoId, {
      revision,
      title: into.title,
      description: into.description,
      summary,
      status: into.status as RequirementStatus,
      source: sourceOf(into.source_kind, into.source_reference),
      note: `并入 ${fromId}`,
      taskId,
      createdAt: timestamp
    });
    await this.transaction.execute(
      `UPDATE project_data_requirements SET summary = ?, revision = ?, updated_at = ?
        WHERE project_id = ? AND requirement_id = ?`,
      [summary, revision, timestamp, projectId, intoId]
    );
    // Only its own revisions are left; they go with it.
    for (const table of ["project_data_requirement_revisions", "project_data_requirements"])
      await this.transaction.execute(`DELETE FROM ${table} WHERE project_id = ? AND requirement_id = ?`, [
        projectId,
        fromId
      ]);
    return this.ledger.requirement(projectId, intoId);
  }

  /** Every requirement with the text lookup scores, oldest first. */
  async lookupEntries(projectId: string): Promise<LookupEntry[]> {
    const rows = await this.transaction.query<RequirementRow>(
      "SELECT * FROM project_data_requirements WHERE project_id = ? ORDER BY created_at ASC, requirement_id ASC",
      [projectId]
    );
    const aliases = await this.ledger.aliases(
      projectId,
      rows.map((row) => row.requirement_id)
    );
    const history = new Map<string, string[]>();
    for (const row of await this.transaction.query<HistoryRow & { requirement_id: string }>(
      "SELECT * FROM project_data_requirement_history WHERE project_id = ? ORDER BY day ASC, created_at ASC, entry_id ASC",
      [projectId]
    ))
      history.set(row.requirement_id, [...(history.get(row.requirement_id) ?? []), row.text]);
    return rows.map((row) => ({
      requirementId: row.requirement_id,
      kind: row.kind as RequirementKind,
      status: row.status as RequirementStatus,
      title: row.title,
      description: row.description,
      aliases: (aliases.get(row.requirement_id) ?? []).map((alias) => alias.alias),
      summary: row.summary,
      history: history.get(row.requirement_id) ?? []
    }));
  }
}
