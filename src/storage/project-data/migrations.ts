import { id, now } from "../../domain/types.js";
import { describeFeature, ProjectDataError } from "../../domain/project-ledger.js";
import type { SqlDatabase, SqlTransaction } from "./database.js";

/**
 * The project data schema this build writes.
 *
 * A new database is created at this version. A database at an earlier
 * version this build knows (8 to 12) is converted in the same transaction that
 * records the new version; any other version is refused with its location and
 * version, without being rewritten. Date/time values are ISO text and booleans
 * are integers so one business query serves both engines.
 */
export const PROJECT_DATA_SCHEMA_VERSION = 13;

/** The title of the requirement every project keeps for changes no feature owns. */
export const MISC_REQUIREMENT_TITLE = "杂项";
export const MISC_REQUIREMENT_DESCRIPTION =
  "与任何功能都无关的零碎改动，比如改错别字、调一个配置、改版本号。";

const PROJECT_DATA_SCHEMA: readonly string[] = [
  // `ledger_tidied_at` is where the last finished tidy read up to; what was
  // recorded after it counts toward the next one.
  `CREATE TABLE IF NOT EXISTS project_data_projects (
     project_id TEXT PRIMARY KEY,
     project_name TEXT NOT NULL,
     ledger_tidied_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS project_data_bindings (
     backend_id TEXT NOT NULL,
     project_id TEXT NOT NULL REFERENCES project_data_projects(project_id) ON DELETE CASCADE,
     local_directory TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (backend_id, project_id),
     UNIQUE (backend_id, local_directory)
   )`,
  // A requirement is a long-lived feature: its summary says how it behaves now,
  // its history lists what each development changed, and its aliases are the
  // other names users give it. Each project keeps one `misc` requirement for
  // changes no feature owns.
  `CREATE TABLE IF NOT EXISTS project_data_requirements (
     project_id TEXT NOT NULL REFERENCES project_data_projects(project_id) ON DELETE CASCADE,
     requirement_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     title TEXT NOT NULL,
     description TEXT NOT NULL,
     summary TEXT NOT NULL,
     source_kind TEXT NOT NULL,
     source_reference TEXT,
     status TEXT NOT NULL,
     revision INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, requirement_id)
   )`,
  `CREATE TABLE IF NOT EXISTS project_data_requirement_revisions (
     project_id TEXT NOT NULL,
     requirement_id TEXT NOT NULL,
     revision INTEGER NOT NULL,
     title TEXT NOT NULL,
     description TEXT NOT NULL,
     summary TEXT NOT NULL,
     status TEXT NOT NULL,
     source_kind TEXT NOT NULL,
     source_reference TEXT,
     note TEXT,
     task_id TEXT,
     created_at TEXT NOT NULL,
     PRIMARY KEY (project_id, requirement_id, revision),
     FOREIGN KEY (project_id, requirement_id)
       REFERENCES project_data_requirements(project_id, requirement_id) ON DELETE CASCADE
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS project_data_requirements_misc
     ON project_data_requirements(project_id) WHERE kind = 'misc'`,
  `CREATE TABLE IF NOT EXISTS project_data_requirement_history (
     project_id TEXT NOT NULL,
     requirement_id TEXT NOT NULL,
     entry_id TEXT NOT NULL,
     day TEXT NOT NULL,
     text TEXT NOT NULL,
     development_id TEXT,
     created_at TEXT NOT NULL,
     PRIMARY KEY (project_id, requirement_id, entry_id),
     FOREIGN KEY (project_id, requirement_id)
       REFERENCES project_data_requirements(project_id, requirement_id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS project_data_requirement_aliases (
     project_id TEXT NOT NULL,
     requirement_id TEXT NOT NULL,
     alias TEXT NOT NULL,
     development_id TEXT,
     created_at TEXT NOT NULL,
     PRIMARY KEY (project_id, requirement_id, alias),
     FOREIGN KEY (project_id, requirement_id)
       REFERENCES project_data_requirements(project_id, requirement_id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS project_data_references (
     project_id TEXT NOT NULL,
     requirement_id TEXT NOT NULL,
     reference_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     value TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (project_id, requirement_id, reference_id),
     FOREIGN KEY (project_id, requirement_id)
       REFERENCES project_data_requirements(project_id, requirement_id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS project_data_requirements_project
     ON project_data_requirements(project_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS project_data_revisions_project
     ON project_data_requirement_revisions(project_id, requirement_id)`,
  // The shared demand board. A card is one piece of work on a requirement, with
  // its own title and text; a requirement has at most one card still open
  // (neither cancelled nor delivered) at a time. The event rows
  // keep every accepted transition, and a request id makes a retry return the
  // committed result without appending a second event. The delivery columns keep
  // the actual merged commit beside the pending-release state, so an external
  // demand never appears released before its release phase.
  `CREATE TABLE IF NOT EXISTS project_data_board_entries (
     project_id TEXT NOT NULL,
     board_id TEXT NOT NULL,
     requirement_id TEXT NOT NULL,
     title TEXT NOT NULL,
     content TEXT NOT NULL,
     source_kind TEXT NOT NULL,
     source_reference TEXT,
     entry_kind TEXT NOT NULL,
     state TEXT NOT NULL,
     revision INTEGER NOT NULL,
     backend_id TEXT NOT NULL,
     publish_request_id TEXT NOT NULL,
     assignment_kind TEXT,
     assignee_id TEXT,
     handler_backend_id TEXT,
     handler_project_id TEXT,
     handler_task_id TEXT,
     assigned_at TEXT,
     delivery_merge_id TEXT,
     delivery_commit TEXT,
     delivery_merged_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, board_id),
     UNIQUE (project_id, publish_request_id),
     FOREIGN KEY (project_id, requirement_id)
       REFERENCES project_data_requirements(project_id, requirement_id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS project_data_board_events (
     project_id TEXT NOT NULL,
     board_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     request_id TEXT NOT NULL,
     actor_id TEXT NOT NULL,
     handler_backend_id TEXT,
     handler_project_id TEXT,
     handler_task_id TEXT,
     from_state TEXT,
     to_state TEXT NOT NULL,
     revision INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (project_id, board_id, event_id),
     UNIQUE (project_id, request_id),
     FOREIGN KEY (project_id, board_id)
       REFERENCES project_data_board_entries(project_id, board_id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS project_data_board_entries_project
     ON project_data_board_entries(project_id, updated_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS project_data_board_entries_open
     ON project_data_board_entries(project_id, requirement_id)
     WHERE state NOT IN ('cancelled', 'pending_release')`,
  `CREATE INDEX IF NOT EXISTS project_data_board_events_board
     ON project_data_board_events(project_id, board_id, revision)`,
  // A session is shared fact; its Pi transcript stays with the Task on the
  // backend that holds it. `task_id` is that backend's local container.
  `CREATE TABLE IF NOT EXISTS project_data_main_sessions (
     project_id TEXT NOT NULL REFERENCES project_data_projects(project_id) ON DELETE CASCADE,
     session_id TEXT NOT NULL,
     title TEXT NOT NULL,
     entry_kind TEXT NOT NULL,
     kind TEXT NOT NULL,
     backend_id TEXT NOT NULL,
     task_id TEXT NOT NULL,
     current_requirement_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, session_id),
     UNIQUE (backend_id, project_id, task_id)
   )`,
  `CREATE TABLE IF NOT EXISTS project_data_main_session_runs (
     project_id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     run_id TEXT NOT NULL,
     task_id TEXT NOT NULL,
     requirement_id TEXT,
     state TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, session_id, run_id),
     FOREIGN KEY (project_id, session_id)
       REFERENCES project_data_main_sessions(project_id, session_id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS project_data_main_sessions_project
     ON project_data_main_sessions(project_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS project_data_main_session_runs_task
     ON project_data_main_session_runs(task_id, run_id)`,
  // One development of a requirement and its per-backend Git checkout. A
  // requirement has many developments over time and at most one active. The
  // merge configuration is the project's single update entry; the checkout
  // directory stays a per-backend fact like a directory binding.
  `CREATE TABLE IF NOT EXISTS project_data_developments (
     project_id TEXT NOT NULL,
     development_id TEXT NOT NULL,
     requirement_id TEXT NOT NULL,
     goal TEXT NOT NULL,
     completion_criteria TEXT NOT NULL,
     route TEXT NOT NULL,
     status TEXT NOT NULL,
     revision INTEGER NOT NULL,
     baseline_branch TEXT NOT NULL,
     baseline_commit TEXT NOT NULL,
     session_id TEXT,
     task_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, development_id),
     FOREIGN KEY (project_id, requirement_id)
       REFERENCES project_data_requirements(project_id, requirement_id) ON DELETE CASCADE
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS project_data_developments_active
     ON project_data_developments(project_id, requirement_id) WHERE status = 'active'`,
  `CREATE TABLE IF NOT EXISTS project_data_development_workspaces (
     project_id TEXT NOT NULL,
     development_id TEXT NOT NULL,
     backend_id TEXT NOT NULL,
     workspace_id TEXT NOT NULL,
     directory TEXT NOT NULL,
     branch TEXT NOT NULL,
     base_commit TEXT NOT NULL,
     state TEXT NOT NULL,
     error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, development_id, backend_id),
     FOREIGN KEY (project_id, development_id)
       REFERENCES project_data_developments(project_id, development_id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS project_data_merge_configs (
     project_id TEXT PRIMARY KEY REFERENCES project_data_projects(project_id) ON DELETE CASCADE,
     repository TEXT NOT NULL,
     target_branch TEXT NOT NULL,
     execution_backend_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS project_data_developments_project
     ON project_data_developments(project_id, updated_at)`,
  // The review record a requirement's delivery is qualified against. A plan is
  // Main's channel decision; a review freezes one candidate and keeps the
  // independent Reviewer's findings, Main's rulings and the rework that
  // continued the author's original session. Findings and reworks are a bounded
  // JSON array on the review row so one version and one revision cover the whole
  // record atomically.
  `CREATE TABLE IF NOT EXISTS project_data_development_review_plans (
     project_id TEXT NOT NULL,
     development_id TEXT NOT NULL,
     channel TEXT NOT NULL,
     basis TEXT NOT NULL,
     checks TEXT NOT NULL,
     candidate_commit TEXT NOT NULL,
     candidate_tree TEXT NOT NULL,
     candidate_branch TEXT NOT NULL,
     candidate_workspace TEXT NOT NULL,
     revision INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, development_id),
     FOREIGN KEY (project_id, development_id)
       REFERENCES project_data_developments(project_id, development_id) ON DELETE CASCADE
   )`,
  // A requirement's tickets as one set: one revision covers a proposal, a
  // confirmation or a ticket revision, and the dependency graph is checked
  // against the whole set it lives in.
  `CREATE TABLE IF NOT EXISTS project_data_development_tickets (
     project_id TEXT NOT NULL,
     development_id TEXT NOT NULL,
     tickets TEXT NOT NULL,
     revision INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, development_id),
     FOREIGN KEY (project_id, development_id)
       REFERENCES project_data_developments(project_id, development_id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS project_data_development_reviews (
     project_id TEXT NOT NULL,
     review_id TEXT NOT NULL,
     development_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     state TEXT NOT NULL,
     revision INTEGER NOT NULL,
     candidate_commit TEXT NOT NULL,
     candidate_tree TEXT NOT NULL,
     candidate_branch TEXT NOT NULL,
     candidate_workspace TEXT NOT NULL,
     author TEXT,
     previous_review_id TEXT,
     previous_candidate_commit TEXT,
     changed_paths TEXT NOT NULL,
     mapping TEXT,
     reviewer TEXT,
     findings TEXT NOT NULL,
     reworks TEXT NOT NULL,
     verdict TEXT,
     drift TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, review_id),
     FOREIGN KEY (project_id, development_id)
       REFERENCES project_data_developments(project_id, development_id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS project_data_development_reviews_project
     ON project_data_development_reviews(project_id, development_id, created_at)`,
  // One project's applications to its shared target branch. The row keeps the
  // candidate, the combined base, the checks that ran on it and the commit
  // actually written, so an interrupted process reconciles against Git instead
  // of merging twice. The partial unique index is the cross-backend promise that
  // only one operation updates this project's target at a time.
  `CREATE TABLE IF NOT EXISTS project_data_development_merges (
     project_id TEXT NOT NULL,
     merge_id TEXT NOT NULL,
     development_id TEXT NOT NULL,
     requirement_id TEXT NOT NULL,
     state TEXT NOT NULL,
     revision INTEGER NOT NULL,
     requested_by TEXT NOT NULL,
     execution_backend_id TEXT NOT NULL,
     target_branch TEXT NOT NULL,
     candidate TEXT NOT NULL,
     candidate_commit TEXT NOT NULL,
     acceptance TEXT NOT NULL,
     checks TEXT NOT NULL,
     reasons TEXT NOT NULL,
     combined_base TEXT,
     expected_target TEXT,
     merge_commit TEXT,
     owner_started_at TEXT,
     detail TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, merge_id),
     FOREIGN KEY (project_id, development_id)
       REFERENCES project_data_developments(project_id, development_id) ON DELETE CASCADE
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS project_data_development_merges_applying
     ON project_data_development_merges(project_id) WHERE state = 'applying'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS project_data_development_merges_candidate
     ON project_data_development_merges(project_id, development_id, candidate_commit)
     WHERE state IN ('waiting', 'applying', 'merged')`,
  `CREATE INDEX IF NOT EXISTS project_data_development_merges_project
     ON project_data_development_merges(project_id, development_id, created_at)`,
  // The delivery a merged operation produces. One row per real merge is the
  // idempotent identity for the ledger/board synchronization: `pending` means
  // the target already carries `merged_commit` but the shared records have not
  // accepted it yet, `synced` means both did.
  `CREATE TABLE IF NOT EXISTS project_data_deliveries (
     project_id TEXT NOT NULL,
     delivery_id TEXT NOT NULL,
     development_id TEXT NOT NULL,
     requirement_id TEXT NOT NULL,
     merge_id TEXT NOT NULL,
     candidate_commit TEXT NOT NULL,
     merged_commit TEXT NOT NULL,
     target_branch TEXT NOT NULL,
     merged_at TEXT NOT NULL,
     board_id TEXT,
     state TEXT NOT NULL,
     attempts INTEGER NOT NULL,
     error TEXT,
     synced_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, delivery_id),
     UNIQUE (project_id, merge_id),
     FOREIGN KEY (project_id, development_id)
       REFERENCES project_data_developments(project_id, development_id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS project_data_deliveries_project
     ON project_data_deliveries(project_id, development_id, created_at)`
];

/**
 * Create this build's schema in one transaction, add version 11's final review
 * mapping to a version 10 database, version 10's tidy mark too to a version 9
 * one, drop version 12's tidy read time, convert a version 8 database, or refuse a file recorded at a version this build does not know.
 *
 * The version row is written in the same transaction as the tables, so a
 * database is either empty or complete at the current version. A file at an
 * unknown version is left byte for byte as it was: the transaction rolls back
 * and nothing is migrated, downgraded or rebuilt.
 */
export async function migrateProjectData(database: SqlDatabase): Promise<number> {
  return database.transaction(async (transaction) => {
    await transaction.execute(
      `CREATE TABLE IF NOT EXISTS project_data_migrations (
         version INTEGER PRIMARY KEY,
         applied_at TEXT NOT NULL
       )`
    );
    const rows = await transaction.query<{ version: number }>(
      "SELECT COALESCE(MAX(version), 0) AS version FROM project_data_migrations"
    );
    const version = Number(rows[0]?.version ?? 0);
    if (version === PROJECT_DATA_SCHEMA_VERSION) return version;
    if (![0, 8, 9, 10, 11, 12].includes(version)) throw incompatibleVersion(database.label, version);
    if (version === 9) await upgradeVersion9(transaction);
    if (version === 9 || version === 10) await upgradeVersion10(transaction);
    if (version === 12) await upgradeVersion12(transaction);
    if (version < 9) {
      const previous = version === 8 ? await dropVersion8(transaction) : undefined;
      for (const statement of PROJECT_DATA_SCHEMA) await transaction.execute(statement);
      if (previous) await writeFromVersion8(transaction, previous);
    }
    await transaction.execute("INSERT INTO project_data_migrations (version, applied_at) VALUES (?, ?)", [
      PROJECT_DATA_SCHEMA_VERSION,
      now()
    ]);
    return PROJECT_DATA_SCHEMA_VERSION;
  });
}

/**
 * Version 10 adds the tidy mark, never set on an existing ledger, and each
 * requirement's description, taken from its summary's first sentence.
 */
async function upgradeVersion9(transaction: SqlTransaction): Promise<void> {
  await transaction.execute("ALTER TABLE project_data_projects ADD COLUMN ledger_tidied_at TEXT");
  for (const table of ["project_data_requirements", "project_data_requirement_revisions"]) {
    await transaction.execute(`ALTER TABLE ${table} ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
    const rows = await transaction.query<{
      project_id: string;
      requirement_id: string;
      title: string;
      summary: string;
    }>(`SELECT DISTINCT project_id, requirement_id, title, summary FROM ${table}`);
    for (const row of rows)
      await transaction.execute(
        `UPDATE ${table} SET description = ? WHERE project_id = ? AND requirement_id = ? AND title = ? AND summary = ?`,
        [describeFeature(row.summary, row.title), row.project_id, row.requirement_id, row.title, row.summary]
      );
  }
}

/** Version 11 adds a final review's acceptance mapping; no earlier review has one. */
async function upgradeVersion10(transaction: SqlTransaction): Promise<void> {
  await transaction.execute("ALTER TABLE project_data_development_reviews ADD COLUMN mapping TEXT");
}

/**
 * Version 12 kept one tidy read time per project, which a second read
 * overwrote; version 13 has the tidy hand back the time it read instead.
 * Version 11 has no such column and needs nothing.
 */
async function upgradeVersion12(transaction: SqlTransaction): Promise<void> {
  await transaction.execute("ALTER TABLE project_data_projects DROP COLUMN ledger_tidy_read_at");
}

/** Version 8's tables, parents before children. */
const VERSION_8_TABLES = [
  "project_data_projects",
  "project_data_bindings",
  "project_data_requirements",
  "project_data_requirement_revisions",
  "project_data_decisions",
  "project_data_references",
  "project_data_board_entries",
  "project_data_board_events",
  "project_data_main_sessions",
  "project_data_main_session_runs",
  "project_data_developments",
  "project_data_development_workspaces",
  "project_data_merge_configs",
  "project_data_development_review_plans",
  "project_data_development_tickets",
  "project_data_development_reviews",
  "project_data_development_merges",
  "project_data_deliveries"
] as const;

type Row = Record<string, string | number | null>;
type Version8Rows = Record<(typeof VERSION_8_TABLES)[number], Row[]>;

/**
 * Read every version 8 row and drop the tables, children first so no drop
 * cascades into a table still holding rows. The new schema is then created
 * from scratch, which both engines do inside the open transaction.
 */
async function dropVersion8(transaction: SqlTransaction): Promise<Version8Rows> {
  const rows = {} as Version8Rows;
  for (const table of VERSION_8_TABLES) rows[table] = await transaction.query<Row>(`SELECT * FROM ${table}`);
  for (const table of [...VERSION_8_TABLES].reverse()) await transaction.execute(`DROP TABLE ${table}`);
  return rows;
}

async function insert(transaction: SqlTransaction, table: string, row: Row): Promise<void> {
  const columns = Object.keys(row);
  await transaction.execute(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    columns.map((column) => row[column])
  );
}

const day = (timestamp: unknown) => String(timestamp).slice(0, 10);

/**
 * Write version 8's rows in the version 9 shape. A requirement's content
 * becomes its summary, with its decisions still in force appended; a
 * retracted decision becomes a history line; each delivery reference becomes
 * a history line; open and delivered become active, withdrawn becomes
 * retired. A development with a synced delivery is merged, a board card keeps
 * the title, text and source it was published with, and every project gains its
 * miscellaneous requirement.
 */
async function writeFromVersion8(transaction: SqlTransaction, rows: Version8Rows): Promise<void> {
  const status = (value: unknown) => (value === "withdrawn" ? "retired" : "active");
  const byRequirement = (table: Row[], row: Row) =>
    table.filter((item) => item.project_id === row.project_id && item.requirement_id === row.requirement_id);
  for (const row of rows.project_data_projects) await insert(transaction, "project_data_projects", row);
  for (const row of rows.project_data_bindings) await insert(transaction, "project_data_bindings", row);
  for (const row of rows.project_data_requirements) {
    const decisions = byRequirement(rows.project_data_decisions, row);
    const effective = decisions.filter((decision) => Number(decision.effective) === 1);
    const summary = [String(row.content), ...effective.map((decision) => `- ${String(decision.text)}`)].join(
      "\n"
    );
    const { content: _content, ...rest } = row;
    await insert(transaction, "project_data_requirements", {
      ...rest,
      kind: "feature",
      description: describeFeature(summary, String(row.title)),
      summary,
      status: status(row.status)
    });
    let entry = 0;
    const history = (at: unknown, text: string) =>
      insert(transaction, "project_data_requirement_history", {
        project_id: row.project_id,
        requirement_id: row.requirement_id,
        entry_id: `history_migrated_${++entry}`,
        day: day(at),
        text,
        development_id: null,
        created_at: String(at)
      });
    for (const decision of decisions.filter((item) => Number(item.effective) !== 1))
      await history(decision.created_at, `不再生效的决定：${String(decision.text)}`);
    for (const reference of byRequirement(rows.project_data_references, row).filter(
      (item) => item.kind === "delivery"
    ))
      await history(reference.created_at, `合入 ${String(reference.value).slice(0, 12)}`);
  }
  for (const row of rows.project_data_requirement_revisions) {
    const { content, ...rest } = row;
    await insert(transaction, "project_data_requirement_revisions", {
      ...rest,
      description: describeFeature(String(content), String(row.title)),
      summary: content,
      status: status(row.status)
    });
  }
  for (const row of rows.project_data_references) await insert(transaction, "project_data_references", row);
  for (const row of rows.project_data_board_entries) {
    const requirement = rows.project_data_requirements.find(
      (item) => item.project_id === row.project_id && item.requirement_id === row.requirement_id
    );
    await insert(transaction, "project_data_board_entries", {
      ...row,
      title: requirement?.title ?? "",
      content: requirement?.content ?? "",
      source_kind: requirement?.source_kind ?? "external",
      source_reference: requirement?.source_reference ?? null
    });
  }
  for (const table of [
    "project_data_board_events",
    "project_data_main_sessions",
    "project_data_main_session_runs"
  ] as const)
    for (const row of rows[table]) await insert(transaction, table, row);
  for (const row of rows.project_data_developments) {
    const merged = rows.project_data_deliveries.some(
      (delivery) =>
        delivery.project_id === row.project_id &&
        delivery.development_id === row.development_id &&
        delivery.state === "synced"
    );
    await insert(transaction, "project_data_developments", { ...row, status: merged ? "merged" : "active" });
  }
  for (const table of [
    "project_data_development_workspaces",
    "project_data_merge_configs",
    "project_data_development_review_plans",
    "project_data_development_tickets",
    "project_data_development_reviews",
    "project_data_development_merges",
    "project_data_deliveries"
  ] as const)
    for (const row of rows[table]) await insert(transaction, table, row);
  const timestamp = now();
  for (const project of rows.project_data_projects)
    await insertMiscRequirement(transaction, String(project.project_id), timestamp);
}

/** The project's miscellaneous requirement, at its first revision. */
export async function insertMiscRequirement(
  transaction: SqlTransaction,
  projectId: string,
  timestamp: string
): Promise<string> {
  const requirementId = id("requirement");
  const row = {
    project_id: projectId,
    requirement_id: requirementId,
    title: MISC_REQUIREMENT_TITLE,
    description: MISC_REQUIREMENT_DESCRIPTION,
    summary: "",
    source_kind: "internal",
    source_reference: null,
    status: "active",
    revision: 1,
    created_at: timestamp
  };
  await insert(transaction, "project_data_requirements", {
    ...row,
    kind: "misc",
    updated_at: timestamp
  });
  await insert(transaction, "project_data_requirement_revisions", { ...row, note: null, task_id: null });
  return requirementId;
}

function incompatibleVersion(label: string, version: number): ProjectDataError {
  return new ProjectDataError(
    `项目数据库 ${label} 的 schema 版本为 ${version}，当前只支持 ${PROJECT_DATA_SCHEMA_VERSION}；未改写该文件，请从备份恢复或使用对应版本打开`,
    500,
    "storage_schema_version"
  );
}
