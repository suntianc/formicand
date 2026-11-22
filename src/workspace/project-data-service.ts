import {
  ledgerProjectId,
  ProjectDataConflictError,
  ProjectDataInvalidError
} from "../domain/project-ledger.js";
import { type MergeCreate } from "../domain/development-merge.js";
import { type TicketWrite } from "../domain/development-ticket.js";
import {
  deliveryReceipt,
  type DeliveryReceipt,
  type DevelopmentDelivery
} from "../domain/development-delivery.js";
import {
  type BoardAction,
  type BoardActionContext,
  type BoardActionInput,
  type BoardPublishInput
} from "../domain/project-board.js";
import { id } from "../domain/types.js";
import {
  openProjectDataDatabase,
  projectDataTarget,
  resolveProjectDataConfig,
  type ProjectDataConfig
} from "../storage/project-data/config.js";
import type { SqlDatabase } from "../storage/project-data/database.js";
import { lookupRequirements } from "../domain/ledger-lookup.js";
import { ProjectMainSessionRepository, type MainSessionRecord } from "./project-main-session.js";
import { RemoteProjectDataService } from "./project-data-remote.js";

import { ProjectDataRepository } from "./project-data-repository.js";
import { backupProjectData, restoreProjectData } from "./project-data-snapshot.js";
import type {
  RequirementQuery,
  RequirementCreate,
  RequirementMerge,
  LedgerTidy,
  LedgerTidyFinished,
  RequirementUpdate,
  DevelopmentCreate,
  DevelopmentUpdate,
  MergeConfigInput,
  ProjectDataDescription,
  ProjectDataBackup,
  ProjectDataRestore,
  ProjectDataGateway
} from "./project-data-gateway.js";

export { ProjectDataRepository } from "./project-data-repository.js";
export type {
  RequirementQuery,
  RequirementCreate,
  RequirementMerge,
  LedgerTidy,
  LedgerTidyFinished,
  RequirementUpdate,
  DevelopmentCreate,
  DevelopmentUpdate,
  MergeConfigInput,
  ProjectDataDescription,
  ProjectDataBackup,
  ProjectDataRestore,
  ProjectDataGateway
} from "./project-data-gateway.js";
export type { MainSessionRecord } from "./project-main-session.js";

/**
 * The authoritative project data service: shared identity, the requirement
 * ledger, and the backup/restore pair. HTTP, the Main tool and the CLI all use
 * this one interface, so engine choice never changes business behaviour.
 */
export class ProjectDataService implements ProjectDataGateway {
  constructor(
    private readonly database: SqlDatabase,
    readonly description: ProjectDataDescription
  ) {}

  transaction<T>(
    action: (repository: ProjectDataRepository) => Promise<T>,
    mode: "read" | "write" = "write"
  ): Promise<T> {
    return this.database.transaction(
      (transaction) => action(new ProjectDataRepository(transaction, this.database.dialect === "postgres")),
      mode
    );
  }

  ensureProject(input: Parameters<ProjectDataRepository["ensureProject"]>[0]) {
    return this.transaction((repository) => repository.ensureProject(input));
  }
  projects() {
    return this.transaction((repository) => repository.projects());
  }
  createRequirement(projectId: unknown, input: RequirementCreate) {
    return this.transaction((repository) => repository.createRequirement(projectId, input));
  }
  updateRequirement(projectId: unknown, requirementId: unknown, input: RequirementUpdate) {
    return this.transaction((repository) => repository.updateRequirement(projectId, requirementId, input));
  }
  getRequirement(projectId: unknown, requirementId: unknown) {
    return this.transaction((repository) => repository.requirement(projectId, requirementId));
  }
  queryRequirements(projectId: unknown, query: RequirementQuery = {}) {
    return this.transaction((repository) => repository.query(projectId, query));
  }
  lookupRequirements(projectId: unknown, request: unknown) {
    return this.transaction((repository) => repository.lookup(projectId, request));
  }
  mergedSinceTidy(projectId: unknown) {
    return this.transaction((repository) => repository.mergedSinceTidy(projectId), "read");
  }
  tidyLedger(projectId: unknown) {
    return this.transaction((repository) => repository.tidy(projectId));
  }
  finishLedgerTidy(projectId: unknown, documents: unknown, readAt: unknown) {
    return this.transaction((repository) => repository.finishTidy(projectId, documents, readAt));
  }
  mergeRequirements(projectId: unknown, input: RequirementMerge) {
    return this.transaction((repository) => repository.mergeRequirements(projectId, input));
  }
  createMainSession(
    projectId: unknown,
    input: Parameters<ProjectMainSessionRepository["createMainSession"]>[1]
  ) {
    return this.transaction((repository) => repository.sessions().createMainSession(projectId, input));
  }
  adoptMainSessionTasks(
    projectId: unknown,
    backendId: unknown,
    tasks: Parameters<ProjectMainSessionRepository["adoptMainSessionTasks"]>[2]
  ) {
    return this.transaction((repository) =>
      repository.sessions().adoptMainSessionTasks(projectId, backendId, tasks)
    );
  }
  listMainSessions(projectId: unknown) {
    return this.transaction((repository) => repository.sessions().mainSessions(projectId));
  }
  getMainSession(projectId: unknown, sessionId: unknown) {
    return this.transaction((repository) => repository.sessions().mainSession(projectId, sessionId));
  }
  discardMainSession(projectId: unknown, backendId: unknown, taskId: unknown) {
    return this.transaction((repository) =>
      repository.sessions().discardMainSession(projectId, backendId, taskId)
    );
  }
  findMainSessionByTask(projectId: unknown, backendId: unknown, taskId: unknown) {
    return this.transaction((repository) =>
      repository.sessions().mainSessionByTask(projectId, backendId, taskId)
    );
  }
  setMainSessionRequirement(projectId: unknown, sessionId: unknown, requirementId: unknown) {
    return this.transaction((repository) =>
      repository.sessions().setMainSessionRequirement(projectId, sessionId, requirementId)
    );
  }
  recordMainSessionRun(
    projectId: unknown,
    sessionId: unknown,
    input: Parameters<ProjectMainSessionRepository["recordMainSessionRun"]>[2]
  ) {
    return this.transaction((repository) =>
      repository.sessions().recordMainSessionRun(projectId, sessionId, input)
    );
  }
  settleMainSessionRun(projectId: unknown, taskId: unknown, runId: unknown, state: unknown) {
    return this.transaction((repository) =>
      repository.sessions().settleMainSessionRun(projectId, taskId, runId, state)
    );
  }

  mergeConfig(projectId: unknown) {
    return this.transaction((repository) => repository.mergeConfig(projectId));
  }
  setMergeConfig(projectId: unknown, input: MergeConfigInput, backendId: string) {
    return this.transaction((repository) => repository.setMergeConfig(projectId, input, backendId));
  }
  createDevelopment(projectId: unknown, input: DevelopmentCreate) {
    return this.transaction((repository) => repository.createDevelopment(projectId, input));
  }
  updateDevelopment(
    projectId: unknown,
    developmentId: unknown,
    input: DevelopmentUpdate,
    backendId?: string
  ) {
    return this.transaction((repository) =>
      repository.updateDevelopment(projectId, developmentId, input, backendId)
    );
  }
  getDevelopment(projectId: unknown, developmentId: unknown, backendId?: string) {
    return this.transaction((repository) => repository.getDevelopment(projectId, developmentId, backendId));
  }
  queryDevelopments(projectId: unknown, backendId?: string) {
    return this.transaction((repository) => repository.queryDevelopments(projectId, backendId));
  }
  findDevelopmentByRequirement(projectId: unknown, requirementId: unknown, backendId?: string) {
    return this.transaction((repository) =>
      repository.findDevelopmentByRequirement(projectId, requirementId, backendId)
    );
  }
  recordDevelopmentWorkspace(projectId: unknown, developmentId: unknown, workspace: unknown) {
    return this.transaction((repository) =>
      repository.recordDevelopmentWorkspace(projectId, developmentId, workspace)
    );
  }
  tickets(projectId: unknown, developmentId: unknown) {
    return this.transaction((repository) => repository.tickets(projectId, developmentId));
  }
  writeTickets(projectId: unknown, developmentId: unknown, write: TicketWrite) {
    return this.transaction((repository) => repository.writeTickets(projectId, developmentId, write));
  }
  reviewPlan(projectId: unknown, developmentId: unknown) {
    return this.transaction((repository) => repository.reviewPlan(projectId, developmentId));
  }
  setReviewPlan(projectId: unknown, developmentId: unknown, input: unknown) {
    return this.transaction((repository) => repository.setReviewPlan(projectId, developmentId, input));
  }
  createReview(projectId: unknown, developmentId: unknown, input: unknown) {
    return this.transaction((repository) => repository.createReview(projectId, developmentId, input));
  }
  updateReview(projectId: unknown, reviewId: unknown, input: unknown) {
    return this.transaction((repository) => repository.updateReview(projectId, reviewId, input));
  }
  getReview(projectId: unknown, reviewId: unknown) {
    return this.transaction((repository) => repository.getReview(projectId, reviewId));
  }
  queryReviews(projectId: unknown, developmentId?: unknown) {
    return this.transaction((repository) => repository.queryReviews(projectId, developmentId));
  }
  createMerge(projectId: unknown, developmentId: unknown, input: MergeCreate) {
    return this.transaction((repository) => repository.createMerge(projectId, developmentId, input));
  }
  getMerge(projectId: unknown, mergeId: unknown) {
    return this.transaction((repository) => repository.getMerge(projectId, mergeId));
  }
  queryMerges(projectId: unknown, developmentId?: unknown) {
    return this.transaction((repository) => repository.queryMerges(projectId, developmentId));
  }
  claimMerge(projectId: unknown, mergeId: unknown, input: unknown) {
    return this.transaction((repository) => repository.claimMerge(projectId, mergeId, input));
  }
  updateMerge(projectId: unknown, mergeId: unknown, input: unknown) {
    return this.transaction((repository) => repository.updateMerge(projectId, mergeId, input));
  }

  /**
   * Record and apply one merged operation's delivery.
   *
   * The shared merge row is the authority for what actually happened: a receipt
   * that does not match a `merged` row is refused instead of creating a
   * delivery from a caller's claim. The pending row is written first, so a
   * failure while writing the ledger/board leaves a retryable state with the
   * target commit already attached.
   */
  async syncDelivery(projectIdValue: unknown, receiptValue: unknown): Promise<DevelopmentDelivery> {
    const projectId = ledgerProjectId(projectIdValue);
    const receipt: DeliveryReceipt = deliveryReceipt(receiptValue);
    const merge = await this.getMerge(projectId, receipt.mergeId);
    const canonical = merge.receipt;
    if (
      !canonical ||
      merge.state !== "merged" ||
      canonical.mergeId !== receipt.mergeId ||
      canonical.developmentId !== receipt.developmentId ||
      canonical.requirementId !== receipt.requirementId ||
      canonical.candidateCommit !== receipt.candidateCommit ||
      canonical.mergedCommit !== receipt.mergedCommit ||
      canonical.targetBranch !== receipt.targetBranch ||
      canonical.mergedAt !== receipt.mergedAt
    )
      throw new ProjectDataConflictError(
        "交付回执与已合入记录不一致，不能记录交付",
        undefined,
        "delivery_not_merged"
      );
    const delivery = await this.transaction((repository) =>
      repository.delivery().record(projectId, canonical)
    );
    if (delivery.state === "synced") return delivery;
    return this.applyDeliveryRecord(projectId, delivery.deliveryId, merge.executionBackendId);
  }

  queryDeliveries(projectId: unknown, developmentId?: unknown) {
    return this.transaction((repository) => repository.delivery().list(projectId, developmentId));
  }

  getDelivery(projectId: unknown, deliveryId: unknown) {
    return this.transaction((repository) => repository.delivery().get(projectId, deliveryId));
  }

  async retryDelivery(projectIdValue: unknown, deliveryIdValue: unknown): Promise<DevelopmentDelivery> {
    const projectId = ledgerProjectId(projectIdValue);
    const delivery = await this.getDelivery(projectId, deliveryIdValue);
    if (delivery.state === "synced") return delivery;
    const merge = await this.getMerge(projectId, delivery.mergeId);
    const canonical = merge.receipt;
    if (
      !canonical ||
      merge.state !== "merged" ||
      canonical.mergeId !== delivery.mergeId ||
      canonical.developmentId !== delivery.developmentId ||
      canonical.requirementId !== delivery.requirementId ||
      canonical.candidateCommit !== delivery.candidateCommit ||
      canonical.mergedCommit !== delivery.mergedCommit ||
      canonical.targetBranch !== delivery.targetBranch ||
      canonical.mergedAt !== delivery.mergedAt
    )
      throw new ProjectDataConflictError(
        "交付记录与已合入回执不一致，不能同步交付",
        undefined,
        "delivery_not_merged"
      );
    return this.applyDeliveryRecord(projectId, delivery.deliveryId, merge.executionBackendId);
  }

  private async applyDeliveryRecord(
    projectId: string,
    deliveryId: string,
    backendId: string
  ): Promise<DevelopmentDelivery> {
    try {
      return await this.transaction((repository) =>
        repository.delivery().apply(projectId, deliveryId, backendId)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failing = this.transaction((repository) =>
        repository.delivery().fail(projectId, deliveryId, message)
      );
      // eslint-disable-next-line no-restricted-syntax -- 失败原因写不回台账时仍要抛出原始错误，重试由调用方按 pending 行发起
      await failing.catch(() => undefined);
      throw error;
    }
  }

  boardEntries(projectId: unknown) {
    const sharedProjectId = ledgerProjectId(projectId);
    return this.transaction((repository) => repository.board().list(sharedProjectId));
  }
  boardEntry(projectId: unknown, boardId: unknown) {
    const sharedProjectId = ledgerProjectId(projectId);
    return this.transaction((repository) => repository.board().get(sharedProjectId, boardId));
  }
  boardEvents(projectId: unknown, boardId: unknown) {
    const sharedProjectId = ledgerProjectId(projectId);
    return this.transaction((repository) => repository.board().events(sharedProjectId, boardId));
  }
  publishBoardEntry(projectId: unknown, input: BoardPublishInput, context: BoardActionContext) {
    const sharedProjectId = ledgerProjectId(projectId);
    return this.transaction((repository) => repository.board().publish(sharedProjectId, input, context));
  }
  boardAction(
    projectId: unknown,
    boardId: unknown,
    action: BoardAction,
    input: BoardActionInput,
    context: BoardActionContext
  ) {
    const sharedProjectId = ledgerProjectId(projectId);
    return this.transaction((repository) => {
      const board = repository.board();
      switch (action) {
        case "claim":
          return board.claim(sharedProjectId, boardId, input, context);
        case "pause":
          return board.pause(sharedProjectId, boardId, input, context);
        case "release":
          return board.release(sharedProjectId, boardId, input, context);
        case "cancel":
          return board.cancel(sharedProjectId, boardId, input, context);
        default:
          throw new ProjectDataInvalidError("未知的看板操作");
      }
    });
  }

  backupTo(path: string) {
    return backupProjectData(this.database, this.description, path);
  }

  restoreFrom(path: string) {
    return restoreProjectData(this.database, this.description, path);
  }

  close(): Promise<void> {
    return this.database.close();
  }
}

/**
 * Open once at service start and keep the promise for every consumer.
 *
 * Startup failure is a refusal to serve, not a reason to fall back to another
 * engine: an explicit PostgreSQL configuration that cannot be reached must
 * never quietly write a local SQLite file instead.
 */
export class ProjectDataRuntime {
  readonly ready: Promise<void>;
  private readonly opening: Promise<ProjectDataGateway>;

  constructor(options: {
    config?: ProjectDataConfig;
    env?: NodeJS.ProcessEnv;
    configPath: string;
    dataRoot: string;
    /** This backend's stable id; a remote client presents it as a namespace, not a path. */
    backendId?: string;
  }) {
    this.opening = (async () => {
      const resolved = resolveProjectDataConfig(options);
      if (resolved.mode === "authority")
        return RemoteProjectDataService.open({
          url: resolved.authority.url,
          token: resolved.authority.token,
          backendId: options.backendId ?? id("backend"),
          source: resolved.source
        });
      const { database, serverVersion, schemaVersion } = await openProjectDataDatabase(resolved);
      return new ProjectDataService(database, {
        engine: resolved.engine,
        target: projectDataTarget(resolved),
        serverVersion,
        schemaVersion,
        source: resolved.source
      });
    })();
    this.ready = this.opening.then(() => undefined);
    // A caller that awaits `ready` still sees the failure; this only stops Node
    // reporting it as unhandled before the entrypoint reaches that await.
    // eslint-disable-next-line no-restricted-syntax -- 失败仍由 service() 返回的 opening 交给调用方，这里只吞掉未处理拒绝的噪音
    this.ready.catch(() => undefined);
  }

  service(): Promise<ProjectDataGateway> {
    return this.opening;
  }

  async close(): Promise<void> {
    // `ready` already reported a refused open; teardown must not report it twice.
    // eslint-disable-next-line no-restricted-syntax -- 打开失败已由 ready 报告，关闭流程不能再因它拒绝，只能跳过 close
    const service = await this.opening.catch(() => undefined);
    await service?.close();
  }
}
