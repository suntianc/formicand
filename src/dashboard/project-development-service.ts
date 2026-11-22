import { dirname, join, resolve } from "node:path";
import type { WindowDevelopment } from "../runtime/session-handoff.js";
import {
  parseReviewConclusion,
  type ReviewConclusion,
  type ReviewScope
} from "../runtime/subagent-review.js";
import {
  REWORK_ROUNDS,
  approachKind,
  dismissalCategory,
  reviewApproved,
  reviewBasis,
  reviewReport,
  reviewCandidate,
  reviewFindingInput,
  reviewKind,
  reviewMappingInput,
  reviewPlanInput,
  reviewVerdict,
  rulingDecision,
  type ApproachKind,
  type DevelopmentReview,
  type ReviewCandidate,
  type ReviewFinding,
  type ReviewPlan,
  type ReviewQualification
} from "../domain/development-review.js";
import {
  PITFALLS_DIRECTORY,
  hasRetroSignals,
  mergeAcceptance,
  mergeCheckCommands,
  ledgerUpdateInput,
  retroInput,
  retroSignals,
  retroSourceReference,
  type RetroImprovement,
  type RetroInput,
  type DevelopmentMerge,
  type MergeAcceptance,
  type MergeLedgerUpdate,
  type MergeCheck,
  type MergeRetro
} from "../domain/development-merge.js";
import { PITFALLS_INDEX_PAGE, pitfallProblems } from "../domain/pitfall-entries.js";
import {
  deliveryFromMerge,
  deliveryReceipt,
  type DeliveryDiff,
  type DeliveryPatch,
  type DeliveryRoleProgress,
  type DeliveryStage,
  type DeliveryView,
  type DevelopmentDelivery
} from "../domain/development-delivery.js";
import {
  completionCriterionIds,
  developmentNext,
  finalReviews,
  outsideScope,
  reviewBrief,
  ticketBrief,
  ticketIdentifier,
  ticketOfReview,
  type DevelopmentTicket,
  type RereviewBrief,
  type TicketCheckResult,
  type TicketSet,
  type TicketWork,
  type TicketWrite
} from "../domain/development-ticket.js";
import {
  DevelopmentExistsError,
  developmentIdentifier,
  mergeExecutionBackendId,
  mergeRepository,
  mergeTargetBranch,
  type DevelopmentRecord,
  type MergeConfig
} from "../domain/project-development.js";
import {
  hasRegistryProblems,
  problemsSince,
  REGISTRY_FILE,
  registryProblems
} from "../domain/project-documents.js";
import { ProjectDataConflictError, ProjectDataNotFoundError } from "../domain/project-ledger.js";
import { id, now } from "../domain/types.js";
import type {
  DevelopmentCreate,
  DevelopmentUpdate,
  MergeConfigInput,
  ProjectDataGateway,
  ProjectDataRuntime
} from "../workspace/project-data-service.js";
import {
  checkedOutBranch,
  developmentWorkspaceIsIntact,
  git,
  onlyChangesUnder,
  documentsAdded,
  documentsAt,
  changedPagesUnder,
  fileAt,
  prepareDevelopmentWorkspace,
  resolveDevelopmentBaseline
} from "../workspace/development-workspace.js";
import { DeliveryOutbox, type DeliveryIntent } from "../workspace/delivery-outbox.js";
import { releaseReviewSite } from "../workspace/review-site.js";
import {
  isAncestor,
  mergeCandidate,
  publishMerge,
  removeMergeSite,
  runMergeChecks,
  targetTip
} from "../workspace/project-merge.js";

/**
 * The refusal when a project has no merge entry and none can be inferred.
 * It is read by Main: it says what the person must do and forbids working
 * around it, because a Main once went looking for the backend's credential.
 */
const MISSING_MERGE_CONFIG =
  "项目合入配置缺失：项目文件夹不是带有已提交当前分支的 Git 仓库，无法确定合入到哪里。" +
  "请停止开发并告诉用户：在项目文件夹初始化 Git 仓库、提交一次并切到要合入的分支后再继续。" +
  "不要查找、读取或修改 CoworkOS 自己的数据、凭据或接口来绕过这一步。";

export interface DevelopmentProject {
  projectId: string;
  projectName: string;
  projectDirectory: string;
}

/**
 * How a development read may act on the host it reads.
 *
 * `readOnly` is the observation entry's contract: it watches nodes and never
 * works on them, so its reads answer from the stored records without replaying
 * this host's pending deliveries. Work entry and Main tool reads send no
 * marker and still complete a pending delivery before they answer.
 */
export interface DevelopmentReadOptions {
  readOnly?: boolean;
}

/** One work item's durable facts, read from this host's queue rather than a model claim. */
export interface WorkItemCallFact {
  callId: string;
  agentId: string;
  role: "executor" | "reviewer";
  workspace?: string;
  developmentId?: string;
  status: string;
  continuationFrom?: string;
  /** A finished Reviewer's submitted conclusion. */
  review?: ReviewConclusion;
}

export interface ProjectDevelopmentPorts {
  runtime: Pick<ProjectDataRuntime, "service">;
  /** The serving backend: it owns the checkouts it prepares and can read them back. */
  backendId: string;
  /**
   * This process instance's start time. A merge claim records it, so a later
   * process of the same backend can tell an interrupted operation from one that
   * is still being applied by this instance.
   */
  startedAt?: string;
  /** Where isolated checkouts live, outside every user working copy. */
  developmentRoot: string;
  /** Where this host keeps the delivery facts it published but has not synced yet. */
  deliveryRoot?: string;
  /**
   * Test-only crash injection: `crash:<mergeId|*>@after-apply` kills the process
   * between the target update and its record, reproducing that recovery window.
   */
  mergeFaultInject?: string;
  project(projectId: string): Promise<DevelopmentProject | undefined>;
  taskProject(taskId: string): Promise<DevelopmentProject | undefined>;
  /** A call this Task's own durable queue recorded; never an identity the model supplied. */
  call?(taskId: string, callId: string): Promise<WorkItemCallFact | undefined>;
}

/** Longest patch text one preview reads; a larger change is cut and marked truncated. */
const DELIVERY_PATCH_LIMIT = 200_000;
/** Longest single file the preview renders as content; a larger file is read from its patch. */
const DELIVERY_FILE_LIMIT = 120_000;

/**
 * The development-record service: shared goal, criteria, route and baseline,
 * plus this backend's isolated Git checkout.
 *
 * The shared record is written through the unified project-data gateway, so
 * SQLite and PostgreSQL behave the same; the repository check and the
 * `git worktree` are host facts and stay in this backend. A failed checkout is
 * recorded and returned rather than thrown away, so the requirement and the
 * workspace it names remain findable.
 */
export function createProjectDevelopmentService(ports: ProjectDevelopmentPorts) {
  const gateway = () => ports.runtime.service();
  const deliveryOutbox = new DeliveryOutbox(
    ports.deliveryRoot ?? join(ports.developmentRoot, "delivery-sync")
  );

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

  function conflict(message: string, code: string): ProjectDataConflictError {
    return new ProjectDataConflictError(message, undefined, code);
  }

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

  interface ReviewSiteState {
    head: string;
    tree: string;
    changes: string;
  }

  /** Read the Reviewer checkout, or undefined while it is not prepared yet. */
  async function readReviewSite(workspace: string): Promise<ReviewSiteState | undefined> {
    try {
      const [head, tree, changes] = await Promise.all([
        git(workspace, ["rev-parse", "HEAD"]),
        git(workspace, ["rev-parse", "HEAD^{tree}"]),
        git(workspace, ["status", "--porcelain", "--untracked-files=no"])
      ]);
      return { head, tree, changes };
      // eslint-disable-next-line no-restricted-syntax -- 审查现场尚未准备或已被删除时 Git 读不到，返回 undefined 让调用方按“未准备”继续
    } catch {
      return undefined;
    }
  }

  /** The reviewed content is the candidate commit's tracked tree, not the Reviewer's evidence files. */
  function driftReason(site: ReviewSiteState, candidate: ReviewCandidate): string | undefined {
    if (site.head !== candidate.commit)
      return `审查现场已从候选 ${candidate.commit.slice(0, 8)} 移到 ${site.head.slice(0, 8)}`;
    if (site.tree !== candidate.tree) return `审查现场的受审内容已变化（树 ${site.tree.slice(0, 8)}）`;
    if (site.changes)
      return `审查现场有未提交的受控文件改动：${site.changes.split("\n").slice(0, 5).join("、")}`;
    return undefined;
  }

  async function markDrifted(projectId: string, review: DevelopmentReview, reason: string): Promise<void> {
    await (
      await gateway()
    ).updateReview(projectId, review.reviewId, {
      expectedRevision: review.revision,
      state: "drifted",
      drift: reason
    });
    // A drift ends this review's verdict; its checkout can no longer support
    // any conclusion about the candidate.
    await releaseReviewerSite(review);
    await ticketVerdict(projectId, review, false);
  }

  /** A ticket review's verdict moves its ticket: passed, or back to rework. */
  async function ticketVerdict(projectId: string, review: DevelopmentReview, passed: boolean): Promise<void> {
    const service = await gateway();
    const ticket = ticketOfReview(
      (await service.tickets(projectId, review.developmentId)).tickets,
      review.reviewId
    );
    if (ticket?.state !== "in_review" || ticket.reviewIds.at(-1) !== review.reviewId) return;
    await service.writeTickets(projectId, review.developmentId, {
      op: "verdict",
      ticketId: ticket.ticketId,
      passed
    });
  }

  /**
   * The reviews that share one rework budget: a ticket's own, or the
   * requirement's own (the full route's final reviews, or a quick change's).
   */
  function chainOf(
    tickets: DevelopmentTicket[],
    reviews: DevelopmentReview[],
    ticket?: DevelopmentTicket
  ): DevelopmentReview[] {
    return ticket
      ? reviews.filter((review) => ticket.reviewIds.includes(review.reviewId))
      : finalReviews(tickets, reviews);
  }

  /**
   * The failed rounds a chain has had and the rounds it may have. Each change of
   * approach other than delivering what is done grants a new budget.
   */
  function roundBudget(chain: DevelopmentReview[]) {
    const failed = chain.filter((review) => review.state === "failed");
    const changed: ApproachKind[] = failed.flatMap((review) =>
      review.verdict?.approach && review.verdict.approach.kind !== "deliver_partial"
        ? [review.verdict.approach.kind]
        : []
    );
    return {
      failed: failed.length,
      limit: REWORK_ROUNDS * (1 + changed.length),
      changed,
      last: failed.at(-1)
    };
  }

  /**
   * Refuse another round of the same rework once the chain used its budget, and
   * check that the first round after a change of approach carries it out.
   */
  function checkRound(
    chain: DevelopmentReview[],
    tickets: DevelopmentTicket[],
    ticket?: DevelopmentTicket
  ): void {
    const budget = roundBudget(chain);
    const label = ticket ? `票 ${ticket.ticketId}` : "这个需求的整体审查";
    if (budget.last && budget.failed >= budget.limit)
      throw conflict(
        `${label} 已返修 ${budget.failed} 轮，到了上限：不要原样再改一轮。先对审查 ${budget.last.reviewId} 用 change_approach 换办法（${
          ticket ? "fresh_executor / revised_ticket" : "new_plan"
        } / deliver_partial），写明理由`,
        "review_round_limit"
      );
    const last = budget.last;
    const approach = last?.verdict?.approach;
    if (!last || !approach || chain.some((review) => review.createdAt > approach.at)) return;
    const since = last.verdict!.at;
    if (approach.kind === "fresh_executor" && ticket?.work?.agentId === last.author?.agentId)
      throw conflict(
        `换办法选的是换执行者：${label} 须由新的 Executor 从头做（call_subagent 带 ticketId、不带 continueCallId），不能接着原会话改`,
        "review_approach_not_applied"
      );
    if (approach.kind === "revised_ticket" && !ticket?.changes.some((change) => change.at > since))
      throw conflict(
        `换办法选的是改票：先用 revise_ticket 改 ${label}，再送审`,
        "review_approach_not_applied"
      );
    if (
      approach.kind === "new_plan" &&
      tickets.length > 0 &&
      !tickets.some((entry) => entry.createdAt > since)
    )
      throw conflict(
        "换办法选的是重新规划：先用 propose_tickets 提出新的修复票并并入，再送整体终审",
        "review_approach_not_applied"
      );
  }

  /** A re-review answers the previous round, so every finding there must be ruled first. */
  /**
   * The round a new review follows: the chain's latest, from the stored
   * reviews. Leaving `previousReviewId` out does not start a fresh chain, so a
   * failed candidate is never reviewed again unchanged; a drifted review ended
   * because the checkout moved, not on a verdict.
   */
  function previousRound(
    chain: DevelopmentReview[],
    given: unknown,
    commit: string
  ): DevelopmentReview | undefined {
    const latest = chain.at(-1);
    if (given !== undefined) {
      const id = developmentIdentifier(given, "上一次审查 ID");
      if (latest?.reviewId !== id)
        throw conflict(
          latest ? `上一次审查是 ${latest.reviewId}，复审接着它` : "还没有上一次审查",
          "review_previous_mismatch"
        );
    }
    if (!latest) return undefined;
    if (latest.state === "in_review")
      throw conflict("上一次审查还没有结束，不能开始复审", "review_previous_open");
    if (latest.candidate.commit === commit) {
      if (latest.state === "failed")
        throw conflict("候选没有变化；复审需要新的候选提交", "review_candidate_unchanged");
      // Another review of a version that passed, such as a combined one, starts its own chain.
      if (latest.state === "passed" && given === undefined) return undefined;
    }
    checkPreviousRuled(latest);
    return latest;
  }

  function checkPreviousRuled(previous: DevelopmentReview): void {
    const open = previous.findings.filter((finding) => finding.state === "open");
    if (open.length)
      throw conflict(
        `上一轮审查 ${previous.reviewId} 还有没裁定的发现：${open
          .map((finding) => finding.findingId)
          .join("、")}；先 rule_finding`,
        "review_previous_unruled"
      );
  }

  /**
   * What one review may cite and, on a re-review, the previous round it answers.
   * Read before the conclusion is imported: the previous round's claimed fixes
   * are what the re-review must answer.
   */
  async function reviewScopeOf(projectId: string, review: DevelopmentReview) {
    const service = await gateway();
    const record = await service.getDevelopment(projectId, review.developmentId, ports.backendId);
    const { tickets } = await service.tickets(projectId, review.developmentId);
    const ticket = ticketOfReview(tickets, review.reviewId);
    const previous = review.previousReviewId
      ? await service.getReview(projectId, review.previousReviewId)
      : undefined;
    const toFix = previous?.findings.filter((finding) => finding.state === "fix_claimed") ?? [];
    const scope: ReviewScope = {
      criteria: ticket
        ? ticket.criteria.map((criterion) => criterion.criterionId)
        : [
            ...completionCriterionIds(record.completionCriteria),
            ...(review.mapping ?? []).map((row) => row.rowId)
          ],
      ...(previous
        ? {
            previous: toFix.map((finding) => ({ findingId: finding.findingId, title: finding.title })),
            changedPaths: review.changedPaths
          }
        : {})
    };
    const rereview: RereviewBrief | undefined = previous
      ? {
          previous: toFix.map((finding) => ({
            findingId: finding.findingId,
            title: finding.title,
            ...(finding.location ? { location: finding.location } : {}),
            detail: finding.detail
          })),
          changedPaths: review.changedPaths
        }
      : undefined;
    return { record, tickets, ticket, previous, scope, rereview, mapping: review.mapping };
  }

  /**
   * Write a finished Reviewer's conclusion into its review.
   *
   * The program imports it, so Main neither transcribes nor drops a finding:
   * blocking findings open, the rest are suggestions, and on a re-review each
   * claimed fix of the previous round becomes fixed or is carried here, under
   * its id, as an open finding.
   */
  async function importConclusion(
    projectId: string,
    review: DevelopmentReview,
    conclusion: ReviewConclusion
  ): Promise<DevelopmentReview> {
    const service = await gateway();
    const reviewer = review.reviewer!;
    const { parsed, previous } = await checkedConclusion(projectId, review, conclusion);
    const timestamp = now();
    const source = { role: "reviewer" as const, callId: reviewer.callId, agentId: reviewer.agentId };

    const answers = parsed.review.previousFindings ?? [];
    const carried: ReviewFinding[] = answers
      .filter((answer) => !answer.fixed)
      .map((answer) => {
        const before = previous!.findings.find((finding) => finding.findingId === answer.findingId)!;
        return {
          findingId: before.findingId,
          title: before.title,
          detail: answer.evidence,
          ...(before.location ? { location: before.location } : {}),
          blocking: true,
          ...(before.basis ? { basis: before.basis } : {}),
          candidateCommit: review.candidate.commit,
          state: "open",
          checks: [],
          source,
          createdAt: timestamp,
          updatedAt: timestamp
        };
      });
    const found: ReviewFinding[] = parsed.review.findings.map((finding) => ({
      findingId: id("finding"),
      title: finding.title,
      detail: finding.evidence,
      location: finding.location,
      blocking: finding.blocking,
      ...(finding.basis ? { basis: finding.basis } : {}),
      candidateCommit: review.candidate.commit,
      state: finding.blocking ? "open" : "suggestion",
      checks: [],
      source,
      createdAt: timestamp,
      updatedAt: timestamp
    }));
    if (previous && answers.length)
      await service.updateReview(projectId, previous.reviewId, {
        expectedRevision: previous.revision,
        findings: previous.findings.map((finding) => {
          const answer = answers.find((entry) => entry.findingId === finding.findingId);
          if (!answer || finding.state !== "fix_claimed") return finding;
          return answer.fixed
            ? {
                ...finding,
                state: "fixed" as const,
                fixedCommit: review.candidate.commit,
                verifiedByReviewId: review.reviewId,
                updatedAt: timestamp
              }
            : { ...finding, state: "reopened" as const, updatedAt: timestamp };
        })
      });
    return service.updateReview(projectId, review.reviewId, {
      expectedRevision: review.revision,
      reviewer: {
        ...reviewer,
        conclusion: {
          verdict: parsed.review.verdict,
          ...(parsed.review.previousFindings ? { previousFindings: parsed.review.previousFindings } : {}),
          at: timestamp
        }
      },
      findings: [...review.findings, ...carried, ...found]
    });
  }

  /** A conclusion checked against the review it belongs to; refused before anything is bound or written. */
  async function checkedConclusion(
    projectId: string,
    review: DevelopmentReview,
    conclusion: ReviewConclusion
  ) {
    const { scope, previous } = await reviewScopeOf(projectId, review);
    const parsed = parseReviewConclusion(conclusion, scope);
    if (!parsed.ok)
      throw conflict(
        `Reviewer 的结论不符合这次审查的规则：${parsed.errors.join("；")}。派一个新的 Reviewer 重新审查`,
        "review_conclusion_invalid"
      );
    return { parsed, previous };
  }

  /**
   * Change approach on a failed review whose chain used its rounds.
   *
   * Main decides and records why; the next freeze checks the change was carried
   * out. Delivering what is done accepts the failed review as it is, once every
   * finding that stays unfixed has a recorded dismissal.
   */
  async function changeApproach(projectId: string, input: Record<string, unknown>) {
    const service = await gateway();
    const reviewId = developmentIdentifier(input.reviewId, "审查 ID");
    const review = await service.getReview(projectId, reviewId);
    if (review.state !== "failed" || !review.verdict)
      throw conflict("只有没通过的审查才能换办法", "review_state_conflict");
    const kind = approachKind(input.approach);
    const basis = reviewBasis(input.basis);
    const [{ tickets }, reviews] = await Promise.all([
      service.tickets(projectId, review.developmentId),
      service.queryReviews(projectId, review.developmentId)
    ]);
    const ticket = ticketOfReview(tickets, reviewId);
    const chain = chainOf(tickets, reviews, ticket);
    if (chain.at(-1)?.reviewId !== reviewId)
      throw conflict("只能对审查链上最近的一次审查换办法", "review_not_latest");
    if (review.verdict.approach)
      throw conflict(
        `审查 ${reviewId} 已经换过办法（${review.verdict.approach.kind}）`,
        "review_approach_recorded"
      );
    const budget = roundBudget(chain);
    if (budget.failed < budget.limit)
      throw conflict(
        `还没到返修上限（已返修 ${budget.failed} 轮，上限 ${budget.limit} 轮）；照常返修`,
        "review_round_available"
      );
    const allowed: ApproachKind[] = ticket
      ? ["fresh_executor", "revised_ticket", "deliver_partial"]
      : ["new_plan", "deliver_partial"];
    if (!allowed.includes(kind))
      throw conflict(
        `${ticket ? "票的审查" : "整体审查"}只能选 ${allowed.join(" / ")}`,
        "review_approach_invalid"
      );
    if (budget.changed.includes(kind))
      throw conflict(
        `${kind} 在这条审查链上已经用过；换一种办法，或 deliver_partial`,
        "review_approach_used"
      );
    if (kind === "deliver_partial") {
      const pending = review.findings.filter(
        (finding) => finding.state === "open" || finding.state === "fix_claimed"
      );
      if (pending.length)
        throw conflict(
          `先把不再修的发现裁定为不采纳（category=deferred，写明没做的部分）：${pending
            .map((finding) => finding.findingId)
            .join("、")}`,
          "review_findings_open"
        );
    }
    const updated = await service.updateReview(projectId, reviewId, {
      expectedRevision: review.revision,
      verdict: { ...review.verdict, approach: { kind, basis, at: now() } }
    });
    if (kind === "deliver_partial" && ticket?.state === "rework" && ticket.reviewIds.at(-1) === reviewId)
      await service.writeTickets(projectId, review.developmentId, {
        op: "verdict",
        ticketId: ticket.ticketId,
        passed: true
      });
    return updated;
  }

  /** Whether a development is split into tickets: the direct and full routes. */
  function ticketRoute(record: DevelopmentRecord): boolean {
    return record.route !== "quick";
  }

  async function requireTicket(
    projectId: string,
    developmentId: string,
    ticketIdValue: unknown
  ): Promise<{ set: TicketSet; ticket: DevelopmentTicket }> {
    const ticketId = ticketIdentifier(ticketIdValue);
    const set = await (await gateway()).tickets(projectId, developmentId);
    const ticket = set.tickets.find((entry) => entry.ticketId === ticketId);
    if (!ticket) throw conflict(`需求没有票 ${ticketId}`, "ticket_missing");
    return { set, ticket };
  }

  /** A checkout's committed state, read from Git. */
  async function inspectDirectory(directory: string) {
    try {
      const [commit, tree, branch, changes] = await Promise.all([
        git(directory, ["rev-parse", "HEAD"]),
        git(directory, ["rev-parse", "HEAD^{tree}"]),
        git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]),
        git(directory, ["status", "--porcelain"])
      ]);
      return { commit, tree, branch, workspace: directory, changes };
    } catch (error) {
      throw conflict(
        `无法读取现场 ${directory}：${error instanceof Error ? error.message : String(error)}`,
        "review_site_unavailable"
      );
    }
  }

  /**
   * Freeze the requirement checkout for the full route's final review.
   *
   * Each ticket was reviewed on its own; this one looks at the whole
   * requirement once every ticket is in, on the version the program produced.
   * A defect found here becomes a new fix ticket, so a re-review follows the
   * previous final review rather than an Executor's rework.
   */
  async function startFinalReview(
    projectId: string,
    record: DevelopmentRecord,
    input: Record<string, unknown>
  ): Promise<DevelopmentReview> {
    const service = await gateway();
    const developmentId = record.developmentId;
    const { tickets } = await service.tickets(projectId, developmentId);
    const pending = tickets.filter((ticket) => ticket.state !== "merged");
    if (!tickets.length || pending.length)
      throw conflict(
        pending.length
          ? `票 ${pending.map((ticket) => ticket.ticketId).join("、")} 还没有并进需求现场；整体终审在全部票并入之后，单张票的审查须带 ticketId`
          : "还没有票；full 路线先 propose_tickets",
        "final_review_early"
      );
    const candidate = await currentCandidate(record);
    const last = lastIntegration(tickets);
    if (last?.commit !== candidate.commit)
      throw conflict("需求现场不是最后一次并入票的版本；不要在现场直接提交改动", "candidate_changed");
    const finals = finalReviews(tickets, await service.queryReviews(projectId, developmentId));
    if (finals.some((review) => review.state === "in_review"))
      throw conflict("已有一份进行中的整体终审", "review_open");
    checkRound(finals, tickets);
    const previous = previousRound(finals, input.previousReviewId, candidate.commit);
    // The documents come first: fixing them takes a ticket, and the final review covers its result.
    await requireRegistry(record, candidate.commit);
    // Written for this candidate: a later round's mapping is rewritten for its own tip.
    if (input.mapping === undefined)
      throw conflict(
        "整体终审先写对照表：freeze_candidate 带 mapping，每行一条要求和集成版本上能证明它的测试、命令或文件",
        "final_review_mapping_missing"
      );
    const mapping = reviewMappingInput(input.mapping);
    return service.createReview(projectId, developmentId, {
      kind: "independent",
      candidate,
      mapping,
      ...(previous
        ? {
            previousReviewId: previous.reviewId,
            previousCandidateCommit: previous.candidate.commit,
            changedPaths: (
              await git(record.workspace!.directory, [
                "diff",
                "--name-only",
                `${previous.candidate.commit}..${candidate.commit}`
              ])
            )
              .split("\n")
              .filter(Boolean)
              .slice(0, 200)
          }
        : {})
    });
  }

  /** The version the program last produced by bringing a ticket in. */
  function lastIntegration(tickets: DevelopmentTicket[]) {
    return tickets
      .flatMap((ticket) => (ticket.integration ? [ticket.integration] : []))
      .sort((a, b) => a.at.localeCompare(b.at))
      .at(-1);
  }

  /**
   * Freeze one ticket's own checkout for review.
   *
   * The candidate is the Executor's committed work, not the requirement
   * checkout, so each ticket is reviewed on its own; the files it changed since
   * it forked must all be inside the ticket's scope.
   */
  async function startTicketReview(
    projectId: string,
    taskId: string | undefined,
    record: DevelopmentRecord,
    input: Record<string, unknown>
  ): Promise<DevelopmentReview> {
    const service = await gateway();
    const developmentId = record.developmentId;
    const { ticket } = await requireTicket(projectId, developmentId, input.ticketId);
    if (!ticket.work) throw conflict(`票 ${ticket.ticketId} 还没有派给 Executor`, "ticket_not_started");
    if (ticket.state !== "in_progress" && ticket.state !== "rework")
      throw conflict(`票 ${ticket.ticketId} 现在不能送审`, "ticket_state_conflict");
    const fact = await requireCall(taskId, ticket.work.callId);
    if (fact.status !== "completed")
      throw conflict(
        `票 ${ticket.ticketId} 的 Executor ${fact.callId} 还没有完成（${fact.status}）`,
        "ticket_work_running"
      );
    const current = await inspectDirectory(ticket.work.workspace);
    if (current.changes)
      throw conflict("票的现场有未提交改动；让 Executor 提交后再冻结", "review_candidate_dirty");
    const integration = await inspectWorkspace(record);
    const base = await git(record.workspace!.directory, ["merge-base", integration.commit, current.commit]);
    const changed = (
      await git(record.workspace!.directory, ["diff", "--name-only", `${base}..${current.commit}`])
    )
      .split("\n")
      .filter(Boolean);
    if (!changed.length) throw conflict(`票 ${ticket.ticketId} 的现场没有新提交`, "ticket_no_changes");
    const outside = ticket.scope.length ? outsideScope(ticket.scope, changed) : [];
    if (outside.length)
      throw conflict(
        `票 ${ticket.ticketId} 改动了范围以外的文件：${outside.slice(0, 20).join("、")}。让 Executor 撤回这些改动，或经用户确认用 revise_ticket 扩大范围`,
        "ticket_scope_exceeded"
      );
    const { tickets } = await service.tickets(projectId, developmentId);
    const chain = chainOf(tickets, await service.queryReviews(projectId, developmentId), ticket);
    checkRound(chain, tickets, ticket);
    const previous = previousRound(chain, input.previousReviewId, current.commit);
    // A re-review looks at what this round changed, not everything since the fork.
    const roundChanges = previous
      ? (
          await git(record.workspace!.directory, [
            "diff",
            "--name-only",
            `${previous.candidate.commit}..${current.commit}`
          ])
        )
          .split("\n")
          .filter(Boolean)
      : changed;
    const review = await service.createReview(projectId, developmentId, {
      kind: "independent",
      candidate: {
        commit: current.commit,
        tree: current.tree,
        branch: current.branch,
        workspace: current.workspace
      },
      author: {
        role: "executor",
        callId: fact.callId,
        agentId: fact.agentId,
        workspace: ticket.work.workspace
      },
      ...(previous
        ? {
            previousReviewId: previous.reviewId,
            previousCandidateCommit: previous.candidate.commit,
            changedPaths: roundChanges.slice(0, 200)
          }
        : {})
    });
    await service.writeTickets(projectId, developmentId, {
      op: "review",
      ticketId: ticket.ticketId,
      reviewId: review.reviewId
    });
    return review;
  }

  /**
   * Bring a ticket's reviewed commit into the requirement checkout.
   *
   * The program merges it, then runs the project's checks and the ticket's
   * acceptance commands there. A conflict or a failing check leaves the
   * checkout as it was, so a later ticket never builds on a broken version.
   */
  function integrateTicket(projectId: string, input: Record<string, unknown>) {
    return inDevelopment(projectId, input, () => integrateTicketNow(projectId, input));
  }

  async function integrateTicketNow(projectId: string, input: Record<string, unknown>) {
    const developmentId = developmentIdentifier(input.developmentId, "开发记录 ID");
    const record = await openDevelopment(projectId, developmentId);
    const service = await gateway();
    const { ticket } = await requireTicket(projectId, developmentId, input.ticketId);
    if (ticket.state !== "passed")
      throw conflict(`票 ${ticket.ticketId} 还没有通过审查`, "ticket_state_conflict");
    const review = await service.getReview(projectId, ticket.reviewIds.at(-1)!);
    const item = await inspectDirectory(ticket.work!.workspace);
    if (item.commit !== review.candidate.commit || item.tree !== review.candidate.tree)
      throw conflict(
        `票 ${ticket.ticketId} 的现场在审查后又有变化；须对新提交重新审查`,
        "ticket_candidate_changed"
      );
    const directory = record.workspace!.directory;
    const before = await inspectWorkspace(record);
    if (before.changes) throw conflict("需求现场有未提交改动；先提交或清理", "review_candidate_dirty");
    const checks = [
      ...(input.checks === undefined ? [] : mergeCheckCommands(input.checks)),
      ...ticket.criteria.flatMap((criterion) =>
        "command" in criterion.check
          ? [{ name: `${ticket.ticketId} ${criterion.criterionId}`, command: criterion.check.command }]
          : []
      )
    ];
    if (!checks.length)
      throw conflict("并进需求现场须至少有一项检查：传入项目检查命令", "merge_checks_missing");
    try {
      await git(directory, [
        "merge",
        "--no-ff",
        "-m",
        `Merge ticket ${ticket.ticketId}: ${ticket.title}`,
        item.commit
      ]);
    } catch (error) {
      const paths = await git(directory, ["diff", "--name-only", "--diff-filter=U"])
        .then((listing) => listing.split("\n").filter(Boolean))
        // eslint-disable-next-line no-restricted-syntax -- 冲突文件列表读不到时仍按合并失败处理，原始 git 错误随后报告
        .catch(() => [] as string[]);
      // eslint-disable-next-line no-restricted-syntax -- 合并已失败，可能没有可中止的合并；中止失败不改变下面的拒绝结果
      await git(directory, ["merge", "--abort"]).catch(() => undefined);
      throw conflict(
        paths.length
          ? `票 ${ticket.ticketId} 与需求现场冲突：${paths.join("、")}。让原 Executor 在它的现场合并需求现场的最新提交后重新审查`
          : `票 ${ticket.ticketId} 无法并进需求现场：${error instanceof Error ? error.message : String(error)}`,
        "ticket_integration_conflict"
      );
    }
    const results = await runMergeChecks(directory, checks);
    const failed = results.filter((check) => check.exitCode !== 0);
    if (failed.length) {
      // Only the merge just made is undone; the checkout was clean before it.
      await git(directory, ["reset", "--hard", before.commit]);
      return {
        integrated: false,
        ticketId: ticket.ticketId,
        developmentId,
        checks: results,
        detail: `检查未通过：${failed.map((check) => check.name).join("、")}；需求现场已回到并入前`
      };
    }
    const after = await inspectWorkspace(record);
    const tickets = await service.writeTickets(projectId, developmentId, {
      op: "integrate",
      ticketId: ticket.ticketId,
      integration: {
        commit: after.commit,
        tree: after.tree,
        itemCommit: item.commit,
        checks: results.map((check): TicketCheckResult => ({
          name: check.name,
          command: check.command,
          exitCode: check.exitCode ?? 0,
          output: check.output ?? "",
          at: check.at ?? now()
        })),
        at: now()
      }
    });
    return { integrated: true, developmentId, tickets };
  }

  /** The tickets a delegation implements: the brief the Executor reads, after its rules are checked. */
  async function ticketForDispatch(
    taskId: string,
    developmentId: string,
    ticketIdValue: unknown,
    continuation = false
  ) {
    const found = await taskProject(taskId);
    const record = await (await gateway()).getDevelopment(found.projectId, developmentId, ports.backendId);
    if (!ticketRoute(record)) throw conflict("quick 路线没有票", "ticket_missing");
    const { set, ticket } = await requireTicket(found.projectId, developmentId, ticketIdValue);
    const criteria = ticket.criteria.map((criterion) => criterion.criterionId);
    // A continuation keeps the session that already read the brief: a rework
    // restarts the ticket, a follow-up while it is still running leaves it alone.
    if (continuation) {
      if (ticket.state === "rework") return { ticketId: ticket.ticketId, criteria, start: true };
      if (ticket.state === "in_progress") return { ticketId: ticket.ticketId, criteria, start: false };
      throw conflict(`票 ${ticket.ticketId} 现在不需要返修`, "ticket_state_conflict");
    }
    if (ticket.state !== "confirmed" && ticket.state !== "rework")
      throw conflict(
        ticket.state === "draft"
          ? `票 ${ticket.ticketId} 还没有经用户确认`
          : `票 ${ticket.ticketId} 已经在执行或已完成，返修用 continueCallId`,
        "ticket_state_conflict"
      );
    const blocking = ticket.dependsOn.filter(
      (id) => set.tickets.find((other) => other.ticketId === id)?.state !== "merged"
    );
    if (ticket.state === "confirmed" && blocking.length)
      throw conflict(
        `票 ${ticket.ticketId} 依赖的票 ${blocking.join("、")} 还没有合入`,
        "ticket_dependency_pending"
      );
    return { ticketId: ticket.ticketId, brief: ticketBrief(ticket), criteria, start: true };
  }

  async function ticketStarted(taskId: string, developmentId: string, ticketId: string, work: TicketWork) {
    const found = await taskProject(taskId);
    await (await gateway()).writeTickets(found.projectId, developmentId, { op: "start", ticketId, work });
  }

  /**
   * Release a Reviewer's checkout once its review is closed.
   *
   * The site is evidence only while the review is open: Main binds the review
   * and checks the candidate for drift after the Reviewer's process ends. When
   * the review reaches a verdict — passed, failed or drifted — that check has
   * already run and the recorded findings, checks and rulings are the facts
   * that outlive it. The worktree would otherwise accumulate one copy per
   * review for the life of the requirement.
   */
  async function releaseReviewerSite(review: DevelopmentReview): Promise<void> {
    const reviewer = review.reviewer;
    if (!reviewer?.workspace) return;
    await releaseSite(review, reviewer.workspace);
  }

  /**
   * Release every Reviewer checkout of a requirement that has just landed.
   *
   * A merged requirement is the end of its review cycle: the verdicts,
   * findings, rulings and delivery records are the durable facts, and the
   * checkouts would otherwise stay on disk for the life of the project.
   */
  async function releaseDevelopmentReviewSites(projectId: string, developmentId: string): Promise<void> {
    try {
      const service = await gateway();
      for (const review of await service.queryReviews(projectId, developmentId))
        await releaseReviewerSite(review);
      // eslint-disable-next-line no-restricted-syntax -- 合入后的现场清理是收尾簿记：交付与审查记录已经落盘，清理失败不能让合入结果失败
    } catch {
      /* bookkeeping only */
    }
  }

  async function releaseSite(review: DevelopmentReview, directory: string): Promise<void> {
    try {
      await releaseReviewSite({
        repository: review.candidate.workspace,
        commit: review.candidate.commit,
        directory
      });
      // eslint-disable-next-line no-restricted-syntax -- 清理审查现场是收尾簿记：审查结论已经落盘，清理失败不能让已完成的审查失败；残留现场下次清理或 git worktree prune 回收
    } catch {
      /* bookkeeping only */
    }
  }

  async function requireCall(taskId: string | undefined, callIdValue: unknown): Promise<WorkItemCallFact> {
    const callId = developmentIdentifier(callIdValue, "工作项 callId");
    if (!taskId) throw conflict("审查操作须来自一个 Main 会话", "review_task_required");
    if (!ports.call) throw conflict("当前服务无法读取工作项身份", "review_call_source_missing");
    const fact = await ports.call(taskId, callId);
    if (!fact) throw conflict(`当前运行没有工作项 ${callId}`, "review_call_unknown");
    return fact;
  }

  async function setReviewPlan(projectId: string, input: Record<string, unknown>) {
    const developmentId = developmentIdentifier(input.developmentId, "开发记录 ID");
    const record = await openDevelopment(projectId, developmentId);
    const current = await inspectWorkspace(record);
    // A self check belongs to the integration version it actually ran on. The
    // program records that version here, so a later commit cannot inherit it.
    const plan = reviewPlanInput({
      ...input,
      candidate: {
        commit: current.commit,
        tree: current.tree,
        branch: current.branch,
        workspace: current.workspace
      }
    });
    if (plan.channel === "self" && plan.checks.length === 0)
      throw conflict("没有独立 Reviewer 时须至少记录一项相关验证", "review_checks_missing");
    // The checks claim this committed version. An uncommitted checkout would
    // let a later clean state inherit verification that never ran on it.
    if (plan.channel === "self" && current.changes)
      throw conflict("自检须对应已提交的干净现场；先提交或清理再记录", "review_candidate_dirty");
    if (plan.channel === "self") {
      // A review already opened for this development stands: the self channel
      // records a decision made before review, not a way to erase one.
      const existing = await (await gateway()).queryReviews(projectId, developmentId);
      if (existing.length)
        throw conflict("该需求已有候选审查，不能改为无独立审查的通道", "review_channel_downgrade");
    }
    return (await gateway()).setReviewPlan(projectId, developmentId, plan);
  }

  const developmentQueues = new Map<string, Promise<unknown>>();

  /**
   * One development's checkout work, one step at a time in this process: Main
   * may send several tool calls at once, and bringing a ticket in, checking it
   * and rolling back, or opening a final review, each reads the checkout or
   * the open rounds before it writes them.
   */
  function inDevelopment<T>(projectId: string, input: Record<string, unknown>, action: () => Promise<T>) {
    const key = `${projectId}\n${String(input.developmentId)}`;
    const next = (developmentQueues.get(key) ?? Promise.resolve()).then(action, action);
    const settled = next.then(
      () => undefined,
      () => undefined
    );
    developmentQueues.set(key, settled);
    void settled.then(() => {
      if (developmentQueues.get(key) === settled) developmentQueues.delete(key);
    });
    return next;
  }

  function startReview(projectId: string, taskId: string | undefined, input: Record<string, unknown>) {
    return inDevelopment(projectId, input, () => startReviewNow(projectId, taskId, input));
  }

  async function startReviewNow(
    projectId: string,
    taskId: string | undefined,
    input: Record<string, unknown>
  ): Promise<DevelopmentReview> {
    const developmentId = developmentIdentifier(input.developmentId, "开发记录 ID");
    const record = await openDevelopment(projectId, developmentId);
    const final = input.ticketId === undefined && record.route === "full";
    if (input.mapping !== undefined && !final)
      throw conflict("只有 full 路线的整体终审带对照表", "review_mapping_unexpected");
    if (input.ticketId !== undefined) return startTicketReview(projectId, taskId, record, input);
    if (final) return startFinalReview(projectId, record, input);
    if (ticketRoute(record))
      throw conflict(
        `${record.route} 路线按票审查：freeze_candidate 须带 ticketId，审查票自己的现场`,
        "ticket_required"
      );
    const kind = reviewKind(input.kind);
    const service = await gateway();
    const plan = await service.reviewPlan(projectId, developmentId);
    if (!plan) throw conflict("先记录审查通道（review_plan），再冻结候选", "review_plan_missing");
    if (plan.channel === "self")
      throw conflict("当前通道是不含独立审查的 self；先明确改变通道再冻结候选", "review_channel_mismatch");
    if (kind === "combined" && plan.channel !== "combined")
      throw conflict("组合审查须先把通道改为 combined", "review_channel_mismatch");
    const candidate = await currentCandidate(record);
    let author: DevelopmentReview["author"];
    let previous: DevelopmentReview | undefined;
    let changedPaths: string[] = [];
    // The round limit comes first: past it, another rework of the same kind is not the next step.
    const reviews = await service.queryReviews(projectId, developmentId);
    checkRound(reviews, []);
    previous = previousRound(reviews, input.previousReviewId, candidate.commit);
    if (previous) {
      changedPaths = (
        await git(record.workspace!.directory, [
          "diff",
          "--name-only",
          `${previous.candidate.commit}..${candidate.commit}`
        ])
      )
        .split("\n")
        .filter(Boolean)
        .slice(0, 200);
      const pending = previous.findings.filter((finding) => finding.state === "fix_claimed");
      if (previous.author && pending.length) {
        const covered = new Set(previous.reworks.flatMap((rework) => rework.findingIds));
        const missing = pending.filter((finding) => !covered.has(finding.findingId));
        if (missing.length)
          throw conflict(
            `发现 ${missing.map((finding) => finding.findingId).join("、")} 还没有记录原上下文返修`,
            "review_rework_missing"
          );
        const rework = previous.reworks.at(-1);
        if (rework)
          author = {
            role: "executor",
            callId: rework.continuationCallId,
            agentId: rework.agentId,
            workspace: rework.workspace
          };
      }
    }
    if (!author && input.authorCallId !== undefined) {
      const fact = await requireCall(taskId, input.authorCallId);
      if (fact.role !== "executor" || fact.developmentId !== developmentId || !fact.workspace)
        throw conflict("候选执行工作项不是该需求下的 Executor 现场", "review_author_invalid");
      author = { role: "executor", callId: fact.callId, agentId: fact.agentId, workspace: fact.workspace };
    }
    return service.createReview(projectId, developmentId, {
      kind,
      candidate,
      ...(author ? { author } : {}),
      ...(previous
        ? {
            previousReviewId: previous.reviewId,
            previousCandidateCommit: previous.candidate.commit,
            changedPaths
          }
        : {})
    });
  }

  async function attachReviewer(
    projectId: string,
    taskId: string | undefined,
    input: Record<string, unknown>
  ): Promise<DevelopmentReview> {
    const service = await gateway();
    const reviewId = developmentIdentifier(input.reviewId, "审查 ID");
    const review = await service.getReview(projectId, reviewId);
    if (review.state !== "in_review")
      throw conflict(`审查已经是 ${review.state}，不能再绑定会话`, "review_closed");
    const fact = await requireCall(taskId, input.callId);
    if (fact.role !== "reviewer")
      throw conflict("该工作项不是 Reviewer，不能记为独立审查", "review_reviewer_role");
    if (fact.developmentId !== review.developmentId)
      throw conflict("审查工作项不属于这个需求的现场", "review_development_mismatch");
    if (fact.status === "failed" || fact.status === "cancelled")
      throw conflict(`审查工作项已 ${fact.status}，没有有效结论`, "review_reviewer_terminal");
    // A Reviewer is bound only once it has finished, together with its
    // conclusion: one that breaks the review's rules is never bound, so another
    // Reviewer can still take the review.
    if (fact.status !== "completed")
      throw conflict(
        `Reviewer ${fact.callId} 还没有结束（${fact.status}）；等它交回结论再绑定`,
        "review_reviewer_running"
      );
    if (!fact.workspace) throw conflict("审查工作项没有独立现场", "review_site_missing");
    const development = await service.getDevelopment(projectId, review.developmentId, ports.backendId);
    if (!development.workspace)
      throw conflict("开发记录没有就绪的本机现场；先 ensure_workspace", "review_workspace_not_ready");
    // The Coordinator derives a work item's site beside its integration
    // checkout; any other directory is not that item's own site.
    const derived = join(dirname(development.workspace.directory), "work-items", fact.callId);
    if (resolve(fact.workspace) !== resolve(derived))
      throw conflict(`审查现场不是工作项 ${fact.callId} 自己的现场`, "review_site_mismatch");
    if (review.reviewer) {
      // A review belongs to the session that was bound first. The same call is
      // a safe retry; another Reviewer must use its own review record instead of
      // silently inheriting the findings and evidence already recorded here.
      if (review.reviewer.callId === fact.callId) return review;
      throw conflict(
        `审查已绑定 Reviewer ${review.reviewer.callId}；新的 Reviewer 须使用独立审查记录`,
        "review_reviewer_bound"
      );
    }
    if (review.author && (review.author.callId === fact.callId || review.author.agentId === fact.agentId))
      throw conflict("审查会话与执行身份相同，不能记为独立审查", "review_not_independent");
    const site = await readReviewSite(fact.workspace);
    if (!site) throw conflict("审查工作项现场不可读", "review_site_unavailable");
    const reason = driftReason(site, review.candidate);
    if (reason) {
      // The review cannot bind this checkout, so it is not evidence for any
      // verdict: record the drift first, then release the site.
      await markDrifted(projectId, review, reason);
      await releaseSite(review, derived);
      throw conflict(reason, "review_drifted");
    }
    if (fact.review) await checkedConclusion(projectId, review, fact.review);
    const bound = await service.updateReview(projectId, reviewId, {
      expectedRevision: review.revision,
      reviewer: {
        role: "reviewer",
        taskId: taskId!,
        callId: fact.callId,
        agentId: fact.agentId,
        workspace: derived
      }
    });
    return fact.review ? importConclusion(projectId, bound, fact.review) : bound;
  }

  async function recordFinding(
    projectId: string,
    input: Record<string, unknown>
  ): Promise<DevelopmentReview> {
    const service = await gateway();
    const reviewId = developmentIdentifier(input.reviewId, "审查 ID");
    const review = await service.getReview(projectId, reviewId);
    if (review.state !== "in_review") throw conflict("审查已结束，不能再追加发现", "review_closed");
    if (!review.reviewer) throw conflict("还没有绑定独立审查会话", "review_reviewer_missing");
    if (review.reviewer.conclusion)
      throw conflict("Reviewer 的结论已由程序导入审查记录；不要再手抄发现", "review_conclusion_imported");
    const fact = ports.call ? await ports.call(review.reviewer.taskId, review.reviewer.callId) : undefined;
    if (fact?.review)
      throw conflict(
        "Reviewer 交回了结构化结论；用 attach_reviewer 导入，不要手抄",
        "review_conclusion_imported"
      );
    const parsed = reviewFindingInput(input);
    // A custom Reviewer answers in prose, so Main records what it found under
    // the same rule: a blocking finding cites a criterion or a floor class.
    const { scope } = await reviewScopeOf(projectId, review);
    const check = parseReviewConclusion(
      {
        verdict: parsed.blocking ? "changes_requested" : "pass",
        findings: [
          {
            title: parsed.title,
            location: parsed.location ?? "-",
            evidence: parsed.detail,
            blocking: parsed.blocking,
            ...(parsed.basis ? { basis: parsed.basis } : {})
          }
        ]
      },
      { criteria: scope.criteria }
    );
    if (!check.ok) throw conflict(check.errors.join("；"), "review_finding_basis");
    const timestamp = now();
    const finding: ReviewFinding = {
      findingId: id("finding"),
      title: parsed.title,
      detail: parsed.detail,
      ...(parsed.location ? { location: parsed.location } : {}),
      blocking: parsed.blocking,
      ...(parsed.blocking && parsed.basis ? { basis: parsed.basis } : {}),
      candidateCommit: review.candidate.commit,
      state: parsed.blocking ? "open" : "suggestion",
      checks: parsed.checks,
      ...(parsed.rawFailure ? { rawFailure: parsed.rawFailure } : {}),
      source: {
        role: "reviewer",
        callId: review.reviewer.callId,
        agentId: review.reviewer.agentId
      },
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return service.updateReview(projectId, reviewId, {
      expectedRevision: review.revision,
      findings: [...review.findings, finding]
    });
  }

  async function ruleFinding(projectId: string, input: Record<string, unknown>): Promise<DevelopmentReview> {
    const service = await gateway();
    const reviewId = developmentIdentifier(input.reviewId, "审查 ID");
    const review = await service.getReview(projectId, reviewId);
    // A failed or drifted review is terminal for its verdict, not for the
    // findings it recorded: Main still has to rule them so a repair or a
    // reasoned dismissal can settle them later.
    if (review.state === "passed") throw conflict("审查已通过，不能再裁定", "review_closed");
    const findingId = developmentIdentifier(input.findingId, "发现 ID");
    const decision = rulingDecision(input.decision);
    const category = decision === "dismiss" ? dismissalCategory(input.category) : undefined;
    if (decision === "dismiss" && !category)
      throw conflict("不采纳的裁定须记录原因类别", "review_ruling_category");
    const basis = reviewBasis(input.basis);
    const target = review.findings.find((finding) => finding.findingId === findingId);
    if (!target) throw new ProjectDataNotFoundError("审查发现不存在");
    // A suggestion blocks nothing, so Main only picks it up to fix; a claimed fix
    // of a failed review may still be given up with a recorded dismissal.
    const rulable =
      target.state === "open" ||
      (target.state === "suggestion" && decision === "fix") ||
      (target.state === "fix_claimed" && decision === "dismiss" && review.state === "failed");
    if (!rulable)
      throw conflict(
        target.state === "suggestion"
          ? `发现 ${findingId} 是建议，不拦截，不需要放行`
          : `发现 ${findingId} 已有裁定`,
        "review_finding_ruled"
      );
    const timestamp = now();
    const findings = review.findings.map((finding) =>
      finding.findingId === findingId
        ? {
            ...finding,
            state: decision === "fix" ? ("fix_claimed" as const) : ("dismissed" as const),
            ruling: {
              rulingId: id("ruling"),
              decision,
              ...(category ? { category } : {}),
              basis,
              candidateCommit: review.candidate.commit,
              at: timestamp
            },
            updatedAt: timestamp
          }
        : finding
    );
    return service.updateReview(projectId, reviewId, {
      expectedRevision: review.revision,
      findings
    });
  }

  async function recordRework(
    projectId: string,
    taskId: string | undefined,
    input: Record<string, unknown>
  ): Promise<DevelopmentReview> {
    const service = await gateway();
    const reviewId = developmentIdentifier(input.reviewId, "审查 ID");
    const review = await service.getReview(projectId, reviewId);
    if (review.state === "passed") throw conflict("审查已通过，不能记录返修", "review_closed");
    const from = await requireCall(taskId, input.fromCallId);
    const continuation = await requireCall(taskId, input.continuationCallId);
    if (from.role !== "executor" || continuation.role !== "executor")
      throw conflict("返修须由 Executor 工作项执行", "review_rework_role");
    if (from.developmentId !== review.developmentId || continuation.developmentId !== review.developmentId)
      throw conflict("返修工作项不属于这个需求的现场", "review_development_mismatch");
    if (continuation.continuationFrom !== from.callId)
      throw conflict("返修工作项不是从原执行工作项续接的", "review_rework_not_continuation");
    if (continuation.agentId !== from.agentId)
      throw conflict("返修没有复用原执行身份", "review_rework_identity");
    if (
      !from.workspace ||
      !continuation.workspace ||
      resolve(from.workspace) !== resolve(continuation.workspace)
    )
      throw conflict("返修没有复用原执行现场", "review_rework_site");
    if (continuation.status !== "completed")
      throw conflict(`返修工作项还没有完成（${continuation.status}）`, "review_rework_unfinished");
    if (
      review.author &&
      (from.agentId !== review.author.agentId ||
        resolve(from.workspace ?? "") !== resolve(review.author.workspace))
    )
      throw conflict("返修没有复用候选执行者的原身份与现场", "review_rework_author_mismatch");
    if (review.reworks.some((rework) => rework.continuationCallId === continuation.callId))
      throw conflict("该返修工作项已经记录", "review_rework_duplicate");
    const findingIds = Array.isArray(input.findingIds)
      ? input.findingIds.map((entry) => developmentIdentifier(entry, "返修发现"))
      : [];
    if (!findingIds.length) throw conflict("返修须关联至少一条发现", "review_rework_findings");
    for (const findingId of findingIds) {
      const finding = review.findings.find((entry) => entry.findingId === findingId);
      if (!finding) throw new ProjectDataNotFoundError(`审查发现 ${findingId} 不存在`);
      if (finding.ruling?.decision !== "fix")
        throw conflict(`发现 ${findingId} 没有要求修复的裁定`, "review_rework_ruling");
    }
    const reworks = [
      ...review.reworks,
      {
        fromCallId: from.callId,
        fromAgentId: from.agentId,
        continuationCallId: continuation.callId,
        agentId: continuation.agentId,
        workspace: from.workspace,
        findingIds,
        at: now()
      }
    ];
    return service.updateReview(projectId, reviewId, {
      expectedRevision: review.revision,
      reworks
    });
  }

  /**
   * Settle fix-claimed findings along the explicit previousReview chain.
   *
   * A passing review verifies the whole chain it descends from, not just its
   * immediate predecessor. Each finding is settled at the first review on that
   * chain created after its fix evidence (the recorded rework, or the ruling
   * when Main repaired directly), so a long rework keeps the candidate that
   * actually carried the repair. Findings outside the chain are not touched.
   */
  async function settleLinkedFindings(
    projectId: string,
    passed: DevelopmentReview,
    service: ProjectDataGateway
  ): Promise<void> {
    const all = await service.queryReviews(projectId, passed.developmentId);
    const byId = new Map(all.map((entry) => [entry.reviewId, entry] as const));
    const chain: DevelopmentReview[] = [passed];
    const seen = new Set([passed.reviewId]);
    let parentId = passed.previousReviewId;
    while (parentId && !seen.has(parentId)) {
      const parent = byId.get(parentId) ?? (await service.getReview(projectId, parentId));
      chain.unshift(parent);
      seen.add(parentId);
      parentId = parent.previousReviewId;
    }
    const timestamp = now();
    for (let index = 0; index < chain.length - 1; index += 1) {
      const parent = chain[index];
      if (!parent.findings.some((finding) => finding.state === "fix_claimed")) continue;
      const evidenceAt = new Map<string, string>();
      for (const rework of parent.reworks)
        for (const findingId of rework.findingIds) evidenceAt.set(findingId, rework.at);
      const findings = parent.findings.map((finding) => {
        if (finding.state !== "fix_claimed") return finding;
        const since = evidenceAt.get(finding.findingId) ?? finding.ruling?.at ?? finding.updatedAt;
        const carrier = chain.slice(index + 1).find((candidate) => candidate.createdAt >= since);
        if (!carrier) return finding;
        return {
          ...finding,
          state: "fixed" as const,
          fixedCommit: carrier.candidate.commit,
          verifiedByReviewId: passed.reviewId,
          updatedAt: timestamp
        };
      });
      await service.updateReview(projectId, parent.reviewId, {
        expectedRevision: parent.revision,
        findings
      });
    }
  }

  async function completeReview(
    projectId: string,
    input: Record<string, unknown>
  ): Promise<DevelopmentReview> {
    const service = await gateway();
    const reviewId = developmentIdentifier(input.reviewId, "审查 ID");
    const review = await service.getReview(projectId, reviewId);
    if (review.state !== "in_review") throw conflict("审查已经结束", "review_closed");
    if (!review.reviewer) throw conflict("还没有绑定独立审查会话", "review_reviewer_missing");
    const reviewer = review.reviewer;
    const verdict = reviewVerdict({ summary: input.summary, checks: input.checks });
    if (input.verdict !== "passed" && input.verdict !== "failed")
      throw conflict("审查结论须为 passed / failed", "review_verdict_invalid");
    const site = await readReviewSite(reviewer.workspace);
    if (!site) {
      const reason = `审查现场 ${reviewer.workspace} 不可读`;
      await markDrifted(projectId, review, reason);
      throw conflict(reason, "review_drifted");
    }
    const reason = driftReason(site, review.candidate);
    if (reason) {
      await markDrifted(projectId, review, reason);
      throw conflict(reason, "review_drifted");
    }
    if (input.verdict === "passed") {
      if (verdict.checks.length === 0) throw conflict("通过审查须记录检查回执", "review_checks_missing");
      const unresolved = review.findings.filter(
        (finding) => finding.state === "open" || finding.state === "fix_claimed"
      );
      if (unresolved.length)
        throw conflict(
          `发现 ${unresolved.map((finding) => finding.findingId).join("、")} 拦着这次审查：裁定不修并写理由，或修复后复审新候选`,
          "review_findings_open"
        );
    }
    if (input.verdict === "passed" && review.previousReviewId)
      await settleLinkedFindings(projectId, review, service);
    const completed = await service.updateReview(projectId, reviewId, {
      expectedRevision: review.revision,
      state: input.verdict === "passed" ? "passed" : "failed",
      verdict
    });
    await ticketVerdict(projectId, completed, input.verdict === "passed");
    return completed;
  }

  async function deliveryQualification(
    projectId: string,
    developmentIdValue: unknown
  ): Promise<ReviewQualification> {
    const record = await reviewDevelopment(projectId, developmentIdValue);
    const service = await gateway();
    const developmentId = record.developmentId;
    const plan = await service.reviewPlan(projectId, developmentId);
    const reviews = await service.queryReviews(projectId, developmentId);
    const current = await inspectWorkspace(record);
    const qualification: ReviewQualification = {
      developmentId,
      eligible: false,
      ...(plan ? { channel: plan.channel } : {}),
      candidate: {
        commit: current.commit,
        tree: current.tree,
        branch: current.branch,
        workspace: current.workspace
      },
      independentReview: false,
      reasons: []
    };
    const reasons: string[] = [];
    const latest = reviews.at(-1);
    // The approved version still stands when the checkout is that version, or
    // that version plus the retro's commit that touches only the pitfalls.
    const carries = async (approved: { commit: string; tree: string }) => {
      if (approved.commit === current.commit && approved.tree === current.tree) return true;
      if (current.changes) return false;
      const extended = await onlyChangesUnder(
        record.workspace!.directory,
        approved.commit,
        current.commit,
        PITFALLS_DIRECTORY
      );
      if (extended) qualification.pitfallsAfterApproval = true;
      return extended;
    };
    const approvedAs = (approved: { commit: string; tree: string }): ReviewCandidate => ({
      ...qualification.candidate!,
      commit: approved.commit,
      tree: approved.tree
    });
    if (ticketRoute(record)) {
      // Each ticket was reviewed on its own checkout and brought in by the
      // program; the version to deliver is the last one it produced.
      const { tickets } = await service.tickets(projectId, developmentId);
      if (!tickets.length) reasons.push("tickets_missing");
      if (tickets.some((ticket) => ticket.state !== "merged")) reasons.push("tickets_pending");
      const last = lastIntegration(tickets);
      qualification.channel = "independent";
      qualification.independentReview = tickets.length > 0;
      if (last && !(await carries(last))) reasons.push("candidate_changed");
      // The full route also needs a passed review of the whole requirement on this version.
      if (record.route === "full" && !reasons.length) {
        const final = finalReviews(tickets, reviews).at(-1);
        if (!final) reasons.push("final_review_missing");
        else {
          qualification.reviewId = final.reviewId;
          qualification.independentReview = Boolean(final.reviewer);
          if (!reviewApproved(final)) reasons.push(`review_${final.state}`);
          else if (!(await carries(final.candidate))) reasons.push("candidate_changed");
        }
      }
      if (last && !reasons.length) qualification.approved = approvedAs(last);
    } else if (!plan) reasons.push("review_plan_missing");
    else if (plan.channel === "self") {
      const aligned = await carries(plan.candidate);
      if (!aligned) reasons.push("self_check_stale");
      if (reviews.length > 0) reasons.push("review_started");
      if (plan.checks.length === 0) reasons.push("review_checks_missing");
      if (aligned && reviews.length === 0) qualification.approved = plan.candidate;
    } else {
      if (!latest) reasons.push("review_missing");
      else {
        qualification.reviewId = latest.reviewId;
        qualification.kind = latest.kind;
        qualification.independentReview = Boolean(latest.reviewer);
        if (!reviewApproved(latest)) reasons.push(`review_${latest.state}`);
        else {
          qualification.approved = latest.candidate;
          if (plan.channel === "combined" && latest.kind !== "combined") reasons.push("review_kind_mismatch");
          if (!(await carries(latest.candidate))) reasons.push("candidate_changed");
        }
      }
    }
    if (current.changes) reasons.push("candidate_workspace_dirty");
    const unresolved = reviews
      .flatMap((review) => review.findings)
      .filter((finding) => finding.state === "open" || finding.state === "fix_claimed");
    if (unresolved.length) reasons.push("findings_open");
    qualification.reasons = [...new Set(reasons)];
    qualification.eligible = qualification.reasons.length === 0;
    return qualification;
  }

  /** The next step for one development, worked out from its stored records. */
  async function nextStep(
    projectId: string,
    developmentIdValue: unknown,
    snapshot?: { record: DevelopmentRecord; tickets: TicketSet }
  ): Promise<string> {
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    const service = await gateway();
    const record =
      snapshot?.record ?? (await service.getDevelopment(projectId, developmentId, ports.backendId));
    const workspaceReady = record.workspace?.state === "ready";
    const [tickets, reviews, merges, deliveries] = await Promise.all([
      snapshot?.tickets ?? service.tickets(projectId, developmentId),
      service.queryReviews(projectId, developmentId),
      service.queryMerges(projectId, developmentId),
      service.queryDeliveries(projectId, developmentId)
    ]);
    const review = reviews.at(-1);
    const final = record.route === "full" ? finalReviews(tickets.tickets, reviews).at(-1) : undefined;
    const merge = merges.at(-1);
    // A failed review whose chain used its rounds and has no change of approach yet.
    const atLimit = (chain: DevelopmentReview[]) => {
      const budget = roundBudget(chain);
      return budget.failed >= budget.limit && !chain.at(-1)?.verdict?.approach;
    };
    const fact = (entry: DevelopmentReview, chain: DevelopmentReview[]) => ({
      reviewId: entry.reviewId,
      state: entry.state,
      reviewer: Boolean(entry.reviewer),
      ...(entry.state === "failed" && atLimit(chain) ? { atLimit: true } : {})
    });
    const ticketsAtLimit = tickets.tickets.flatMap((ticket) => {
      const chain = chainOf(tickets.tickets, reviews, ticket);
      return ticket.state === "rework" && chain.at(-1)?.state === "failed" && atLimit(chain)
        ? [{ ticketId: ticket.ticketId, reviewId: chain.at(-1)!.reviewId }]
        : [];
    });
    return developmentNext({
      route: record.route,
      workspaceReady,
      tickets: tickets.tickets,
      ...(final ? { finalReview: fact(final, finalReviews(tickets.tickets, reviews)) } : {}),
      ...(ticketsAtLimit.length ? { ticketsAtLimit } : {}),
      ...(workspaceReady ? { qualification: await deliveryQualification(projectId, developmentId) } : {}),
      ...(review ? { review: fact(review, record.route === "quick" ? reviews : [review]) } : {}),
      ...(merge
        ? {
            merge: {
              mergeId: merge.mergeId,
              state: merge.state,
              ...(merge.detail ? { detail: merge.detail } : {}),
              ...(merge.mergeCommit ? { mergeCommit: merge.mergeCommit } : {})
            }
          }
        : {}),
      ...(deliveries.length ? { delivery: { state: deliveries.at(-1)!.state } } : {}),
      ...(merge?.state === "merged" ? { mergedSinceTidy: (await service.tidyLedger(projectId)).merged } : {}),
      retro: {
        signals: retroSignals(reviews, merges),
        recorded: merges.some((entry) => entry.acceptance.retro && !entry.acceptance.retro.auto),
        improvements: merges.flatMap((entry) => entry.acceptance.retro?.improvements ?? [])
      },
      ledgerRecorded: merges.some((entry) => entry.acceptance.ledger)
    });
  }

  // ---- project merge entry ---------------------------------------------------
  // Every Main applies here; the configured execution backend claims one
  // operation at a time and updates the target. The operation row is the
  // persistent identity a later process reconciles against real Git facts, so a
  // crash between "target updated" and "record written" cannot merge twice.

  const startedAt = ports.startedAt ?? "unidentified";
  const mergeAttempts = 3;
  const projectQueues = new Map<string, Promise<unknown>>();

  /** One project queue per process; the shared row is the cross-process lock. */
  function serialized<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const previous = projectQueues.get(projectId) ?? Promise.resolve();
    const next = previous.then(action, action);
    projectQueues.set(
      projectId,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }

  const mergeSite = (mergeId: string) => join(ports.developmentRoot, "merges", mergeId);

  function parseMergeFault(value: string | undefined): { mergeId?: string } | undefined {
    if (!value) return undefined;
    const match = value.match(/^crash:(.+)@after-apply$/);
    if (!match) return undefined;
    return match[1] === "*" ? {} : { mergeId: match[1] };
  }

  function afterApply(merge: DevelopmentMerge): void {
    const fault = parseMergeFault(ports.mergeFaultInject);
    if (!fault) return;
    if (fault.mergeId && fault.mergeId !== merge.mergeId) return;
    // The target is already updated; nothing after this point can run. A real
    // kill, so recovery has to reconcile the record against Git.
    process.kill(process.pid, "SIGKILL");
  }

  /**
   * Checks the requester did not name fall back to the commands its self plan or
   * passed review actually ran, so the combined version is verified with the
   * same relevant checks rather than an empty list.
   */
  async function recordedMergeChecks(
    service: ProjectDataGateway,
    projectId: string,
    developmentId: string
  ): Promise<MergeCheck[]> {
    const { tickets } = await service.tickets(projectId, developmentId);
    if (tickets.length) {
      // The checks that passed when each ticket was brought in, once each.
      const seen = new Set<string>();
      return tickets
        .flatMap((ticket) => ticket.integration?.checks ?? [])
        .filter((check) => !seen.has(check.command) && Boolean(seen.add(check.command)))
        .map((check) => ({ name: check.name, command: check.command }));
    }
    const plan = await service.reviewPlan(projectId, developmentId);
    const reviews = await service.queryReviews(projectId, developmentId);
    const commands = (checks: { name: string; command?: string }[]): MergeCheck[] =>
      checks
        .filter((check): check is { name: string; command: string } => Boolean(check.command))
        .map((check) => ({ name: check.name, command: check.command }));
    const fromPlan = commands(plan?.checks ?? []);
    if (fromPlan.length) return fromPlan;
    return commands(reviews.at(-1)?.verdict?.checks ?? []);
  }

  /**
   * Re-check the accepted version without reading the requester's checkout.
   *
   * The execution backend may be another host, so it verifies the shared facts
   * the request was qualified against: the same self-check version with no
   * review started, or the same passed review with every finding settled. A
   * later pass on a different candidate therefore does not approve this one.
   */
  async function acceptanceReasons(projectId: string, merge: DevelopmentMerge): Promise<string[]> {
    const service = await gateway();
    const plan = await service.reviewPlan(projectId, merge.developmentId);
    const reviews = await service.queryReviews(projectId, merge.developmentId);
    const reasons: string[] = [];
    const approved = { commit: merge.acceptance.approvedCommit, tree: merge.acceptance.approvedTree };
    if (merge.acceptance.tickets) {
      const { tickets } = await service.tickets(projectId, merge.developmentId);
      if (!tickets.length || tickets.some((ticket) => ticket.state !== "merged"))
        reasons.push("tickets_pending");
      const last = lastIntegration(tickets);
      if (last?.commit !== approved.commit) reasons.push("candidate_changed");
      const record = await service.getDevelopment(projectId, merge.developmentId, ports.backendId);
      if (record.route === "full") {
        const final = finalReviews(tickets, reviews).find(
          (entry) => entry.reviewId === merge.acceptance.reviewId
        );
        if (!final) reasons.push("final_review_missing");
        else {
          if (!reviewApproved(final)) reasons.push(`review_${final.state}`);
          if (final.candidate.commit !== approved.commit) reasons.push("candidate_changed");
        }
      }
      const unresolved = reviews
        .flatMap((entry) => entry.findings)
        .filter((finding) => finding.state === "open" || finding.state === "fix_claimed");
      if (unresolved.length) reasons.push("findings_open");
    } else if (merge.acceptance.channel === "self") {
      if (!plan || plan.channel !== "self") reasons.push("review_plan_missing");
      else {
        if (plan.candidate.commit !== approved.commit || plan.candidate.tree !== approved.tree)
          reasons.push("candidate_changed");
        if (!plan.checks.length) reasons.push("review_checks_missing");
      }
      if (reviews.length) reasons.push("review_started");
    } else {
      const review = merge.acceptance.reviewId
        ? reviews.find((entry) => entry.reviewId === merge.acceptance.reviewId)
        : undefined;
      if (!review) reasons.push("review_missing");
      else {
        if (!reviewApproved(review)) reasons.push(`review_${review.state}`);
        if (review.candidate.commit !== approved.commit) reasons.push("candidate_changed");
        if (merge.acceptance.channel === "combined" && review.kind !== "combined")
          reasons.push("review_kind_mismatch");
      }
      const unresolved = reviews
        .flatMap((entry) => entry.findings)
        .filter((finding) => finding.state === "open" || finding.state === "fix_claimed");
      if (unresolved.length) reasons.push("findings_open");
    }
    // The candidate is the approved version, or that version plus the retro's
    // commit that touches only the pitfalls.
    if (approved.commit !== merge.candidate.commit || approved.tree !== merge.candidate.tree) {
      const { repository } = await requiredMergeConfig(projectId);
      const extended =
        merge.acceptance.retro?.outcome === "pitfalls" &&
        (await onlyChangesUnder(repository, approved.commit, merge.candidate.commit, PITFALLS_DIRECTORY));
      if (!extended) reasons.push("candidate_changed");
    }
    if (!merge.acceptance.retro) reasons.push("retro_missing");
    return [...new Set(reasons)];
  }

  /**
   * The requirement's retro, done once before its last merge. Main hands in the
   * pitfalls it wrote or why there are none, and any environment improvements;
   * with every signal at zero the program records "nothing" itself. A retro
   * Main did on an earlier attempt is kept, so a retried merge does not ask again.
   */
  async function requirementRetro(
    projectId: string,
    record: DevelopmentRecord,
    value: unknown,
    /** The approved version and the candidate on top of it, when only the pitfalls changed in between. */
    pitfallsCommitted: { approved: string; candidate: string } | undefined
  ): Promise<{ retro: MergeRetro; improvements: RetroInput["improvements"] }> {
    const service = await gateway();
    const [reviews, merges] = await Promise.all([
      service.queryReviews(projectId, record.developmentId),
      service.queryMerges(projectId, record.developmentId)
    ]);
    const signals = retroSignals(reviews, merges);
    const given = retroInput(value);
    // Only a retro Main did carries over; the program's own "nothing" is judged again,
    // because a merge that then failed is itself a signal.
    const earlier = [...merges]
      .reverse()
      .find((merge) => merge.acceptance.retro && !merge.acceptance.retro.auto)?.acceptance.retro;
    const retro: MergeRetro | undefined = given
      ? { outcome: given.outcome, summary: given.summary, signals, at: now() }
      : earlier
        ? earlier
        : hasRetroSignals(signals)
          ? undefined
          : { outcome: "nothing", summary: "没有信号", signals, auto: true, at: now() };
    if (!retro)
      throw conflict(
        `合入前先复盘这个需求：返修 ${signals.reworkRounds} 轮、换办法 ${signals.changedApproach} 次、放行拦截发现 ${signals.dismissedBlocking} 条、合入失败 ${signals.failedMerges} 次。把这个仓库的坑写进 ${PITFALLS_DIRECTORY}（提交在验收版本之上，只改这个目录），再用 retro.pitfalls 说明写了哪些；没有要记的，用 retro.nothing 说明为什么`,
        "retro_missing"
      );
    if (pitfallsCommitted && retro.outcome !== "pitfalls")
      throw conflict(
        `候选在验收版本之上改了 ${PITFALLS_DIRECTORY}；用 retro.pitfalls 说明写了哪些坑点`,
        "retro_mismatch"
      );
    if (!pitfallsCommitted && retro.outcome === "pitfalls")
      throw conflict(
        `retro.pitfalls 说写了坑点，但候选在验收版本之上没有只改 ${PITFALLS_DIRECTORY} 的提交`,
        "retro_mismatch"
      );
    if (pitfallsCommitted) {
      const directory = record.workspace!.directory;
      const problems = pitfallProblems(
        await changedPagesUnder(
          directory,
          pitfallsCommitted.approved,
          pitfallsCommitted.candidate,
          PITFALLS_DIRECTORY
        ),
        await fileAt(directory, pitfallsCommitted.candidate, `${PITFALLS_DIRECTORY}${PITFALLS_INDEX_PAGE}`)
      );
      if (problems.length)
        throw conflict(`坑点格式不符，改好后重新提交：${problems.join("；")}`, "pitfalls_malformed");
    }
    const improvements = given?.improvements ?? [];
    // An improvement a retro registered does not register further improvements:
    // its own retro keeps pitfalls only, so retros cannot feed each other.
    if (
      improvements.length &&
      (await service.getRequirement(projectId, record.requirementId)).source.reference?.startsWith(
        retroSourceReference("")
      )
    )
      throw conflict(
        "这个需求本身是复盘登记的环境改进，它的复盘不能再登记改进；去掉 retro.improvements",
        "retro_improvement_nested"
      );
    // Titles an earlier attempt of this requirement already registered stay registered once.
    const registered = new Set(
      merges.flatMap((merge) => merge.acceptance.retro?.improvements ?? []).map((item) => item.title)
    );
    return { retro, improvements: improvements.filter((item) => !registered.has(item.title)) };
  }

  /**
   * The project's document registry at the requirement checkout, checked before
   * its final review as Workloop does: present, and holding every document this
   * requirement added, or every document when this requirement builds it. A fix
   * is a fix ticket, so the final review covers it.
   */
  async function requireRegistry(record: DevelopmentRecord, candidate: string): Promise<void> {
    const directory = record.workspace!.directory;
    const base = record.workspace!.baseCommit;
    const registry = await fileAt(directory, candidate, REGISTRY_FILE);
    const documents = await documentsAt(directory, candidate);
    const before = registryProblems(
      await fileAt(directory, base, REGISTRY_FILE),
      await documentsAt(directory, base),
      []
    );
    // Building the table checks all of it; otherwise only what this requirement brought.
    const problems = before.missing
      ? registryProblems(registry, documents, documents)
      : problemsSince(
          registryProblems(registry, documents, await documentsAdded(directory, base, candidate)),
          before
        );
    if (!hasRegistryProblems(problems)) return;
    const fix = "用一张修复票（propose_tickets）改好，并入后再冻结整体终审";
    if (problems.missing)
      throw conflict(
        `这个项目还没有文档登记表：加载 tidy-docs 技能，在 ${REGISTRY_FILE} 里建“文档”表，把现有文档逐一登记，只登记、不删改；${fix}`,
        "documents_registry_missing"
      );
    const parts = [
      problems.malformed.length ? `格式不对：${problems.malformed.join("；")}` : "",
      problems.unregistered.length ? `没有登记：${problems.unregistered.join("、")}` : "",
      problems.stale.length ? `指向的文档已不存在：${problems.stale.join("、")}` : "",
      problems.duplicates.length ? `同类同领域只许一份：${problems.duplicates.join("；")}` : ""
    ].filter(Boolean);
    throw conflict(
      `文档登记表不符（规则见 tidy-docs 技能）：${parts.join("。")}。过程文档（计划、进度、交接）删掉，正式文档登记或并进同类同领域的那份；${fix}`,
      "documents_unregistered"
    );
  }

  /**
   * What the requirement's ledger says once this development is merged: Main
   * hands it in with the merge request, as it does the retro, and an earlier
   * attempt's update carries over to a retry. It is written to the requirement
   * only when the delivery is recorded, so a merge that never lands changes nothing.
   */
  async function requirementLedgerUpdate(
    projectId: string,
    record: DevelopmentRecord,
    value: unknown
  ): Promise<MergeLedgerUpdate> {
    const service = await gateway();
    const given = ledgerUpdateInput(value);
    const update =
      given ??
      [...(await service.queryMerges(projectId, record.developmentId))]
        .reverse()
        .find((merge) => merge.acceptance.ledger)?.acceptance.ledger;
    if (!update)
      throw conflict(
        "合入前更新这条需求的台账：用 ledger.summary 把现状改写成这块功能现在的样子和规矩（没有变化就用 ledger.summaryUnchanged 写明理由），ledger.history 写一行这次改了什么；功能有了大的变动（做的事、服务的人或范围变了）时用 ledger.description 写新的功能描述，否则写 ledger.descriptionUnchanged: true",
        "ledger_update_missing"
      );
    if (
      update.description !== undefined &&
      (await service.getRequirement(projectId, record.requirementId)).kind === "misc"
    )
      throw conflict(
        "杂项需求的功能描述是固定的；改用 ledger.descriptionUnchanged: true",
        "requirement_misc_fixed"
      );
    return update;
  }

  /** Register a retro's environment improvements as ledger requirements. */
  async function registerImprovements(
    projectId: string,
    requirementId: string,
    improvements: RetroInput["improvements"]
  ): Promise<RetroImprovement[]> {
    const service = await gateway();
    const registered: RetroImprovement[] = [];
    for (const item of improvements) {
      const requirement = await service.createRequirement(projectId, {
        title: item.title,
        summary: item.content,
        source: { kind: "internal", reference: retroSourceReference(requirementId) }
      });
      registered.push({ requirementId: requirement.requirementId, title: requirement.title });
    }
    return registered;
  }

  async function requestMerge(projectId: string, input: Record<string, unknown>): Promise<DevelopmentMerge> {
    await project(projectId);
    const developmentId = developmentIdentifier(input.developmentId, "开发记录 ID");
    // A closed development still answers a retry of its merged candidate below.
    const record = await reviewDevelopment(projectId, developmentId);
    const config = await requiredMergeConfig(projectId);
    const qualification = await deliveryQualification(projectId, developmentId);
    if (
      !qualification.eligible ||
      !qualification.channel ||
      !qualification.candidate ||
      !qualification.approved
    )
      throw conflict(
        `交付资格还不满足：${qualification.reasons.join("、") || "未通过验收"}`,
        "merge_not_qualified"
      );
    const candidate = qualification.candidate;
    const extended = qualification.pitfallsAfterApproval === true;
    if (
      !extended &&
      (qualification.approved.commit !== candidate.commit || qualification.approved.tree !== candidate.tree)
    )
      throw conflict("验收版本与当前候选不一致；请在当前版本验收后再申请合入", "merge_not_qualified");
    const supplied = input.checks === undefined ? undefined : mergeCheckCommands(input.checks);
    const service = await gateway();
    const { retro, improvements } = await requirementRetro(
      projectId,
      record,
      input.retro,
      extended ? { approved: qualification.approved.commit, candidate: candidate.commit } : undefined
    );
    const ledger = await requirementLedgerUpdate(projectId, record, input.ledger);
    const checks = supplied ?? (await recordedMergeChecks(service, projectId, developmentId));
    if (!checks.length) throw conflict("合入须记录在组合版本上运行的检查命令", "merge_checks_missing");
    const acceptance: MergeAcceptance = {
      channel: qualification.channel,
      approvedCommit: qualification.approved.commit,
      approvedTree: qualification.approved.tree,
      ...(qualification.reviewId ? { reviewId: qualification.reviewId } : {}),
      ...(ticketRoute(record) ? { tickets: true as const } : {}),
      retro,
      ledger
    };
    const existing = await service.queryMerges(projectId, developmentId);
    const open = existing.find(
      (entry) =>
        (entry.state === "waiting" || entry.state === "applying") &&
        entry.candidate.commit === candidate.commit
    );
    if (open) return open;
    // A merged candidate is the same receipt on a retry; a new version needs its
    // own operation instead of inheriting the previous approval.
    const merged = [...existing]
      .reverse()
      .find((entry) => entry.state === "merged" && entry.candidate.commit === candidate.commit);
    if (merged) return merged;
    if (record.status !== "active")
      throw conflict(
        `这次开发已${record.status === "merged" ? "合入" : "撤回"}；同一需求的新工作新建一次开发`,
        "development_closed"
      );
    // Registered only once the merge is about to be recorded, so a refused
    // request leaves no requirement behind.
    if (improvements.length)
      acceptance.retro = {
        ...retro,
        improvements: await registerImprovements(projectId, record.requirementId, improvements)
      };
    const created = await service.createMerge(projectId, developmentId, {
      candidate,
      acceptance,
      checks,
      requestedBy: ports.backendId,
      executionBackendId: config.executionBackendId,
      targetBranch: config.targetBranch
    });
    if (config.executionBackendId !== ports.backendId) return created;
    // The location that owns the target applies its own project queue; another
    // backend's request stays waiting until that location processes it.
    const applied = await applyMerges(projectId);
    return (
      applied.find((entry) => entry.mergeId === created.mergeId) ??
      service.getMerge(projectId, created.mergeId)
    );
  }

  async function executeMerge(
    projectId: string,
    config: MergeConfig,
    merge: DevelopmentMerge
  ): Promise<DevelopmentMerge> {
    const service = await gateway();
    let current = merge;
    const update = (patch: Record<string, unknown>) =>
      service.updateMerge(projectId, current.mergeId, {
        expectedRevision: current.revision,
        ...patch
      });
    try {
      const reasons = await acceptanceReasons(projectId, merge);
      if (reasons.length)
        return await update({
          state: "check_failed",
          reasons,
          detail: "合入前复核验收未通过；旧候选或旧审查不能批准当前版本"
        });
      for (let attempt = 0; attempt < mergeAttempts; attempt += 1) {
        const combined = await mergeCandidate({
          repository: config.repository,
          directory: mergeSite(merge.mergeId),
          targetBranch: merge.targetBranch,
          candidate: merge.candidate.commit
        });
        if (combined.status === "conflict") {
          await removeMergeSite(config.repository, mergeSite(merge.mergeId));
          return await update({
            state: "conflict",
            reasons: [],
            detail: `目标分支与候选存在 Git 冲突：${combined.paths.join("、")}`
          });
        }
        if (combined.status === "failed") {
          await removeMergeSite(config.repository, mergeSite(merge.mergeId));
          return await update({ state: "failed", reasons: [], detail: combined.detail });
        }
        const results = await runMergeChecks(mergeSite(merge.mergeId), merge.checks);
        const failed = results.filter((check) => check.exitCode !== 0);
        if (failed.length) {
          await removeMergeSite(config.repository, mergeSite(merge.mergeId));
          return await update({
            state: "check_failed",
            checks: results,
            reasons: [],
            detail: `组合版本检查未通过：${failed.map((check) => check.name).join("、")}`
          });
        }
        // Persist the combined base, the commit about to be published and the
        // real receipts before the ref moves; that is the recovery identity.
        current = await update({
          checks: results,
          reasons: [],
          detail: null,
          combinedBase: combined.baseCommit,
          expectedTarget: combined.baseCommit,
          mergeCommit: combined.mergeCommit
        });
        const published = await publishMerge({
          repository: config.repository,
          targetBranch: current.targetBranch,
          mergeCommit: combined.mergeCommit,
          expectedTarget: combined.baseCommit
        });
        if (published.status === "moved") {
          await removeMergeSite(config.repository, mergeSite(merge.mergeId));
          current = await update({
            reasons: ["target_moved"],
            combinedBase: null,
            expectedTarget: null,
            mergeCommit: null
          });
          continue;
        }
        if (published.status === "blocked") {
          await removeMergeSite(config.repository, mergeSite(merge.mergeId));
          return await update({
            state: "conflict",
            reasons: ["target_worktree_blocked"],
            detail: published.detail
          });
        }
        // The target now contains this commit. Keep the local fact before any
        // shared write: if the shared store is unreachable, the delivery and
        // the merged record are completed later from this entry and Git.
        const intent = intentOf(current);
        // eslint-disable-next-line no-restricted-syntax -- outbox 只是本机补投线索；写不进去时合入记录与 Git 目标仍表达结果，重放按 Git 对账
        if (intent) await deliveryOutbox.put(intent).catch(() => undefined);
        afterApply(current);
        await removeMergeSite(config.repository, mergeSite(merge.mergeId));
        let merged: DevelopmentMerge;
        try {
          merged = await update({ state: "merged", reasons: [], detail: null });
          // eslint-disable-next-line no-restricted-syntax -- 目标分支已含该提交且 outbox 留住本地事实，共享记录写不进去时返回当前值由补投完成
        } catch {
          // The real Git update is done and the staged row still names it, so
          // the Run is not blocked by a record that cannot be written now.
          return current;
        }
        // The ledger/board are a separate shared write; a failure leaves the
        // delivery pending and visible instead of turning the merge failed.
        // eslint-disable-next-line no-restricted-syntax -- 交付同步是独立的共享写，失败时 outbox 留住待同步条目，合入结果不变成失败
        await syncDelivery(projectId, merged).catch(() => undefined);
        return merged;
      }
      return await update({
        state: "failed",
        reasons: ["target_moved"],
        detail: "目标分支在合入期间持续前移，稍后重新申请合入",
        combinedBase: null,
        expectedTarget: null,
        mergeCommit: null
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failed = await service
        .updateMerge(projectId, merge.mergeId, {
          expectedRevision: current.revision,
          state: "failed",
          reasons: ["merge_failed"],
          detail
        })
        // eslint-disable-next-line no-restricted-syntax -- 合入已失败并抛错，写失败记录写不进去时读取原记录返回，错误已由 Git 与状态表达
        .catch(() => undefined);
      return failed ?? service.getMerge(projectId, merge.mergeId);
    }
  }

  /**
   * Resolve an operation a previous process left `applying`.
   *
   * Its own row says which commit it staged and which target it expected; the
   * actual branch decides what happened. If the target already points at the
   * staged commit, only the record is missing. If the target still equals the
   * expectation, the compare-and-swap never ran, so publishing the same commit
   * is safe. Anything else means the target advanced; the attempt is requeued.
   */
  async function reconcileApplying(
    projectId: string,
    config: MergeConfig,
    merge: DevelopmentMerge
  ): Promise<DevelopmentMerge> {
    const service = await gateway();
    const update = (patch: Record<string, unknown>) =>
      service.updateMerge(projectId, merge.mergeId, {
        expectedRevision: merge.revision,
        ...patch
      });
    try {
      const tip = await targetTip(config.repository, merge.targetBranch);
      if (!tip)
        return await update({
          state: "failed",
          reasons: ["target_missing"],
          detail: `目标分支 ${merge.targetBranch} 不存在`
        });
      // The target may already contain the staged commit: either it moved to
      // exactly that commit, or another update landed on top of it. In both
      // cases only the record is missing, so the same receipt is completed
      // instead of merging the candidate a second time.
      if (merge.mergeCommit && (await isAncestor(config.repository, merge.mergeCommit, tip))) {
        await removeMergeSite(config.repository, mergeSite(merge.mergeId));
        return await update({ state: "merged", reasons: [], detail: null });
      }
      if (merge.mergeCommit && merge.expectedTarget && tip === merge.expectedTarget) {
        const published = await publishMerge({
          repository: config.repository,
          targetBranch: merge.targetBranch,
          mergeCommit: merge.mergeCommit,
          expectedTarget: merge.expectedTarget
        });
        if (published.status === "updated") {
          await removeMergeSite(config.repository, mergeSite(merge.mergeId));
          return await update({ state: "merged", reasons: [], detail: null });
        }
        if (published.status === "blocked") {
          await removeMergeSite(config.repository, mergeSite(merge.mergeId));
          return await update({
            state: "conflict",
            reasons: ["target_worktree_blocked"],
            detail: published.detail
          });
        }
      }
      await removeMergeSite(config.repository, mergeSite(merge.mergeId));
      return await update({
        state: "waiting",
        reasons: ["target_moved"],
        detail: "目标已前移；在最新目标上重新验证组合版本",
        combinedBase: null,
        expectedTarget: null,
        mergeCommit: null
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return await update({
        state: "failed",
        reasons: ["merge_reconcile_failed"],
        detail
        // eslint-disable-next-line no-restricted-syntax -- 对账的失败记录写不进去时返回原记录，目标分支的实际状态仍决定下一次对账
      }).catch(() => merge);
    }
  }

  // ---- delivery synchronization ------------------------------------------------
  // A merge is done when the target branch contains its commit; delivery is a
  // separate shared write. The outbox below keeps that write retryable on the
  // host that published it, so a shared-store outage or restart completes it
  // later without a second development or merge.

  const deliveryReplays = new Map<string, Promise<DevelopmentMerge[]>>();
  const deliveryRecovery = {
    timer: undefined as ReturnType<typeof setInterval> | undefined,
    running: undefined as Promise<void> | undefined,
    stopping: false
  };

  /** Apply one merged operation's receipt to the ledger and board. */
  async function syncDelivery(
    projectId: string,
    merge: DevelopmentMerge
  ): Promise<DevelopmentDelivery | undefined> {
    const receipt = deliveryFromMerge(merge);
    if (!receipt) return undefined;
    try {
      const delivery = await (await gateway()).syncDelivery(projectId, receipt);
      if (delivery.state === "synced")
        // eslint-disable-next-line no-restricted-syntax -- 交付已同步，删不掉本地待投递条目只会让下次重放再确认一次幂等同步
        await deliveryOutbox.remove(projectId, merge.mergeId).catch(() => undefined);
      return delivery;
    } catch (error) {
      await deliveryOutbox
        .fail(projectId, merge.mergeId, error instanceof Error ? error.message : String(error))
        // eslint-disable-next-line no-restricted-syntax -- 记录失败原因写不进去时条目仍是 pending，下次重放会用同一错误重新标记
        .catch(() => undefined);
      throw error;
    }
  }

  /** Retry the latest merged operation of one development from its persisted receipt. */
  async function retryDevelopmentDelivery(
    projectId: string,
    developmentIdValue: unknown
  ): Promise<DevelopmentDelivery> {
    await project(projectId);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    await replayDeliveries(projectId);
    const service = await gateway();
    const merge = [...(await service.queryMerges(projectId, developmentId))]
      .reverse()
      .find((entry) => entry.state === "merged" || entry.state === "applying" || entry.state === "waiting");
    if (!merge || merge.state !== "merged")
      throw conflict("合入尚未完成，稍后重试交付同步", "delivery_not_merged");
    const delivery = await syncDelivery(projectId, merge);
    if (!delivery) throw conflict("该合入没有可同步的回执", "delivery_not_merged");
    return delivery;
  }

  function intentOf(merge: DevelopmentMerge): DeliveryIntent | undefined {
    if (!merge.mergeCommit) return undefined;
    const timestamp = now();
    return {
      projectId: merge.projectId,
      mergeId: merge.mergeId,
      developmentId: merge.developmentId,
      requirementId: merge.requirementId,
      candidateCommit: merge.candidate.commit,
      mergedCommit: merge.mergeCommit,
      targetBranch: merge.targetBranch,
      mergedAt: timestamp,
      ...(merge.expectedTarget ? { expectedTarget: merge.expectedTarget } : {}),
      ...(merge.combinedBase ? { combinedBase: merge.combinedBase } : {}),
      publishedAt: timestamp
    };
  }

  /**
   * Resolve one locally published operation against the shared row and Git.
   *
   * The outbox entry exists only after the target accepted this commit, so a
   * row still `applying` (even when its owner is this process) can be completed
   * from the local fact instead of waiting for a restart. A row that no longer
   * matches is dropped rather than applied to another operation.
   */
  async function resumeDeliveryIntent(
    projectId: string,
    config: MergeConfig | undefined,
    intent: DeliveryIntent
  ): Promise<DevelopmentMerge | undefined> {
    const service = await gateway();
    // eslint-disable-next-line no-restricted-syntax -- 共享存储读不到该合入时按“暂无记录”返回，outbox 条目留到下一次重放
    let merge = await service.getMerge(projectId, intent.mergeId).catch(() => undefined);
    if (!merge) return undefined;
    // The outbox belongs to the backend that published the operation; another
    // backend reading the same data root must not complete or drop it.
    if (merge.executionBackendId !== ports.backendId) return undefined;
    if (merge.state === "merged") {
      // eslint-disable-next-line no-restricted-syntax -- 行已 merged，交付同步失败时该行仍是 pending 待同步，下一次重放接着做
      await syncDelivery(projectId, merge).catch(() => undefined);
      return merge;
    }
    if (merge.state === "applying") {
      if (!config) return undefined;
      let applying: DevelopmentMerge = merge;
      if (!applying.mergeCommit) {
        const updated = await service
          .updateMerge(projectId, applying.mergeId, {
            expectedRevision: applying.revision,
            mergeCommit: intent.mergedCommit,
            expectedTarget: intent.expectedTarget ?? applying.combinedBase ?? null,
            ...(intent.combinedBase && !applying.combinedBase ? { combinedBase: intent.combinedBase } : {})
          })
          // eslint-disable-next-line no-restricted-syntax -- 补写 mergeCommit 失败时用 outbox 的原记录继续对账，最终状态由目标分支决定
          .catch(() => undefined);
        if (updated) applying = updated;
      }
      const reconciled = await reconcileApplying(projectId, config, applying);
      if (reconciled.state === "merged") {
        // eslint-disable-next-line no-restricted-syntax -- 对账已确认合入，交付同步失败时该行仍是 pending，下一次重放接着同步
        await syncDelivery(projectId, reconciled).catch(() => undefined);
        return reconciled;
      }
      if (
        reconciled.state === "waiting" ||
        (reconciled.state === "failed" && reconciled.reasons.includes("target_missing"))
      )
        // eslint-disable-next-line no-restricted-syntax -- 行已进入等待或目标分支不存在，待投递条目作废；删不掉时下次重放再清理一次
        await deliveryOutbox.remove(projectId, intent.mergeId).catch(() => undefined);
      return reconciled.state === "waiting" ? undefined : reconciled;
    }
    // Any other state means the record did not finish as `merged`. The actual
    // branch still decides: a later failure can have overwritten a staged
    // attempt even though the commit reached the target. Without the merge
    // configuration the repository is unknown, so keep the local fact for a
    // later read instead of dropping it.
    if (!config) return undefined;
    // eslint-disable-next-line no-restricted-syntax -- Git 读不到目标分支时分不清“已前移”与“读失败”，按未知保留 outbox 条目等待下次重放
    const tip = await targetTip(config.repository, merge.targetBranch).catch(() => undefined);
    // eslint-disable-next-line no-restricted-syntax -- 祖先检查失败时按“不在目标上”处理，宁可保留条目也不误判成已合入
    if (tip && (await isAncestor(config.repository, intent.mergedCommit, tip).catch(() => false))) {
      const updated = await service
        .updateMerge(projectId, merge.mergeId, {
          expectedRevision: merge.revision,
          state: "merged",
          reasons: [],
          detail: null,
          mergeCommit: intent.mergedCommit
        })
        // eslint-disable-next-line no-restricted-syntax -- 把行改成 merged 失败时保留 outbox 条目，下次重放重新从 Git 确认
        .catch(() => undefined);
      if (updated) {
        // eslint-disable-next-line no-restricted-syntax -- 共享行已 merged，交付同步失败时由待同步状态在下次重放继续
        await syncDelivery(projectId, updated).catch(() => undefined);
        return updated;
      }
      return undefined;
    }
    // The commit is not on the target: this outbox entry is stale and must not
    // turn into a delivery.
    // eslint-disable-next-line no-restricted-syntax -- 提交不在目标分支上，条目已作废；删不掉时下次重放按同一 Git 事实再判定一次
    await deliveryOutbox.remove(projectId, intent.mergeId).catch(() => undefined);
    return undefined;
  }

  /** Every project with a local pending fact; a startup and periodic pass uses it. */
  async function resumePendingDeliveries(): Promise<void> {
    // eslint-disable-next-line no-restricted-syntax -- 本地 outbox 目录读失败时这一轮没有待投递项目，条目仍在盘上等下次启动重放
    for (const projectId of await deliveryOutbox.projects().catch(() => [])) {
      if (deliveryRecovery.stopping) return;
      // eslint-disable-next-line no-restricted-syntax -- 单个项目的补投失败不阻断其余项目，该项目条目留到下一次定期重放
      await replayDeliveries(projectId).catch(() => undefined);
    }
  }

  /**
   * Keep retrying this host's pending deliveries while the host runs.
   *
   * The shared service may be unreachable when a merge publishes and later
   * come back without a user read, a new apply or a restart. This one bounded
   * interval is the execution host's own recovery responsibility: it only
   * looks at local pending facts, never overlaps a tick and stops with this
   * process. It is not a general scheduler and does not touch another backend's
   * operations.
   */
  function startDeliveryRecovery(intervalMs = 2_000): void {
    if (deliveryRecovery.timer) return;
    deliveryRecovery.stopping = false;
    const delay = Math.max(10, Math.round(intervalMs));
    const tick = () => {
      if (deliveryRecovery.stopping || deliveryRecovery.running) return;
      deliveryRecovery.running = resumePendingDeliveries()
        // eslint-disable-next-line no-restricted-syntax -- 一次定期补投失败时条目仍 pending，下个 interval 的 tick 会再跑一遍
        .catch(() => undefined)
        .finally(() => {
          deliveryRecovery.running = undefined;
        });
    };
    tick();
    deliveryRecovery.timer = setInterval(tick, delay);
    deliveryRecovery.timer.unref();
  }

  async function stopDeliveryRecovery(): Promise<void> {
    deliveryRecovery.stopping = true;
    if (deliveryRecovery.timer) clearInterval(deliveryRecovery.timer);
    deliveryRecovery.timer = undefined;
    // eslint-disable-next-line no-restricted-syntax -- 停机只等这一轮跑完，失败会把条目留在 outbox 里等下一次进程启动重放
    await deliveryRecovery.running?.catch(() => undefined);
    deliveryRecovery.running = undefined;
  }

  /**
   * Complete locally published deliveries and any merged row still missing its
   * delivery. Called before reads and applies, so a recovered shared service is
   * caught up automatically on the next access; failures stay pending instead
   * of breaking the read.
   */
  async function replayDeliveries(projectId: string): Promise<DevelopmentMerge[]> {
    const running = deliveryReplays.get(projectId);
    if (running) return running;
    const resolved = new Map<string, DevelopmentMerge>();
    const task = (async () => {
      try {
        const service = await gateway();
        // eslint-disable-next-line no-restricted-syntax -- 合入配置读失败时按“无配置”重放，只完成已 merged 的行，需要仓库的条目留到下次
        const config = await service.mergeConfig(projectId).catch(() => undefined);
        for (const intent of await deliveryOutbox.list(projectId)) {
          // eslint-disable-next-line no-restricted-syntax -- 单条意图恢复失败不阻断其余条目，该 outbox 条目留到下一次重放
          const resumed = await resumeDeliveryIntent(projectId, config, intent).catch(() => undefined);
          if (resumed) resolved.set(resumed.mergeId, resumed);
        }
        // Only the backend that published an operation completes its merged
        // row: the pending fact and the checkout belong to that host, and
        // another backend's read must not claim its delivery on its behalf.
        for (const merge of await service.queryMerges(projectId)) {
          if (merge.state !== "merged" || merge.executionBackendId !== ports.backendId) continue;
          if (resolved.has(merge.mergeId)) continue;
          const deliveries = await service.queryDeliveries(projectId, merge.developmentId);
          if (deliveries.some((entry) => entry.mergeId === merge.mergeId && entry.state === "synced"))
            continue;
          // eslint-disable-next-line no-restricted-syntax -- 已 merged 但缺交付的行同步失败时保持 pending，下一次读取或应用再重放
          const delivery = await syncDelivery(projectId, merge).catch(() => undefined);
          if (delivery?.state === "synced") resolved.set(merge.mergeId, merge);
        }
        // eslint-disable-next-line no-restricted-syntax -- 共享存储不可达时 outbox 与 merged 行都保持原样，下一次读取或应用整体重试
      } catch {
        // An unreachable shared store leaves the outbox and merged rows intact;
        // the next read or apply retries them.
      } finally {
        deliveryReplays.delete(projectId);
      }
      return [...resolved.values()];
    })();
    deliveryReplays.set(projectId, task);
    return task;
  }

  /**
   * Catch this host's deliveries up before a work read answers.
   *
   * A read-only read is the observation entry watching this node: it answers
   * from stored records and leaves the pending facts for the next work read or
   * the host's own periodic pass, so watching a host never writes on it.
   */
  async function replayBeforeRead(projectId: string, options: DevelopmentReadOptions): Promise<void> {
    if (options.readOnly) return;
    // eslint-disable-next-line no-restricted-syntax -- 补投失败不阻断这次读取，pending 条目留到下一次工作读取或定期重放
    await replayDeliveries(projectId).catch(() => undefined);
  }

  async function applyMerges(projectId: string): Promise<DevelopmentMerge[]> {
    await project(projectId);
    const config = await requiredMergeConfig(projectId);
    if (config.executionBackendId !== ports.backendId)
      throw conflict(
        `该项目合入归属后端 ${config.executionBackendId}，当前后端不能更新目标分支`,
        "project_git_owner_mismatch"
      );
    return serialized(projectId, async () => {
      const service = await gateway();
      // This host's own published operations come first: an interrupted or
      // unreachable shared record is completed from the local fact, including
      // when the interruption happened in this same process.
      const processed: DevelopmentMerge[] = await replayDeliveries(projectId);
      const recorded = new Set(processed.map((entry) => entry.mergeId));
      const remember = (entry: DevelopmentMerge) => {
        if (recorded.has(entry.mergeId)) return;
        recorded.add(entry.mergeId);
        processed.push(entry);
      };
      // Reconcile next: a previous process of this backend may have died
      // between the Git update and its record. A shared read that fails after
      // an operation already ran returns that result instead of hiding it.
      let known: DevelopmentMerge[];
      try {
        known = await service.queryMerges(projectId);
      } catch (error) {
        if (processed.length) return processed;
        throw error;
      }
      for (const entry of known) {
        if (entry.state !== "applying") continue;
        if (entry.executionBackendId !== ports.backendId) continue;
        if (entry.ownerStartedAt === startedAt) continue;
        const reconciled = await reconcileApplying(projectId, config, entry);
        // A requeued operation is claimed below; only a terminal reconciliation
        // is its result for this call.
        if (reconciled.state !== "waiting") remember(reconciled);
      }
      for (;;) {
        let waiting: DevelopmentMerge[];
        try {
          waiting = (await service.queryMerges(projectId)).filter((entry) => entry.state === "waiting");
        } catch (error) {
          if (processed.length) break;
          throw error;
        }
        const next = waiting[0];
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- queryMerges 可能返回空数组，waiting[0] 运行期是 undefined，这里就是循环的终止条件
        if (!next) break;
        let claimed: DevelopmentMerge;
        try {
          claimed = await service.claimMerge(projectId, next.mergeId, {
            expectedRevision: next.revision,
            ownerStartedAt: startedAt
          });
        } catch (error) {
          // Another process owns the project's update window (or this one
          // changed underneath us); its own run will record the result.
          if (
            error instanceof ProjectDataConflictError &&
            (error.code === "merge_busy" || error.code === "merge_not_claimable")
          )
            break;
          throw error;
        }
        const merged = await executeMerge(projectId, config, claimed);
        remember(merged);
        // The requirement landed: its review checkouts are no longer evidence
        // any reader needs.
        if (merged.state === "merged") await releaseDevelopmentReviewSites(projectId, merged.developmentId);
      }
      return processed;
    });
  }

  // ---- delivery read model -----------------------------------------------------

  /**
   * The committed change of the delivered (or accepted) version.
   *
   * The merge commit is the immutable head once a merge exists, so later local
   * work in the same checkout cannot rewrite a delivered diff. `combinedBase`
   * is the target it was actually combined with; before a merge the recorded
   * baseline and the latest frozen candidate stand in. A checkout this host no
   * longer owns or cannot read yields no diff instead of reading another
   * backend's checkout.
   */
  async function deliveryDiff(
    record: DevelopmentRecord,
    delivery: DevelopmentDelivery | undefined,
    merges: DevelopmentMerge[],
    plan: ReviewPlan | undefined,
    reviews: DevelopmentReview[]
  ): Promise<DeliveryDiff | undefined> {
    const workspace = record.workspace;
    if (!workspace || workspace.state !== "ready") return undefined;
    const deliveredMerge = delivery
      ? merges.find(
          (merge) => merge.mergeId === delivery.mergeId || merge.mergeCommit === delivery.mergedCommit
        )
      : undefined;
    const latestMerged = [...merges].reverse().find((merge) => merge.state === "merged");
    const merge = deliveredMerge ?? latestMerged;
    const candidateCommit =
      delivery?.candidateCommit ??
      merge?.candidate.commit ??
      plan?.candidate.commit ??
      reviews.at(-1)?.candidate.commit;
    try {
      const head =
        merge?.mergeCommit ?? candidateCommit ?? (await git(workspace.directory, ["rev-parse", "HEAD"]));
      const base = merge?.combinedBase ?? record.baseline.commit;
      const raw = await git(workspace.directory, ["diff", "--numstat", `${base}..${head}`]);
      const files = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [additions, deletions, ...path] = line.split("\t");
          return {
            path: path.join("\t"),
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- numstat 行按制表符拆分，字段缺失时运行期为 undefined，?? "" 让缺失字段判为非数字
            additions: /^\d+$/.test(additions ?? "") ? Number(additions) : 0,
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 同上，deletions 字段在二进制或残缺的 numstat 行里可能缺失
            deletions: /^\d+$/.test(deletions ?? "") ? Number(deletions) : 0
          };
        })
        .filter((file) => Boolean(file.path));
      return {
        base,
        head,
        candidateCommit: candidateCommit ?? head,
        ...(merge?.mergeCommit ? { mergedCommit: merge.mergeCommit } : {}),
        files
      };
      // eslint-disable-next-line no-restricted-syntax -- 工作副本已不在本机时无法产出 diff，共享记录里的提交与检查仍照常可读
    } catch {
      // A checkout this host no longer has cannot produce a diff; the shared
      // commits and checks above remain readable without pretending otherwise.
      return undefined;
    }
  }

  /**
   * Role progress from the durable work item and its review facts.
   *
   * A role is read from the recorded Executor author / Reviewer binding, never
   * from a model report. The work item's own status is used when this host still
   * has it; otherwise the recorded review state is the fallback.
   */
  async function deliveryRoles(
    record: DevelopmentRecord,
    reviews: DevelopmentReview[]
  ): Promise<DeliveryRoleProgress[]> {
    const known = async (callId: string): Promise<string | undefined> => {
      if (!record.taskId || !ports.call) return undefined;
      // eslint-disable-next-line no-restricted-syntax -- 工作项队列读不到该 call 时按“本机没有”返回，角色状态回退到已记录的评审状态
      const fact = await ports.call(record.taskId, callId).catch(() => undefined);
      return fact?.status;
    };
    const roles: DeliveryRoleProgress[] = [];
    const seen = new Set<string>();
    const push = async (input: Omit<DeliveryRoleProgress, "state">, fallback: string) => {
      if (!input.callId || seen.has(`${input.role}:${input.callId}`)) return;
      seen.add(`${input.role}:${input.callId}`);
      roles.push({ ...input, state: (await known(input.callId)) ?? fallback });
    };
    const author = [...reviews].reverse().find((review) => review.author)?.author;
    if (author)
      await push(
        { role: "executor", callId: author.callId, agentId: author.agentId, workspace: author.workspace },
        "candidate_frozen"
      );
    for (const review of reviews)
      for (const rework of review.reworks)
        await push(
          {
            role: "executor",
            callId: rework.continuationCallId,
            agentId: rework.agentId,
            ...(rework.workspace ? { workspace: rework.workspace } : {})
          },
          "rework_recorded"
        );
    const latest = reviews.at(-1);
    if (latest?.reviewer)
      await push(
        {
          role: "reviewer",
          callId: latest.reviewer.callId,
          agentId: latest.reviewer.agentId,
          workspace: latest.reviewer.workspace
        },
        latest.state
      );
    return roles;
  }

  function deliveryStage(
    merges: DevelopmentMerge[],
    reviews: DevelopmentReview[],
    delivery: DevelopmentDelivery | undefined
  ): DeliveryStage {
    if (delivery?.state === "synced") return "delivered";
    if (delivery?.state === "pending" || merges.some((merge) => merge.state === "merged")) return "merged";
    if (merges.some((merge) => merge.state === "waiting" || merge.state === "applying"))
      return "merge_pending";
    if (reviews.at(-1)?.state === "in_review") return "reviewing";
    return "developing";
  }

  /** One requirement's records and the diff this host can read them against. */
  async function resolvedDelivery(
    projectId: string,
    input: { developmentId?: unknown; requirementId?: unknown },
    options: DevelopmentReadOptions
  ) {
    const developmentId =
      input.developmentId === undefined || input.developmentId === null
        ? undefined
        : developmentIdentifier(input.developmentId, "开发记录 ID");
    const requirementId =
      input.requirementId === undefined || input.requirementId === null
        ? undefined
        : developmentIdentifier(input.requirementId, "需求 ID");
    if (!developmentId && !requirementId)
      throw conflict("交付视图需要 developmentId 或 requirementId", "delivery_view_target_missing");
    await replayBeforeRead(projectId, options);
    const service = await gateway();
    const record = developmentId
      ? await service.getDevelopment(projectId, developmentId, ports.backendId)
      : await service.findDevelopmentByRequirement(projectId, requirementId!, ports.backendId);
    if (!record) throw new ProjectDataNotFoundError("该需求还没有开发记录");
    const [plan, reviews, merges, deliveries, boardEntries] = await Promise.all([
      service.reviewPlan(projectId, record.developmentId),
      service.queryReviews(projectId, record.developmentId),
      service.queryMerges(projectId, record.developmentId),
      service.queryDeliveries(projectId, record.developmentId),
      service.boardEntries(projectId)
    ]);
    return {
      service,
      record,
      plan,
      reviews,
      merges,
      delivery: deliveries.at(-1),
      board: boardEntries.find((entry) => entry.requirementId === record.requirementId)
    };
  }

  /**
   * The delivery view one project, Task or requirement can read.
   *
   * It reuses the authoritative records and only adds what a reader needs to
   * follow the delivery: the phase, role progress, the committed diff this host
   * can read, the merge receipt and its synchronization state, and the board
   * projection (present only for an external demand).
   */
  async function deliveryView(
    projectId: string,
    input: { developmentId?: unknown; requirementId?: unknown },
    options: DevelopmentReadOptions = {}
  ): Promise<DeliveryView> {
    await project(projectId);
    const { record, plan, reviews, merges, delivery, board } = await resolvedDelivery(
      projectId,
      input,
      options
    );
    // eslint-disable-next-line no-restricted-syntax -- 资格计算读失败时视图省略该字段，合入与交付记录本身仍可读
    const qualification = await deliveryQualification(projectId, record.developmentId).catch(() => undefined);
    const diff = await deliveryDiff(record, delivery, merges, plan, reviews);
    const roles = await deliveryRoles(record, reviews);
    const { tickets } = await (await gateway()).tickets(projectId, record.developmentId);
    // eslint-disable-next-line no-restricted-syntax -- 本地 outbox 读失败时视为没有待同步条目，条目仍在盘上等下次重放
    const pending = [...(await deliveryOutbox.list(projectId).catch(() => []))]
      .reverse()
      .find((intent) => intent.developmentId === record.developmentId);
    const latestMerged = [...merges].reverse().find((merge) => merge.state === "merged");
    const retro = [...merges].reverse().find((merge) => merge.acceptance.retro)?.acceptance.retro;
    const waitingSync = pending
      ? {
          mergeId: pending.mergeId,
          ...(pending.error ? { error: pending.error } : {})
        }
      : !delivery && latestMerged
        ? { mergeId: latestMerged.mergeId }
        : undefined;
    return {
      projectId,
      development: record,
      stage: deliveryStage(merges, reviews, delivery),
      ...(plan ? { plan } : {}),
      reviews,
      ...(qualification ? { qualification } : {}),
      merges,
      ...(delivery ? { delivery } : {}),
      ...(board ? { board } : {}),
      ...(diff ? { diff } : {}),
      roles,
      tickets,
      ...(waitingSync ? { pendingSync: waitingSync } : {}),
      reviewReport: reviewReport(reviews, (reviewId) => ticketOfReview(tickets, reviewId)?.ticketId),
      ...(retro ? { retro } : {})
    };
  }

  /**
   * The unified patch of the accepted change, for the read-only preview.
   *
   * Only a file the delivery diff already lists can be read, and only from the
   * checkout this backend owns: the request names a path inside the change, not
   * a file on the machine. A workspace this host no longer has reports that
   * instead of returning an empty patch that looks like "no changes".
   */
  async function deliveryPatch(
    projectId: string,
    input: { developmentId?: unknown; requirementId?: unknown; path?: unknown },
    options: DevelopmentReadOptions = {}
  ): Promise<DeliveryPatch> {
    await project(projectId);
    const { record, plan, reviews, merges, delivery } = await resolvedDelivery(projectId, input, options);
    const workspace = record.workspace;
    if (!workspace || workspace.state !== "ready")
      throw conflict("需求现场不在这台设备上，无法显示 diff", "delivery_patch_unavailable");
    const diff = await deliveryDiff(record, delivery, merges, plan, reviews);
    if (!diff) throw conflict("这台设备读不到需求现场，无法显示 diff", "delivery_patch_unavailable");
    const path = typeof input.path === "string" ? input.path : undefined;
    if (path !== undefined && !diff.files.some((file) => file.path === path))
      throw conflict("该文件不在这次改动中", "delivery_patch_path_unknown");
    const raw = await git(workspace.directory, [
      "diff",
      "--no-color",
      "--unified=3",
      `${diff.base}..${diff.head}`,
      ...(path === undefined ? [] : ["--", path])
    ]);
    const truncated = raw.length > DELIVERY_PATCH_LIMIT;
    const contents: Array<{ path: string; content: string }> = [];
    for (const file of path === undefined ? diff.files : diff.files.filter((entry) => entry.path === path)) {
      const text = await git(workspace.directory, ["show", `${diff.head}:${file.path}`])
        // eslint-disable-next-line no-restricted-syntax -- 该提交里读不到这个文件（例如二进制或被删除）时省略它的正文，diff 本身仍然完整
        .catch(() => undefined);
      if (text === undefined || text.includes("\0") || text.length > DELIVERY_FILE_LIMIT) continue;
      contents.push({ path: file.path, content: text });
    }
    return {
      ...diff,
      ...(path === undefined ? {} : { path }),
      patch: truncated ? raw.slice(0, DELIVERY_PATCH_LIMIT) : raw,
      truncated,
      contents
    };
  }

  return {
    async mergeConfig(projectId: string) {
      await project(projectId);
      return (await gateway()).mergeConfig(projectId);
    },

    setMergeConfig: saveMergeConfig,

    async list(projectId: string, backendId = ports.backendId, options: DevelopmentReadOptions = {}) {
      await project(projectId);
      await replayBeforeRead(projectId, options);
      return (await gateway()).queryDevelopments(projectId, backendId);
    },

    async listForTask(taskId: string, backendId = ports.backendId, options: DevelopmentReadOptions = {}) {
      const found = await taskProject(taskId);
      await replayBeforeRead(found.projectId, options);
      return (await gateway()).queryDevelopments(found.projectId, backendId);
    },

    async get(
      projectId: string,
      developmentId: string,
      backendId = ports.backendId,
      options: DevelopmentReadOptions = {}
    ) {
      await project(projectId);
      await replayBeforeRead(projectId, options);
      return (await gateway()).getDevelopment(projectId, developmentId, backendId);
    },

    async getForTask(
      taskId: string,
      developmentId: string,
      backendId = ports.backendId,
      options: DevelopmentReadOptions = {}
    ) {
      const found = await taskProject(taskId);
      await replayBeforeRead(found.projectId, options);
      return (await gateway()).getDevelopment(found.projectId, developmentId, backendId);
    },

    /**
     * What a delegated work item needs from one requirement.
     *
     * Only a ready checkout this backend owns can be forked. A Reviewer also
     * needs the candidate its review froze: reading the checkout's HEAD at
     * start instead would let a commit made after the freeze move the site
     * under the review.
     */
    async dispatchSiteForTask(taskId: string, developmentId: string) {
      const found = await taskProject(taskId);
      const record = await (await gateway()).getDevelopment(found.projectId, developmentId, ports.backendId);
      if (!record.workspace || record.workspace.state !== "ready")
        throw conflict("开发记录没有就绪的本机现场；先 ensure_workspace", "review_workspace_not_ready");
      const reviews = await (await gateway()).queryReviews(found.projectId, developmentId);
      const frozen = reviews.filter((review) => review.state === "in_review").at(-1);
      return {
        directory: record.workspace.directory,
        ...(frozen
          ? { candidate: { repository: record.workspace.directory, commit: frozen.candidate.commit } }
          : {})
      };
    },

    /**
     * The candidate a Reviewer examines. Several tickets can be in review at
     * once, so a dispatch then names the review instead of getting the latest.
     */
    async frozenCandidateForTask(taskId: string, developmentId: string, reviewId?: string) {
      const site = await this.dispatchSiteForTask(taskId, developmentId);
      const found = await taskProject(taskId);
      const open = (await (await gateway()).queryReviews(found.projectId, developmentId)).filter(
        (review) => review.state === "in_review"
      );
      if (open.length > 1 && !reviewId)
        throw conflict(
          `有 ${open.length} 份候选在审查中（${open.map((review) => review.reviewId).join("、")}）；派 Reviewer 时用 reviewId 指明审查哪一份`,
          "review_ambiguous"
        );
      const named = reviewId ? open.find((review) => review.reviewId === reviewId) : open.at(0);
      if (reviewId && !named)
        throw conflict(`审查 ${reviewId} 不是这个需求里正在进行的审查`, "review_not_frozen");
      if (!named) return site.candidate;
      const { record, tickets, ticket, scope, rereview, mapping } = await reviewScopeOf(
        found.projectId,
        named
      );
      return {
        repository: site.directory,
        commit: named.candidate.commit,
        brief: reviewBrief({
          goal: record.goal,
          criteria: record.completionCriteria,
          tickets,
          ...(ticket ? { ticket } : {}),
          ...(mapping ? { mapping } : {}),
          ...(rereview ? { rereview } : {})
        }),
        scope
      };
    },

    async find(
      projectId: string,
      requirementId: unknown,
      backendId = ports.backendId,
      options: DevelopmentReadOptions = {}
    ) {
      await project(projectId);
      await replayBeforeRead(projectId, options);
      return (await gateway()).findDevelopmentByRequirement(projectId, requirementId, backendId);
    },

    async findForTask(
      taskId: string,
      requirementId: unknown,
      backendId = ports.backendId,
      options: DevelopmentReadOptions = {}
    ) {
      const found = await taskProject(taskId);
      await replayBeforeRead(found.projectId, options);
      return (await gateway()).findDevelopmentByRequirement(found.projectId, requirementId, backendId);
    },

    /** Delivery rows for a project or one development; a pending row is readable with its error. */
    async deliveries(projectId: string, developmentId?: unknown, options: DevelopmentReadOptions = {}) {
      await project(projectId);
      await replayBeforeRead(projectId, options);
      return (await gateway()).queryDeliveries(
        projectId,
        developmentId === undefined ? undefined : developmentIdentifier(developmentId, "开发记录 ID")
      );
    },

    async deliveriesForTask(taskId: string, developmentId?: unknown, options: DevelopmentReadOptions = {}) {
      const found = await taskProject(taskId);
      await replayBeforeRead(found.projectId, options);
      return (await gateway()).queryDeliveries(
        found.projectId,
        developmentId === undefined ? undefined : developmentIdentifier(developmentId, "开发记录 ID")
      );
    },

    async getDelivery(projectId: string, deliveryId: string) {
      await project(projectId);
      return (await gateway()).getDelivery(projectId, deliveryId);
    },

    async getDeliveryForTask(taskId: string, deliveryId: string) {
      const found = await taskProject(taskId);
      return (await gateway()).getDelivery(found.projectId, deliveryId);
    },

    /** Retry a pending delivery from its persisted receipt; safe to click repeatedly. */
    async retryDelivery(projectId: string, deliveryId: string) {
      await project(projectId);
      return (await gateway()).retryDelivery(projectId, deliveryId);
    },

    async retryDeliveryForTask(taskId: string, deliveryId: string) {
      const found = await taskProject(taskId);
      return (await gateway()).retryDelivery(found.projectId, deliveryId);
    },

    /** Retry by development, for a local fact that never reached the shared row. */
    async retryDevelopmentDelivery(projectId: string, developmentId: string) {
      return retryDevelopmentDelivery(projectId, developmentId);
    },

    async retryDevelopmentDeliveryForTask(taskId: string, developmentId: string) {
      const found = await taskProject(taskId);
      return retryDevelopmentDelivery(found.projectId, developmentId);
    },

    /** One pass over this host's persisted facts; failures stay pending. */
    resumeDeliveries() {
      return resumePendingDeliveries();
    },

    /** Start the bounded retry responsibility for this process. */
    startDeliveryRecovery(intervalMs?: number) {
      startDeliveryRecovery(intervalMs);
    },

    /** Stop this instance's retry task and let an in-flight pass finish. */
    stopDeliveryRecovery() {
      return stopDeliveryRecovery();
    },

    async deliveryView(
      projectId: string,
      input: Record<string, unknown>,
      options: DevelopmentReadOptions = {}
    ) {
      return deliveryView(projectId, input, options);
    },

    async deliveryViewForTask(
      taskId: string,
      input: Record<string, unknown>,
      options: DevelopmentReadOptions = {}
    ) {
      const found = await taskProject(taskId);
      return deliveryView(found.projectId, input, options);
    },

    async deliveryPatch(
      projectId: string,
      input: Record<string, unknown>,
      options: DevelopmentReadOptions = {}
    ) {
      return deliveryPatch(projectId, input, options);
    },

    async deliveryPatchForTask(
      taskId: string,
      input: Record<string, unknown>,
      options: DevelopmentReadOptions = {}
    ) {
      const found = await taskProject(taskId);
      return deliveryPatch(found.projectId, input, options);
    },

    /** Record the receipt a remote execution backend produced for a real merge. */
    async recordDelivery(projectId: string, receipt: unknown, backendId: string) {
      await project(projectId);
      const value = deliveryReceipt(receipt);
      const merge = await (await gateway()).getMerge(projectId, value.mergeId);
      if (merge.executionBackendId !== backendId)
        throw conflict(`合入操作归属后端 ${merge.executionBackendId}`, "delivery_owner_mismatch");
      return (await gateway()).syncDelivery(projectId, value);
    },

    async recordWorkspace(projectId: string, developmentId: string, workspace: unknown) {
      await project(projectId);
      return (await gateway()).recordDevelopmentWorkspace(projectId, developmentId, workspace);
    },

    async create(projectId: string, input: DevelopmentCreate) {
      return create(projectId, input);
    },

    async createForTask(taskId: string, input: DevelopmentCreate) {
      const found = await taskProject(taskId);
      return create(found.projectId, input, taskId);
    },

    update(projectId: string, developmentId: string, input: DevelopmentUpdate, backendId = ports.backendId) {
      return gateway().then((service) =>
        service.updateDevelopment(projectId, developmentId, input, backendId)
      );
    },

    async updateForTask(
      taskId: string,
      developmentId: string,
      input: DevelopmentUpdate,
      backendId = ports.backendId
    ) {
      const found = await taskProject(taskId);
      return (await gateway()).updateDevelopment(found.projectId, developmentId, input, backendId);
    },

    /** Record a shared merge entry that the caller already validated on its own host. */
    async recordMergeConfig(projectId: string, input: MergeConfigInput, backendId: string) {
      // The data authority only checks the shared project; the execution owner
      // checked the repository path and branch where they actually exist.
      return (await gateway()).setMergeConfig(projectId, input, backendId);
    },

    /** Record a shared development fact without preparing any checkout here. */
    async record(projectId: string, input: DevelopmentCreate) {
      return (await gateway()).createDevelopment(projectId, input);
    },

    /**
     * Continue an existing workspace: return it when it is still the recorded
     * checkout, otherwise prepare it again at the recorded baseline. A failure
     * is written to the record instead of replacing what was there.
     */
    async ensureWorkspace(projectId: string, developmentId: string) {
      return ensureWorkspace(projectId, developmentId);
    },

    async ensureWorkspaceForTask(taskId: string, developmentId: string) {
      const found = await taskProject(taskId);
      return ensureWorkspace(found.projectId, developmentId);
    },

    // ---- tickets ---------------------------------------------------------------
    async tickets(projectId: string, developmentId: string) {
      await project(projectId);
      return (await gateway()).tickets(projectId, developmentId);
    },

    /** Every development's tickets in one project, flat, for the overview's phase columns. */
    async ticketSummaries(projectId: string, developmentIds: string[]) {
      const service = await gateway();
      const sets = await Promise.all(developmentIds.map((id) => service.tickets(projectId, id)));
      return sets.flatMap((set) =>
        set.tickets.map((ticket) => ({
          developmentId: set.developmentId,
          ticketId: ticket.ticketId,
          title: ticket.title,
          state: ticket.state,
          dependsOn: ticket.dependsOn
        }))
      );
    },

    async ticketsForTask(taskId: string, developmentId: string) {
      const found = await taskProject(taskId);
      return (await gateway()).tickets(found.projectId, developmentId);
    },

    async writeTickets(projectId: string, developmentId: string, write: TicketWrite) {
      await project(projectId);
      return (await gateway()).writeTickets(projectId, developmentId, write);
    },

    async writeTicketsForTask(taskId: string, developmentId: string, write: TicketWrite) {
      const found = await taskProject(taskId);
      return (await gateway()).writeTickets(found.projectId, developmentId, write);
    },

    async integrateTicket(projectId: string, input: Record<string, unknown>) {
      return integrateTicket(projectId, input);
    },

    async integrateTicketForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return integrateTicket(found.projectId, input);
    },

    ticketForDispatch,
    ticketStarted,

    async next(projectId: string, developmentId: string) {
      await project(projectId);
      return nextStep(projectId, developmentId);
    },

    async nextForTask(taskId: string, developmentId: string) {
      const found = await taskProject(taskId);
      return nextStep(found.projectId, developmentId);
    },

    async contextHandoffForTask(taskId: string): Promise<WindowDevelopment | undefined> {
      const { projectId } = await taskProject(taskId);
      const service = await gateway();
      const main = await service.findMainSessionByTask(projectId, ports.backendId, taskId);
      const records = await service.queryDevelopments(projectId, ports.backendId);
      const requirement = main?.session.currentRequirementId;
      const current = requirement
        ? records.find((record) => record.requirementId === requirement)
        : records.find((record) => record.taskId === taskId);
      if (!current) return;
      const { developmentId, route, goal, completionCriteria } = current;
      const tickets = await service.tickets(projectId, developmentId);
      const next = await nextStep(projectId, developmentId, { record: current, tickets });
      return {
        developmentId,
        route,
        goal,
        completionCriteria,
        next,
        tickets: tickets.tickets.map(({ ticketId, title, state }) => ({ ticketId, title, state }))
      };
    },

    // ---- review actions --------------------------------------------------------
    async reviewPlan(projectId: string, developmentId: string) {
      await project(projectId);
      return (await gateway()).reviewPlan(projectId, developmentId);
    },

    async reviewPlanForTask(taskId: string, developmentId: string) {
      const found = await taskProject(taskId);
      return (await gateway()).reviewPlan(found.projectId, developmentId);
    },

    async setReviewPlan(projectId: string, input: Record<string, unknown>) {
      return setReviewPlan(projectId, input);
    },

    async setReviewPlanForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return setReviewPlan(found.projectId, input);
    },

    async startReview(projectId: string, taskId: string | undefined, input: Record<string, unknown>) {
      return startReview(projectId, taskId, input);
    },

    async startReviewForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return startReview(found.projectId, taskId, input);
    },

    async attachReviewer(projectId: string, taskId: string | undefined, input: Record<string, unknown>) {
      return attachReviewer(projectId, taskId, input);
    },

    async attachReviewerForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return attachReviewer(found.projectId, taskId, input);
    },

    async recordFinding(projectId: string, input: Record<string, unknown>) {
      return recordFinding(projectId, input);
    },

    async recordFindingForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return recordFinding(found.projectId, input);
    },

    async ruleFinding(projectId: string, input: Record<string, unknown>) {
      return ruleFinding(projectId, input);
    },

    async ruleFindingForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return ruleFinding(found.projectId, input);
    },

    async recordRework(projectId: string, taskId: string | undefined, input: Record<string, unknown>) {
      return recordRework(projectId, taskId, input);
    },

    async recordReworkForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return recordRework(found.projectId, taskId, input);
    },

    async changeApproach(projectId: string, input: Record<string, unknown>) {
      return changeApproach(projectId, input);
    },

    async changeApproachForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return changeApproach(found.projectId, input);
    },

    async completeReview(projectId: string, input: Record<string, unknown>) {
      return completeReview(projectId, input);
    },

    async completeReviewForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return completeReview(found.projectId, input);
    },

    async delivery(projectId: string, developmentId: string) {
      return deliveryQualification(projectId, developmentId);
    },

    async deliveryForTask(taskId: string, developmentId: string) {
      const found = await taskProject(taskId);
      return deliveryQualification(found.projectId, developmentId);
    },

    async queryReviews(projectId: string, developmentId?: string) {
      await project(projectId);
      return (await gateway()).queryReviews(projectId, developmentId);
    },

    async queryReviewsForTask(taskId: string, developmentId?: string) {
      const found = await taskProject(taskId);
      return (await gateway()).queryReviews(found.projectId, developmentId);
    },

    async getReview(projectId: string, reviewId: string) {
      await project(projectId);
      return (await gateway()).getReview(projectId, reviewId);
    },

    async getReviewForTask(taskId: string, reviewId: string) {
      const found = await taskProject(taskId);
      return (await gateway()).getReview(found.projectId, reviewId);
    },

    // ---- project merge actions -------------------------------------------------
    async requestMerge(projectId: string, input: Record<string, unknown>) {
      return requestMerge(projectId, input);
    },

    async requestMergeForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return requestMerge(found.projectId, input);
    },

    async applyMerges(projectId: string) {
      return applyMerges(projectId);
    },

    async applyMergesForTask(taskId: string) {
      const found = await taskProject(taskId);
      return applyMerges(found.projectId);
    },

    async queryMerges(projectId: string, developmentId?: string, options: DevelopmentReadOptions = {}) {
      await project(projectId);
      await replayBeforeRead(projectId, options);
      return (await gateway()).queryMerges(projectId, developmentId);
    },

    async queryMergesForTask(taskId: string, developmentId?: string, options: DevelopmentReadOptions = {}) {
      const found = await taskProject(taskId);
      await replayBeforeRead(found.projectId, options);
      return (await gateway()).queryMerges(found.projectId, developmentId);
    },

    async getMerge(projectId: string, mergeId: string) {
      await project(projectId);
      return (await gateway()).getMerge(projectId, mergeId);
    },

    async getMergeForTask(taskId: string, mergeId: string) {
      const found = await taskProject(taskId);
      return (await gateway()).getMerge(found.projectId, mergeId);
    },

    /**
     * Record the operation a remote backend qualified on its own host. The
     * authority stores the shared row from the configured entry; it never runs
     * Git or trusts a request body's repository or target.
     */
    async recordMerge(projectId: string, developmentId: unknown, input: unknown, backendId: string) {
      await project(projectId);
      const config = await requiredMergeConfig(projectId);
      const value =
        input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
      const checks = mergeCheckCommands(value.checks);
      if (!checks.length) throw conflict("合入须记录在组合版本上运行的检查命令", "merge_checks_missing");
      return (await gateway()).createMerge(projectId, developmentId, {
        candidate: reviewCandidate(value.candidate),
        acceptance: mergeAcceptance(value.acceptance),
        checks,
        requestedBy: backendId,
        executionBackendId: config.executionBackendId,
        targetBranch: config.targetBranch
      });
    },

    async recordMergeClaim(projectId: string, mergeId: unknown, input: unknown, backendId: string) {
      const id = developmentIdentifier(mergeId, "合入操作 ID");
      const merge = await (await gateway()).getMerge(projectId, id);
      if (merge.executionBackendId !== backendId)
        throw conflict(`合入操作归属后端 ${merge.executionBackendId}`, "merge_owner_mismatch");
      return (await gateway()).claimMerge(projectId, id, input);
    },

    async recordMergeUpdate(projectId: string, mergeId: unknown, input: unknown, backendId: string) {
      const id = developmentIdentifier(mergeId, "合入操作 ID");
      const merge = await (await gateway()).getMerge(projectId, id);
      if (merge.executionBackendId !== backendId)
        throw conflict(`合入操作归属后端 ${merge.executionBackendId}`, "merge_owner_mismatch");
      return (await gateway()).updateMerge(projectId, id, input);
    },

    /**
     * Record a fact the caller already validated on the host that owns the
     * checkout. The data authority stores reviews but never runs Git or reads
     * another host's work items.
     */
    async recordReviewPlan(projectId: string, developmentId: unknown, input: unknown) {
      await project(projectId);
      return (await gateway()).setReviewPlan(projectId, developmentId, input);
    },

    async recordReview(projectId: string, developmentId: unknown, input: unknown) {
      await project(projectId);
      return (await gateway()).createReview(projectId, developmentId, input);
    },

    async recordReviewUpdate(projectId: string, reviewId: unknown, input: unknown) {
      await project(projectId);
      return (await gateway()).updateReview(projectId, reviewId, input);
    }
  };
}

export type ProjectDevelopmentService = ReturnType<typeof createProjectDevelopmentService>;
