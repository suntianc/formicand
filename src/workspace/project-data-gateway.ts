import { type TidyDocuments } from "../domain/project-documents.js";
import {
  type ProjectIdentity,
  type RequirementDetail,
  type RequirementSummary,
  type SharedProject
} from "../domain/project-ledger.js";
import { type DevelopmentReview, type ReviewPlan } from "../domain/development-review.js";
import { type DevelopmentMerge, type MergeCreate } from "../domain/development-merge.js";
import { type TicketSet, type TicketWrite } from "../domain/development-ticket.js";
import { type DevelopmentDelivery } from "../domain/development-delivery.js";
import { type DevelopmentRecord, type MergeConfig } from "../domain/project-development.js";
import {
  type BoardAction,
  type BoardActionContext,
  type BoardActionInput,
  type BoardEntry,
  type BoardEvent,
  type BoardPublishInput
} from "../domain/project-board.js";
import { type ProjectDataEngine } from "../storage/project-data/config.js";
import { lookupRequirements, type CatalogEntry, type LookupResult } from "../domain/ledger-lookup.js";
import { ProjectMainSessionRepository, type MainSessionRecord } from "./project-main-session.js";
import type { MainSessionRun } from "../domain/main-session.js";

import type { ProjectDataRepository } from "./project-data-repository.js";
export interface RequirementQuery {
  text?: unknown;
  status?: unknown;
  limit?: unknown;
  /** How many of the ordered requirements to skip, for reading a long ledger page by page. */
  offset?: unknown;
}

export interface RequirementCreate {
  title?: unknown;
  /** What the feature is; taken from the summary's first sentence when absent. */
  description?: unknown;
  summary?: unknown;
  aliases?: unknown;
  source?: unknown;
  references?: unknown;
}

/** Fold one requirement into another; the folded one is deleted once everything moved. */
export interface RequirementMerge {
  /** The requirement folded away. */
  from?: unknown;
  /** The requirement that stays. */
  into?: unknown;
  /** The revision of `into` last read. */
  expectedRevision?: unknown;
  /** The revision of `from` last read: a merge built on either side's old text is refused. */
  fromRevision?: unknown;
  /** The kept requirement's summary after the merge, with both requirements' rules. */
  summary?: unknown;
  taskId?: unknown;
}

/** What a ledger tidy reads: how many developments merged since the last one, and the whole catalog. */
export interface LedgerTidy {
  merged: number;
  tidiedAt?: string;
  /** Opaque snapshot token; finish_tidy takes it verbatim. */
  readAt: string;
  catalog: CatalogEntry[];
  /** What each development merged since the last tidy changed, for Main to judge which documents fell behind. */
  changes: Array<{ requirementId: string; title: string; history: string }>;
}

/** A finished tidy: its time, Main's verdict on the documents, and the work it leaves. */
export interface LedgerTidyFinished {
  tidiedAt: string;
  documents: TidyDocuments;
  next?: string;
}

export interface RequirementUpdate {
  expectedRevision?: unknown;
  title?: unknown;
  description?: unknown;
  summary?: unknown;
  /** The whole alias list, replacing the current one. */
  aliases?: unknown;
  /** One line appended to the history, dated today. */
  history?: unknown;
  status?: unknown;
  note?: unknown;
  taskId?: unknown;
}

export interface DevelopmentCreate {
  requirementId?: unknown;
  /** The user's own words for the feature; kept as an alias when lookup would not have found it. */
  request?: unknown;
  goal?: unknown;
  completionCriteria?: unknown;
  route?: unknown;
  baseline?: unknown;
  sessionId?: unknown;
  taskId?: unknown;
  /** A withdrawn development of this requirement that the new one picks up again. */
  continues?: unknown;
}

export interface DevelopmentUpdate {
  expectedRevision?: unknown;
  goal?: unknown;
  completionCriteria?: unknown;
  route?: unknown;
  /** `paused`, `active` (resume a paused one) or `withdrawn`. */
  status?: unknown;
  /** Why the user paused or withdrew it; required with those two. */
  reason?: unknown;
}

export interface MergeConfigInput {
  repository?: unknown;
  targetBranch?: unknown;
  executionBackendId?: unknown;
}

export interface ProjectDataDescription {
  engine: ProjectDataEngine;
  /** A locatable target: the SQLite file or `postgresql://host:port/database`. */
  target: string;
  serverVersion: string;
  schemaVersion: number;
  source: string;
}

export interface ProjectDataBackup {
  path: string;
  engine: ProjectDataEngine;
  takenAt: string;
  schemaVersion: number;
  counts: Record<string, number>;
}

export interface ProjectDataRestore {
  takenAt: string;
  counts: Record<string, number>;
}

/**
 * The business surface every consumer uses.
 *
 * A local authority serves this from SQLite/PostgreSQL; a secondary backend
 * serves the same surface through the authenticated remote client. HTTP routes
 * and the Main tool therefore never branch on where the fact is stored.
 */
export interface ProjectDataGateway {
  readonly description: ProjectDataDescription;
  ensureProject(input: Parameters<ProjectDataRepository["ensureProject"]>[0]): Promise<ProjectIdentity>;
  projects(): Promise<SharedProject[]>;
  createRequirement(projectId: unknown, input: RequirementCreate): Promise<RequirementDetail>;
  updateRequirement(
    projectId: unknown,
    requirementId: unknown,
    input: RequirementUpdate
  ): Promise<RequirementDetail>;
  getRequirement(projectId: unknown, requirementId: unknown): Promise<RequirementDetail>;
  queryRequirements(projectId: unknown, query?: RequirementQuery): Promise<RequirementSummary[]>;
  /** Which feature the user's own words are about; see `lookupRequirements`. */
  lookupRequirements(projectId: unknown, request: unknown): Promise<LookupResult>;
  mergedSinceTidy(projectId: unknown): Promise<number>;
  tidyLedger(projectId: unknown): Promise<LedgerTidy>;
  finishLedgerTidy(projectId: unknown, documents: unknown, readAt: unknown): Promise<LedgerTidyFinished>;
  mergeRequirements(projectId: unknown, input: RequirementMerge): Promise<RequirementDetail>;
  // Persistent Main sessions are business facts too: a secondary backend writes
  // them through this surface, never through SQL or a transaction callback.
  createMainSession(
    projectId: unknown,
    input: Parameters<ProjectMainSessionRepository["createMainSession"]>[1]
  ): Promise<MainSessionRecord>;
  adoptMainSessionTasks(
    projectId: unknown,
    backendId: unknown,
    tasks: Parameters<ProjectMainSessionRepository["adoptMainSessionTasks"]>[2]
  ): Promise<number>;
  listMainSessions(projectId: unknown): Promise<MainSessionRecord[]>;
  getMainSession(projectId: unknown, sessionId: unknown): Promise<MainSessionRecord>;
  discardMainSession(projectId: unknown, backendId: unknown, taskId: unknown): Promise<boolean>;
  findMainSessionByTask(
    projectId: unknown,
    backendId: unknown,
    taskId: unknown
  ): Promise<MainSessionRecord | undefined>;
  setMainSessionRequirement(
    projectId: unknown,
    sessionId: unknown,
    requirementId: unknown
  ): Promise<MainSessionRecord>;
  recordMainSessionRun(
    projectId: unknown,
    sessionId: unknown,
    input: Parameters<ProjectMainSessionRepository["recordMainSessionRun"]>[2]
  ): Promise<MainSessionRun>;
  settleMainSessionRun(projectId: unknown, taskId: unknown, runId: unknown, state: unknown): Promise<number>;
  // Development records go through this same surface: the shared goal/baseline
  // and each backend's own checkout are written as business facts.
  mergeConfig(projectId: unknown): Promise<MergeConfig | undefined>;
  setMergeConfig(projectId: unknown, input: MergeConfigInput, backendId: string): Promise<MergeConfig>;
  createDevelopment(projectId: unknown, input: DevelopmentCreate): Promise<DevelopmentRecord>;
  updateDevelopment(
    projectId: unknown,
    developmentId: unknown,
    input: DevelopmentUpdate,
    backendId?: string
  ): Promise<DevelopmentRecord>;
  getDevelopment(projectId: unknown, developmentId: unknown, backendId?: string): Promise<DevelopmentRecord>;
  queryDevelopments(projectId: unknown, backendId?: string): Promise<DevelopmentRecord[]>;
  findDevelopmentByRequirement(
    projectId: unknown,
    requirementId: unknown,
    backendId?: string
  ): Promise<DevelopmentRecord | undefined>;
  recordDevelopmentWorkspace(
    projectId: unknown,
    developmentId: unknown,
    workspace: unknown
  ): Promise<DevelopmentRecord>;
  // A requirement's tickets: one set per development, written as a whole.
  tickets(projectId: unknown, developmentId: unknown): Promise<TicketSet>;
  writeTickets(projectId: unknown, developmentId: unknown, write: TicketWrite): Promise<TicketSet>;
  // Review plans and fixed-candidate reviews are shared delivery facts too.
  reviewPlan(projectId: unknown, developmentId: unknown): Promise<ReviewPlan | undefined>;
  setReviewPlan(projectId: unknown, developmentId: unknown, input: unknown): Promise<ReviewPlan>;
  createReview(projectId: unknown, developmentId: unknown, input: unknown): Promise<DevelopmentReview>;
  updateReview(projectId: unknown, reviewId: unknown, input: unknown): Promise<DevelopmentReview>;
  getReview(projectId: unknown, reviewId: unknown): Promise<DevelopmentReview>;
  queryReviews(projectId: unknown, developmentId?: unknown): Promise<DevelopmentReview[]>;
  // The project's shared merge queue. Any backend applies here; only the
  // configured execution backend claims an operation and writes the target.
  createMerge(projectId: unknown, developmentId: unknown, input: MergeCreate): Promise<DevelopmentMerge>;
  getMerge(projectId: unknown, mergeId: unknown): Promise<DevelopmentMerge>;
  queryMerges(projectId: unknown, developmentId?: unknown): Promise<DevelopmentMerge[]>;
  claimMerge(projectId: unknown, mergeId: unknown, input: unknown): Promise<DevelopmentMerge>;
  updateMerge(projectId: unknown, mergeId: unknown, input: unknown): Promise<DevelopmentMerge>;
  // Delivery synchronization starts from a merged operation's receipt and is
  // idempotent per merge; a pending row is retried rather than re-delivered.
  syncDelivery(projectId: unknown, receipt: unknown): Promise<DevelopmentDelivery>;
  queryDeliveries(projectId: unknown, developmentId?: unknown): Promise<DevelopmentDelivery[]>;
  getDelivery(projectId: unknown, deliveryId: unknown): Promise<DevelopmentDelivery>;
  retryDelivery(projectId: unknown, deliveryId: unknown): Promise<DevelopmentDelivery>;
  boardEntries(projectId: unknown): Promise<BoardEntry[]>;
  boardEntry(projectId: unknown, boardId: unknown): Promise<BoardEntry>;
  boardEvents(projectId: unknown, boardId: unknown): Promise<BoardEvent[]>;
  publishBoardEntry(
    projectId: unknown,
    input: BoardPublishInput,
    context: BoardActionContext
  ): Promise<BoardEntry>;
  boardAction(
    projectId: unknown,
    boardId: unknown,
    action: BoardAction,
    input: BoardActionInput,
    context: BoardActionContext
  ): Promise<BoardEntry>;
  backupTo(path: string): Promise<ProjectDataBackup>;
  restoreFrom(path: string): Promise<ProjectDataRestore>;
  close(): Promise<void>;
}
