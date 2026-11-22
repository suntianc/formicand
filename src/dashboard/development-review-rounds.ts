import { conflict } from "./development-errors.js";
import { REWORK_ROUNDS, type ApproachKind, type DevelopmentReview } from "../domain/development-review.js";
import { finalReviews, type DevelopmentTicket } from "../domain/development-ticket.js";
import { developmentIdentifier } from "../domain/project-development.js";

/**
 * The reviews that share one rework budget: a ticket's own, or the
 * requirement's own (the full route's final reviews, or a quick change's).
 */
export function chainOf(
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
export function roundBudget(chain: DevelopmentReview[]) {
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
export function checkRound(
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
    throw conflict(`换办法选的是改票：先用 revise_ticket 改 ${label}，再送审`, "review_approach_not_applied");
  if (approach.kind === "new_plan" && tickets.length > 0 && !tickets.some((entry) => entry.createdAt > since))
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
export function previousRound(
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
