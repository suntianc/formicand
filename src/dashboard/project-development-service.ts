import { conflict } from "./development-errors.js";
import type { WindowDevelopment } from "../runtime/session-handoff.js";
import { type ReviewConclusion } from "../runtime/subagent-review.js";
import { reviewCandidate } from "../domain/development-review.js";
import { mergeAcceptance, mergeCheckCommands } from "../domain/development-merge.js";
import { deliveryReceipt } from "../domain/development-delivery.js";
import { reviewBrief, type TicketWrite } from "../domain/development-ticket.js";
import { developmentIdentifier } from "../domain/project-development.js";
import type {
  DevelopmentCreate,
  DevelopmentUpdate,
  MergeConfigInput,
  ProjectDataRuntime
} from "../workspace/project-data-service.js";
import { createDevelopmentMergeService } from "./project-development-merge-service.js";
import { createDevelopmentWorkspaceService } from "./development-workspace-service.js";

import { createDevelopmentReviewEvidenceService } from "./development-review-evidence-service.js";
import { createDevelopmentTicketService } from "./development-ticket-service.js";
import { createDevelopmentReviewStartService } from "./development-review-start-service.js";
import { createDevelopmentReadinessService } from "./development-readiness-service.js";
import { createDevelopmentMergeRequestService } from "./development-merge-request-service.js";
import { createDevelopmentDeliveryViewService } from "./development-delivery-view-service.js";

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
 * this host's pending deliveries or binding its project directory. Reads this
 * host makes of a shared authority carry the marker too, so the authority does
 * not replay its own deliveries for them either. Work entry and Main tool reads
 * send no marker and still complete a pending delivery before they answer.
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
  /**
   * Wake the Task's Main with news it is waiting for, such as checks that ran
   * after its call returned. `noticeId` makes a repeated notice a no-op.
   */
  notifyTask?(taskId: string, noticeId: string, payload: Record<string, unknown>): Promise<void>;
}

/** The checks that failed, with the end of their output: what Main reads first. */
function failedChecks(checks: unknown): Record<string, unknown>[] {
  if (!Array.isArray(checks)) return [];
  return (checks as { name?: string; command?: string; exitCode?: number | null; output?: string }[])
    .filter((check) => check.exitCode !== 0)
    .map((check) => ({
      name: check.name,
      command: check.command,
      exitCode: check.exitCode,
      output: (check.output ?? "").slice(-2_000)
    }));
}

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

  const {
    project,
    taskProject,
    requiredMergeConfig,
    saveMergeConfig,
    create,
    ensureWorkspace,
    reviewDevelopment,
    openDevelopment,
    inspectWorkspace,
    currentCandidate,
    requireCall,
    inDevelopment,
    integrating
  } = createDevelopmentWorkspaceService({ gateway, ports });

  const {
    reviewScopeOf,
    releaseDevelopmentReviewSites,
    attachReviewer,
    recordFinding,
    ruleFinding,
    recordRework,
    completeReview
  } = createDevelopmentReviewEvidenceService({ gateway, ports, requireCall });

  const {
    ticketRoute,
    fromIntegration,
    syncTarget,
    requireTicket,
    inspectDirectory,
    lastIntegration,
    ticketChangedPaths,
    integrateTicket,
    integrateTicketInBackground,
    ticketForDispatch,
    ticketStarted,
    startTicket
  } = createDevelopmentTicketService({
    gateway,
    inDevelopment,
    integrating,
    inspectWorkspace,
    taskProject,
    requiredMergeConfig,
    ports
  });

  const { changeApproach, setReviewPlan, startReview } = createDevelopmentReviewStartService({
    gateway,
    currentCandidate,
    lastIntegration,
    requireTicket,
    requireCall,
    inspectDirectory,
    inspectWorkspace,
    ticketChangedPaths,
    openDevelopment,
    inDevelopment,
    requiredMergeConfig,
    fromIntegration
  });

  const { deliveryQualification, nextStep, recordedMergeChecks, acceptanceReasons } =
    createDevelopmentReadinessService({
      reviewDevelopment,
      gateway,
      inspectWorkspace,
      ticketRoute,
      lastIntegration,
      fromIntegration,
      ports,
      requiredMergeConfig
    });

  const mergeService = createDevelopmentMergeService({
    backendId: ports.backendId,
    startedAt: ports.startedAt,
    developmentRoot: ports.developmentRoot,
    deliveryRoot: ports.deliveryRoot,
    mergeFaultInject: ports.mergeFaultInject,
    gateway,
    ensureProject: project,
    requiredMergeConfig,
    acceptanceReasons,
    releaseReviewSites: releaseDevelopmentReviewSites
  });

  const { requestMerge } = createDevelopmentMergeRequestService({
    gateway,
    project,
    reviewDevelopment,
    requiredMergeConfig,
    deliveryQualification,
    recordedMergeChecks,
    ticketRoute,
    ports,
    mergeService
  });

  const { deliveryView, deliveryPhases, deliveryPatch, deliveryFileLocation } =
    createDevelopmentDeliveryViewService({
      ports,
      mergeService,
      gateway,
      project,
      deliveryQualification
    });

  return {
    async mergeConfig(projectId: string) {
      await project(projectId);
      return (await gateway()).mergeConfig(projectId);
    },

    setMergeConfig: saveMergeConfig,

    async list(projectId: string, backendId = ports.backendId, options: DevelopmentReadOptions = {}) {
      await project(projectId, options);
      await mergeService.replayBeforeRead(projectId, options);
      return (await gateway()).queryDevelopments(projectId, backendId);
    },

    async listForTask(taskId: string, backendId = ports.backendId, options: DevelopmentReadOptions = {}) {
      const found = await taskProject(taskId);
      await mergeService.replayBeforeRead(found.projectId, options);
      return (await gateway()).queryDevelopments(found.projectId, backendId);
    },

    async get(
      projectId: string,
      developmentId: string,
      backendId = ports.backendId,
      options: DevelopmentReadOptions = {}
    ) {
      await project(projectId, options);
      await mergeService.replayBeforeRead(projectId, options);
      return (await gateway()).getDevelopment(projectId, developmentId, backendId);
    },

    async getForTask(
      taskId: string,
      developmentId: string,
      backendId = ports.backendId,
      options: DevelopmentReadOptions = {}
    ) {
      const found = await taskProject(taskId);
      await mergeService.replayBeforeRead(found.projectId, options);
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
      await project(projectId, options);
      await mergeService.replayBeforeRead(projectId, options);
      return (await gateway()).findDevelopmentByRequirement(projectId, requirementId, backendId);
    },

    async findForTask(
      taskId: string,
      requirementId: unknown,
      backendId = ports.backendId,
      options: DevelopmentReadOptions = {}
    ) {
      const found = await taskProject(taskId);
      await mergeService.replayBeforeRead(found.projectId, options);
      return (await gateway()).findDevelopmentByRequirement(found.projectId, requirementId, backendId);
    },

    /** Delivery rows for a project or one development; a pending row is readable with its error. */
    async deliveries(projectId: string, developmentId?: unknown, options: DevelopmentReadOptions = {}) {
      await project(projectId, options);
      await mergeService.replayBeforeRead(projectId, options);
      return (await gateway()).queryDeliveries(
        projectId,
        developmentId === undefined ? undefined : developmentIdentifier(developmentId, "开发记录 ID")
      );
    },

    async deliveriesForTask(taskId: string, developmentId?: unknown, options: DevelopmentReadOptions = {}) {
      const found = await taskProject(taskId);
      await mergeService.replayBeforeRead(found.projectId, options);
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
      return mergeService.retryDevelopmentDelivery(projectId, developmentId);
    },

    async retryDevelopmentDeliveryForTask(taskId: string, developmentId: string) {
      const found = await taskProject(taskId);
      return mergeService.retryDevelopmentDelivery(found.projectId, developmentId);
    },

    /** One pass over this host's persisted facts; failures stay pending. */
    resumeDeliveries() {
      return mergeService.resumePendingDeliveries();
    },

    /** Start the bounded retry responsibility for this process. */
    startDeliveryRecovery(intervalMs?: number) {
      mergeService.startDeliveryRecovery(intervalMs);
    },

    /** Stop this instance's retry task and let an in-flight pass finish. */
    stopDeliveryRecovery() {
      return mergeService.stopDeliveryRecovery();
    },

    async deliveryView(
      projectId: string,
      input: Record<string, unknown>,
      options: DevelopmentReadOptions = {}
    ) {
      return deliveryView(projectId, input, options);
    },

    async deliveryPhases(projectId: string, options: DevelopmentReadOptions = {}) {
      return deliveryPhases(projectId, options);
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

    async deliveryFileLocation(
      projectId: string,
      input: Record<string, unknown>,
      options: DevelopmentReadOptions = {}
    ) {
      return deliveryFileLocation(projectId, input, options);
    },

    async deliveryFileLocationForTask(
      taskId: string,
      input: Record<string, unknown>,
      options: DevelopmentReadOptions = {}
    ) {
      const found = await taskProject(taskId);
      return deliveryFileLocation(found.projectId, input, options);
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
          dependsOn: ticket.dependsOn,
          // Which reviews are this ticket's, so a reader can tell the requirement's final review apart.
          reviewIds: ticket.reviewIds
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

    async syncTarget(projectId: string, input: Record<string, unknown>) {
      return syncTarget(projectId, input);
    },

    async syncTargetForTask(taskId: string, input: Record<string, unknown>) {
      return syncTarget((await taskProject(taskId)).projectId, input);
    },

    /**
     * Main's integration: its tool call cannot wait for a project's checks, so
     * it returns once they start and Main is woken with their outcome.
     */
    async integrateTicketForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      const notify = ports.notifyTask;
      if (!notify) return integrateTicket(found.projectId, input);
      return integrateTicketInBackground(found.projectId, input, async (result) => {
        const developmentId = String(result.developmentId ?? input.developmentId);
        const tickets = result.tickets as { revision?: number } | undefined;
        await notify(
          taskId,
          `ticket-integrated-${developmentId}-${result.ticketId}-${tickets?.revision ?? Date.now()}`,
          {
            type: "development.ticket_integrated",
            developmentId,
            ticketId: result.ticketId,
            integrated: result.integrated,
            ...(typeof result.detail === "string" ? { detail: result.detail } : {}),
            failedChecks: failedChecks(result.checks),
            next: await nextStep(found.projectId, developmentId)
          }
        );
      });
    },

    ticketForDispatch,
    ticketStarted,
    startTicketForTask: startTicket,

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

    /** Main's merge request: like an integration, its outcome arrives as a notice. */
    async requestMergeForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      const notify = ports.notifyTask;
      if (!notify) return { merge: await requestMerge(found.projectId, input) };
      const applying = { started: false };
      const merge = await requestMerge(
        found.projectId,
        input,
        async (merge) => {
          await notify(taskId, `merge-finished-${merge.mergeId}-${merge.revision}`, {
            type: "development.merge_finished",
            developmentId: merge.developmentId,
            mergeId: merge.mergeId,
            state: merge.state,
            ...(merge.detail ? { detail: merge.detail } : {}),
            ...(merge.reasons.length ? { reasons: merge.reasons } : {}),
            failedChecks: failedChecks(merge.checks),
            next: await nextStep(found.projectId, merge.developmentId)
          });
        },
        () => {
          applying.started = true;
        }
      );
      return applying.started ? { merge, pending: true } : { merge };
    },

    async applyMerges(projectId: string) {
      return mergeService.applyMerges(projectId);
    },

    async applyMergesForTask(taskId: string) {
      const found = await taskProject(taskId);
      return mergeService.applyMerges(found.projectId);
    },

    async queryMerges(projectId: string, developmentId?: string, options: DevelopmentReadOptions = {}) {
      await project(projectId, options);
      await mergeService.replayBeforeRead(projectId, options);
      return (await gateway()).queryMerges(projectId, developmentId);
    },

    async queryMergesForTask(taskId: string, developmentId?: string, options: DevelopmentReadOptions = {}) {
      const found = await taskProject(taskId);
      await mergeService.replayBeforeRead(found.projectId, options);
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
