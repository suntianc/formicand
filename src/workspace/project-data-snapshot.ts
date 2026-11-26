import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ProjectDataInvalidError } from "../domain/project-ledger.js";
import { now } from "../domain/types.js";
import { type ProjectDataEngine } from "../storage/project-data/config.js";
import type { SqlDatabase } from "../storage/project-data/database.js";

import type { ProjectDataDescription } from "./project-data-gateway.js";
const SNAPSHOT_VERSION = 9;
const TABLES = [
  "project_data_projects",
  "project_data_bindings",
  "project_data_requirements",
  "project_data_requirement_revisions",
  "project_data_requirement_history",
  "project_data_requirement_aliases",
  "project_data_references",
  "project_data_board_entries",
  "project_data_board_events",
  "project_data_main_sessions",
  "project_data_main_session_runs",
  "project_data_developments",
  "project_data_development_workspaces",
  "project_data_development_tickets",
  "project_data_development_review_plans",
  "project_data_development_reviews",
  "project_data_development_merges",
  "project_data_deliveries",
  "project_data_merge_configs"
] as const;
export type SnapshotTable = (typeof TABLES)[number];

/** Restore accepts only these columns, so a snapshot cannot shape the INSERT. */
const TABLE_COLUMNS: Record<SnapshotTable, readonly string[]> = {
  project_data_projects: [
    "project_id",
    "project_name",
    "ledger_tidied_at",
    "ledger_clock",
    "created_at",
    "updated_at"
  ],
  project_data_bindings: ["backend_id", "project_id", "local_directory", "created_at", "updated_at"],
  project_data_requirements: [
    "project_id",
    "requirement_id",
    "kind",
    "title",
    "description",
    "summary",
    "source_kind",
    "source_reference",
    "status",
    "revision",
    "created_at",
    "updated_at"
  ],
  project_data_requirement_revisions: [
    "project_id",
    "requirement_id",
    "revision",
    "title",
    "description",
    "summary",
    "status",
    "source_kind",
    "source_reference",
    "note",
    "task_id",
    "created_at"
  ],
  project_data_requirement_history: [
    "project_id",
    "requirement_id",
    "entry_id",
    "day",
    "text",
    "development_id",
    "created_at"
  ],
  project_data_requirement_aliases: ["project_id", "requirement_id", "alias", "development_id", "created_at"],
  project_data_references: ["project_id", "requirement_id", "reference_id", "kind", "value", "created_at"],
  project_data_board_entries: [
    "project_id",
    "board_id",
    "requirement_id",
    "title",
    "content",
    "source_kind",
    "source_reference",
    "entry_kind",
    "state",
    "revision",
    "backend_id",
    "publish_request_id",
    "assignment_kind",
    "assignee_id",
    "handler_backend_id",
    "handler_project_id",
    "handler_task_id",
    "assigned_at",
    "delivery_merge_id",
    "delivery_commit",
    "delivery_merged_at",
    "created_at",
    "updated_at"
  ],
  project_data_board_events: [
    "project_id",
    "board_id",
    "event_id",
    "kind",
    "request_id",
    "actor_id",
    "handler_backend_id",
    "handler_project_id",
    "handler_task_id",
    "from_state",
    "to_state",
    "revision",
    "created_at"
  ],
  project_data_main_sessions: [
    "project_id",
    "session_id",
    "title",
    "entry_kind",
    "kind",
    "backend_id",
    "task_id",
    "current_requirement_id",
    "created_at",
    "updated_at"
  ],
  project_data_main_session_runs: [
    "project_id",
    "session_id",
    "run_id",
    "task_id",
    "requirement_id",
    "state",
    "created_at",
    "updated_at"
  ],
  project_data_developments: [
    "project_id",
    "development_id",
    "requirement_id",
    "goal",
    "completion_criteria",
    "route",
    "status",
    "status_reason",
    "continues_development_id",
    "revision",
    "baseline_branch",
    "baseline_commit",
    "session_id",
    "task_id",
    "created_at",
    "updated_at"
  ],
  project_data_development_workspaces: [
    "project_id",
    "development_id",
    "backend_id",
    "workspace_id",
    "directory",
    "branch",
    "base_commit",
    "state",
    "error",
    "created_at",
    "updated_at"
  ],
  project_data_merge_configs: [
    "project_id",
    "repository",
    "target_branch",
    "execution_backend_id",
    "created_at",
    "updated_at"
  ],
  project_data_development_tickets: [
    "project_id",
    "development_id",
    "tickets",
    "revision",
    "created_at",
    "updated_at"
  ],
  project_data_development_review_plans: [
    "project_id",
    "development_id",
    "channel",
    "basis",
    "checks",
    "candidate_commit",
    "candidate_tree",
    "candidate_branch",
    "candidate_workspace",
    "revision",
    "created_at",
    "updated_at"
  ],
  project_data_development_reviews: [
    "project_id",
    "review_id",
    "development_id",
    "kind",
    "state",
    "revision",
    "candidate_commit",
    "candidate_tree",
    "candidate_branch",
    "candidate_workspace",
    "author",
    "previous_review_id",
    "previous_candidate_commit",
    "changed_paths",
    "mapping",
    "reviewer",
    "findings",
    "reworks",
    "verdict",
    "drift",
    "created_at",
    "updated_at"
  ],
  project_data_development_merges: [
    "project_id",
    "merge_id",
    "development_id",
    "requirement_id",
    "state",
    "revision",
    "requested_by",
    "execution_backend_id",
    "target_branch",
    "candidate",
    "candidate_commit",
    "acceptance",
    "checks",
    "reasons",
    "combined_base",
    "expected_target",
    "merge_commit",
    "owner_started_at",
    "detail",
    "created_at",
    "updated_at"
  ],
  project_data_deliveries: [
    "project_id",
    "delivery_id",
    "development_id",
    "requirement_id",
    "merge_id",
    "candidate_commit",
    "merged_commit",
    "target_branch",
    "merged_at",
    "board_id",
    "state",
    "attempts",
    "error",
    "synced_at",
    "created_at",
    "updated_at"
  ]
};

interface ProjectDataSnapshot {
  version: number;
  engine: ProjectDataEngine;
  takenAt: string;
  schemaVersion: number;
  tables: Record<SnapshotTable, Array<Record<string, unknown>>>;
}

/** A consistent logical snapshot of every ledger table, portable across restarts. */
export async function backupProjectData(
  database: SqlDatabase,
  description: ProjectDataDescription,
  path: string
): Promise<{
  path: string;
  engine: ProjectDataEngine;
  takenAt: string;
  schemaVersion: number;
  counts: Record<SnapshotTable, number>;
}> {
  const takenAt = now();
  const tables = await database.transaction(async (transaction) => {
    const result = {} as Record<SnapshotTable, Array<Record<string, unknown>>>;
    for (const table of TABLES)
      result[table] = await transaction.query<Record<string, unknown>>(`SELECT * FROM ${table}`);
    return result;
  });
  const snapshot: ProjectDataSnapshot = {
    version: SNAPSHOT_VERSION,
    engine: description.engine,
    takenAt,
    schemaVersion: description.schemaVersion,
    tables
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return {
    path,
    engine: snapshot.engine,
    takenAt,
    schemaVersion: snapshot.schemaVersion,
    counts: Object.fromEntries(TABLES.map((table) => [table, tables[table].length])) as Record<
      SnapshotTable,
      number
    >
  };
}

/** Replace the ledger tables from a snapshot; a damaged file changes nothing. */
export async function restoreProjectData(
  database: SqlDatabase,
  description: ProjectDataDescription,
  path: string
): Promise<{ takenAt: string; counts: Record<SnapshotTable, number> }> {
  const snapshot = parseSnapshot(await readFile(path, "utf8"));
  if (snapshot.engine !== description.engine)
    throw new ProjectDataInvalidError(
      `备份来自 ${snapshot.engine}，当前数据库是 ${description.engine}；请用同一模式的数据库恢复`
    );
  if (snapshot.schemaVersion !== description.schemaVersion)
    throw new ProjectDataInvalidError(
      `备份 schema 版本为 ${snapshot.schemaVersion}，当前为 ${description.schemaVersion}；请用对应版本恢复`
    );
  await database.transaction(async (transaction) => {
    for (const table of [...TABLES].reverse()) await transaction.execute(`DELETE FROM ${table}`);
    for (const table of TABLES) {
      for (const row of snapshot.tables[table]) {
        const columns = Object.keys(row);
        await transaction.execute(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          columns.map((column) => row[column] as string | number | null)
        );
      }
    }
  });
  return {
    takenAt: snapshot.takenAt,
    counts: Object.fromEntries(TABLES.map((table) => [table, snapshot.tables[table].length])) as Record<
      SnapshotTable,
      number
    >
  };
}

function parseSnapshot(raw: string): ProjectDataSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProjectDataInvalidError("备份文件不是有效 JSON");
  }
  const snapshot = value as Partial<ProjectDataSnapshot> | null;
  if (snapshot && typeof snapshot === "object" && snapshot.version === 1)
    throw new ProjectDataInvalidError("备份文件是旧版本（1），不含看板数据；请用对应版本恢复或重新备份");
  if (snapshot && typeof snapshot === "object" && snapshot.version === 2)
    throw new ProjectDataInvalidError(
      "备份文件是旧版本（2），不含需求开发记录；请重新备份或使用对应版本恢复"
    );
  if (snapshot && typeof snapshot === "object" && snapshot.version === 3)
    throw new ProjectDataInvalidError(
      "备份文件是旧版本（3），不含候选审查记录；请重新备份或使用对应版本恢复"
    );
  if (snapshot && typeof snapshot === "object" && snapshot.version === 4)
    throw new ProjectDataInvalidError(
      "备份文件是旧版本（4），不含项目合入操作；请重新备份或使用对应版本恢复"
    );
  if (snapshot && typeof snapshot === "object" && snapshot.version === 5)
    throw new ProjectDataInvalidError(
      "备份文件是旧版本（5），不含需求交付记录；请重新备份或使用对应版本恢复"
    );
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    snapshot.version !== SNAPSHOT_VERSION ||
    (snapshot.engine !== "sqlite" && snapshot.engine !== "postgres") ||
    typeof snapshot.takenAt !== "string" ||
    typeof snapshot.schemaVersion !== "number" ||
    !snapshot.tables ||
    typeof snapshot.tables !== "object" ||
    TABLES.some((table) => !Array.isArray(snapshot.tables?.[table]))
  )
    throw new ProjectDataInvalidError("备份文件格式不完整，未恢复任何数据");
  for (const table of TABLES) {
    const columns = TABLE_COLUMNS[table];
    for (const row of snapshot.tables[table]) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 记录来自备份 JSON，元素可能是 null、数组或标量，读字段前必须按损坏记录拒绝
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new ProjectDataInvalidError(`备份文件中的 ${table} 记录损坏，未恢复任何数据`);
      for (const [column, value] of Object.entries(row)) {
        if (!columns.includes(column))
          throw new ProjectDataInvalidError(`备份文件中的 ${table}.${column} 不是已知字段，未恢复任何数据`);
        if (value !== null && typeof value !== "string" && typeof value !== "number")
          throw new ProjectDataInvalidError(`备份文件中的 ${table}.${column} 值无效，未恢复任何数据`);
      }
    }
  }
  return snapshot as ProjectDataSnapshot;
}
