import {
  reviewApproved,
  type DevelopmentReview,
  type ReviewCandidate,
  type ReviewQualification
} from "../domain/development-review.js";
import {
  PITFALLS_DIRECTORY,
  retroSignals,
  type DevelopmentMerge,
  type MergeCheck
} from "../domain/development-merge.js";
import { developmentNext, finalReviews, type TicketSet } from "../domain/development-ticket.js";
import { developmentIdentifier, type DevelopmentRecord } from "../domain/project-development.js";
import type { ProjectDataGateway } from "../workspace/project-data-service.js";
import { onlyChangesUnder } from "../workspace/development-workspace.js";
import type { ProjectDevelopmentPorts } from "./project-development-service.js";
import type { createDevelopmentWorkspaceService } from "./development-workspace-service.js";
import type { createDevelopmentTicketService } from "./development-ticket-service.js";
import { roundBudget, chainOf } from "./development-review-rounds.js";

export function createDevelopmentReadinessService({
  reviewDevelopment,
  gateway,
  inspectWorkspace,
  ticketRoute,
  lastIntegration,
  fromIntegration,
  ports,
  requiredMergeConfig
}: {
  reviewDevelopment: ReturnType<typeof createDevelopmentWorkspaceService>["reviewDevelopment"];
  gateway: () => Promise<ProjectDataGateway>;
  inspectWorkspace: ReturnType<typeof createDevelopmentWorkspaceService>["inspectWorkspace"];
  ticketRoute: ReturnType<typeof createDevelopmentTicketService>["ticketRoute"];
  lastIntegration: ReturnType<typeof createDevelopmentTicketService>["lastIntegration"];
  fromIntegration: ReturnType<typeof createDevelopmentTicketService>["fromIntegration"];
  ports: Pick<ProjectDevelopmentPorts, "backendId">;
  requiredMergeConfig: ReturnType<typeof createDevelopmentWorkspaceService>["requiredMergeConfig"];
}) {
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
      const directory = record.workspace!.directory;
      // The version the program produced: the last ticket brought in, perhaps
      // with the target branch merged in after it by sync_target.
      if (
        last &&
        !(await carries(last)) &&
        !(await fromIntegration(projectId, directory, last.commit, current.commit))
      )
        reasons.push("candidate_changed");
      // It also needs a passed review of the whole requirement on this version.
      if (!reasons.length) {
        const final = finalReviews(tickets, reviews).at(-1);
        if (!final) reasons.push("final_review_missing");
        else {
          qualification.reviewId = final.reviewId;
          qualification.independentReview = Boolean(final.reviewer);
          if (!reviewApproved(final)) reasons.push(`review_${final.state}`);
          else if (!(await carries(final.candidate))) reasons.push("candidate_changed");
          else qualification.approved = approvedAs(final.candidate);
        }
      }
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
    const final = ticketRoute(record) ? finalReviews(tickets.tickets, reviews).at(-1) : undefined;
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
      ...(merge?.state === "merged" ? { mergedSinceTidy: await service.mergedSinceTidy(projectId) } : {}),
      retro: {
        signals: retroSignals(reviews, merges),
        recorded: merges.some((entry) => entry.acceptance.retro && !entry.acceptance.retro.auto),
        improvements: merges.flatMap((entry) => entry.acceptance.retro?.improvements ?? [])
      },
      ledgerRecorded: merges.some((entry) => entry.acceptance.ledger)
    });
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
      const target = await requiredMergeConfig(projectId);
      if (!last || !(await fromIntegration(projectId, target.repository, last.commit, approved.commit)))
        reasons.push("candidate_changed");
      const final = finalReviews(tickets, reviews).find(
        (entry) => entry.reviewId === merge.acceptance.reviewId
      );
      if (!final) reasons.push("final_review_missing");
      else {
        if (!reviewApproved(final)) reasons.push(`review_${final.state}`);
        if (final.candidate.commit !== approved.commit) reasons.push("candidate_changed");
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

  return { deliveryQualification, nextStep, recordedMergeChecks, acceptanceReasons };
}
