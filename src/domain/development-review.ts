import { ProjectDataInvalidError, ledgerIdentifier, ledgerProjectDirectory } from "./project-ledger.js";
import { now } from "./types.js";

/**
 * A fixed candidate and the independent review of it.
 *
 * The candidate is a Git commit plus the tree it resolved to, frozen by the
 * program before the Reviewer starts. Everything about the review that must be
 * auditable later — who reviewed, what they found, the checks that failed, what
 * Main ruled and which candidate a fix produced — is recorded as a fact here.
 * Main decides the substance; the program only keeps the versions, identity,
 * drift and delivery prerequisites consistent.
 */
export type ReviewChannel = "self" | "independent" | "combined";
export type ReviewKind = "independent" | "combined";
export type ReviewState = "in_review" | "passed" | "failed" | "drifted";
/**
 * `open` blocks until Main rules it; `suggestion` is a non-blocking finding Main
 * may still choose to fix; `reopened` is a claimed fix the re-review found not
 * fixed, carried into that re-review under the same id.
 */
export type FindingState = "open" | "suggestion" | "fix_claimed" | "fixed" | "reopened" | "dismissed";
export type RulingDecision = "fix" | "dismiss";
export type DismissalCategory = "false_positive" | "out_of_scope" | "deferred" | "other";
/**
 * What Main does once a review chain has used its rework rounds: re-split or
 * revise the ticket, hand it to a fresh Executor, make a new plan for the whole
 * requirement, or deliver what is done and record what is not.
 */
export type ApproachKind = "fresh_executor" | "revised_ticket" | "new_plan" | "deliver_partial";

export const REVIEW_CHANNELS: readonly ReviewChannel[] = ["self", "independent", "combined"];
export const REVIEW_KINDS: readonly ReviewKind[] = ["independent", "combined"];
export const REVIEW_STATES: readonly ReviewState[] = ["in_review", "passed", "failed", "drifted"];
export const FINDING_STATES: readonly FindingState[] = [
  "open",
  "suggestion",
  "fix_claimed",
  "fixed",
  "reopened",
  "dismissed"
];
export const RULING_DECISIONS: readonly RulingDecision[] = ["fix", "dismiss"];
export const DISMISSAL_CATEGORIES: readonly DismissalCategory[] = [
  "false_positive",
  "out_of_scope",
  "deferred",
  "other"
];
export const APPROACH_KINDS: readonly ApproachKind[] = [
  "fresh_executor",
  "revised_ticket",
  "new_plan",
  "deliver_partial"
];
/** Failed reviews a chain may have before Main must change approach. */
export const REWORK_ROUNDS = 2;

/** One recorded check: the command that ran, its exit code and its captured output. */
export interface ReviewCheck {
  name: string;
  command?: string;
  exitCode: number;
  output: string;
  at: string;
}

/** Main's ruling on one finding; a dismissal always says why the finding does not stand. */
export interface ReviewRuling {
  rulingId: string;
  decision: RulingDecision;
  category?: DismissalCategory;
  basis: string;
  candidateCommit: string;
  at: string;
}

export interface ReviewFinding {
  findingId: string;
  title: string;
  detail: string;
  location?: string;
  /** Whether it blocks acceptance; a non-blocking one is a suggestion. */
  blocking: boolean;
  /** For a blocking finding: the criterion it violates, or a floor class. */
  basis?: string;
  /** The candidate that was under review when this was found. */
  candidateCommit: string;
  state: FindingState;
  checks: ReviewCheck[];
  /** The verbatim failure the Reviewer produced, kept so it can be read again. */
  rawFailure?: string;
  /** Fixed at recording time, so a later rebind or history edit cannot move it. */
  source?: ReviewFindingSource;
  ruling?: ReviewRuling;
  /** The candidate a recorded rework produced; set when the fix is verified. */
  fixedCommit?: string;
  /** The later review on the previousReview chain that verified the fix. */
  verifiedByReviewId?: string;
  createdAt: string;
  updatedAt: string;
}

/** The independent session that actually produced one finding. */
export interface ReviewFindingSource {
  role: "reviewer";
  callId: string;
  agentId: string;
}

export interface ReviewCandidate {
  commit: string;
  tree: string;
  branch: string;
  workspace: string;
}

/** The independent session that examined the candidate; never the authoring Executor. */
export interface ReviewReviewer {
  role: "reviewer";
  taskId: string;
  callId: string;
  agentId: string;
  workspace: string;
  /** The conclusion it submitted, once the program imported it into this review. */
  conclusion?: ReviewerConclusion;
}

/** What the Reviewer itself concluded, kept beside Main's rulings. */
export interface ReviewerConclusion {
  verdict: "pass" | "changes_requested";
  /** On a re-review: whether each finding of the previous round is fixed. */
  previousFindings?: { findingId: string; fixed: boolean; evidence: string }[];
  at: string;
}

/** Main's change of approach on a failed review that used the chain's rounds. */
export interface ReviewApproach {
  kind: ApproachKind;
  basis: string;
  at: string;
}

/** The call that produced the candidate, when it came from a delegated Executor. */
export interface ReviewAuthor {
  role: "executor";
  callId: string;
  agentId: string;
  workspace: string;
}

/**
 * A rework that continued the author's original session and checkout.
 *
 * Both call ids are recorded so a later reader can tell a real continuation
 * from a fresh Agent that was handed a summary: the agent id and workspace must
 * be the same, and the continuation must reference the call it resumed.
 */
export interface ReviewRework {
  fromCallId: string;
  fromAgentId: string;
  continuationCallId: string;
  agentId: string;
  workspace: string;
  findingIds: string[];
  at: string;
}

export interface ReviewVerdict {
  summary: string;
  checks: ReviewCheck[];
  at: string;
  /** Set on a failed review when its chain hit the round limit. */
  approach?: ReviewApproach;
}

/**
 * One row of the acceptance mapping Main writes before a final review: a
 * requirement of the plan and what on the integrated tree shows it holds. The
 * final Reviewer verifies each row; a blocking finding may cite its id.
 */
export interface MappingRow {
  rowId: string;
  requirement: string;
  evidence: string;
}

export const MAX_MAPPING_ROWS = 50;

export interface DevelopmentReview {
  projectId: string;
  reviewId: string;
  developmentId: string;
  kind: ReviewKind;
  state: ReviewState;
  revision: number;
  candidate: ReviewCandidate;
  author?: ReviewAuthor;
  previousReviewId?: string;
  previousCandidateCommit?: string;
  /** Files changed between the previous candidate and this one, for a re-review. */
  changedPaths: string[];
  /** A final review's acceptance mapping, written for this candidate. */
  mapping?: MappingRow[];
  reviewer?: ReviewReviewer;
  findings: ReviewFinding[];
  reworks: ReviewRework[];
  verdict?: ReviewVerdict;
  /** Why the reviewed content no longer matches the fixed candidate. */
  drift?: string;
  createdAt: string;
  updatedAt: string;
}

/** The route Main chose before review: a recorded decision, not a quota. */
export interface ReviewPlan {
  projectId: string;
  developmentId: string;
  channel: ReviewChannel;
  basis: string;
  /** The author's own verification, distinct from an independent Reviewer's checks. */
  checks: ReviewCheck[];
  /** The integration version these checks actually ran on. */
  candidate: ReviewCandidate;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * What #04 may read as delivery qualification.
 *
 * `channel: "self"` with its checks is a complete answer for a small change:
 * missing a Reviewer report is not by itself a reason to refuse it.
 */
export interface ReviewQualification {
  developmentId: string;
  eligible: boolean;
  channel?: ReviewChannel;
  /** The current integration version. */
  candidate?: ReviewCandidate;
  /** The candidate an independent review actually approved. */
  approved?: ReviewCandidate;
  reviewId?: string;
  kind?: ReviewKind;
  independentReview: boolean;
  /** The candidate is the approved version plus a retro commit that touches only the pitfalls. */
  pitfallsAfterApproval?: true;
  reasons: string[];
}

const CONTROL = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const COMMIT = /^[0-9a-f]{7,64}$/;

function bounded(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new ProjectDataInvalidError(`${label}必须是字符串`);
  const text = value.trim();
  if (!text || text.length > max || CONTROL.test(text))
    throw new ProjectDataInvalidError(`${label}须为 1–${max} 个可打印字符`);
  return text;
}

function optionalBounded(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return bounded(value, label, max);
}

export function reviewChannel(value: unknown): ReviewChannel {
  if (typeof value !== "string" || !REVIEW_CHANNELS.includes(value as ReviewChannel))
    throw new ProjectDataInvalidError(`审查通道须为 ${REVIEW_CHANNELS.join(" / ")}`);
  return value as ReviewChannel;
}

export function reviewKind(value: unknown): ReviewKind {
  if (typeof value !== "string" || !REVIEW_KINDS.includes(value as ReviewKind))
    throw new ProjectDataInvalidError(`审查类型须为 ${REVIEW_KINDS.join(" / ")}`);
  return value as ReviewKind;
}

export function reviewState(value: unknown): ReviewState {
  if (typeof value !== "string" || !REVIEW_STATES.includes(value as ReviewState))
    throw new ProjectDataInvalidError(`审查状态须为 ${REVIEW_STATES.join(" / ")}`);
  return value as ReviewState;
}

export function findingState(value: unknown): FindingState {
  if (typeof value !== "string" || !FINDING_STATES.includes(value as FindingState))
    throw new ProjectDataInvalidError(`发现状态须为 ${FINDING_STATES.join(" / ")}`);
  return value as FindingState;
}

export function rulingDecision(value: unknown): RulingDecision {
  if (typeof value !== "string" || !RULING_DECISIONS.includes(value as RulingDecision))
    throw new ProjectDataInvalidError(`裁定须为 ${RULING_DECISIONS.join(" / ")}`);
  return value as RulingDecision;
}

export function dismissalCategory(value: unknown): DismissalCategory | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !DISMISSAL_CATEGORIES.includes(value as DismissalCategory))
    throw new ProjectDataInvalidError(`不采纳类别须为 ${DISMISSAL_CATEGORIES.join(" / ")}`);
  return value as DismissalCategory;
}

export function reviewCommit(value: unknown, label = "审查提交"): string {
  if (typeof value !== "string" || !COMMIT.test(value))
    throw new ProjectDataInvalidError(`${label}须为 7–64 位小写十六进制`);
  return value;
}

export function reviewCallId(value: unknown, label = "工作项 callId"): string {
  return ledgerIdentifier(value, label);
}

export function approachKind(value: unknown): ApproachKind {
  if (typeof value !== "string" || !APPROACH_KINDS.includes(value as ApproachKind))
    throw new ProjectDataInvalidError(`换办法须为 ${APPROACH_KINDS.join(" / ")}`);
  return value as ApproachKind;
}

/** A failed review Main accepted as it is, delivering what was done. */
export function acceptedPartially(review: DevelopmentReview): boolean {
  return review.state === "failed" && review.verdict?.approach?.kind === "deliver_partial";
}

/** A review whose candidate may go on: passed, or accepted as partial delivery. */
export function reviewApproved(review: DevelopmentReview): boolean {
  return review.state === "passed" || acceptedPartially(review);
}

/**
 * What a requirement's reviews let through, for the completion report.
 *
 * Main decides each of these alone, so each is listed with its reason: the
 * blocking findings it dismissed, the chains where it changed approach after
 * the rework rounds ran out, and every suggestion — the ones it picked up and
 * the ones left as they are.
 */
export interface ReviewReport {
  dismissed: {
    reviewId: string;
    ticketId?: string;
    findingId: string;
    title: string;
    category: DismissalCategory;
    basis: string;
  }[];
  approaches: { reviewId: string; ticketId?: string; kind: ApproachKind; basis: string; at: string }[];
  suggestions: {
    reviewId: string;
    ticketId?: string;
    findingId: string;
    title: string;
    location?: string;
    picked: boolean;
  }[];
}

export function reviewReport(
  reviews: DevelopmentReview[],
  ticketOf: (reviewId: string) => string | undefined
): ReviewReport {
  const report: ReviewReport = { dismissed: [], approaches: [], suggestions: [] };
  for (const review of reviews) {
    const ticketId = ticketOf(review.reviewId);
    const where = { reviewId: review.reviewId, ...(ticketId ? { ticketId } : {}) };
    for (const finding of review.findings) {
      if (!finding.blocking)
        report.suggestions.push({
          ...where,
          findingId: finding.findingId,
          title: finding.title,
          ...(finding.location ? { location: finding.location } : {}),
          picked: finding.state !== "suggestion"
        });
      else if (finding.state === "dismissed" && finding.ruling?.category)
        report.dismissed.push({
          ...where,
          findingId: finding.findingId,
          title: finding.title,
          category: finding.ruling.category,
          basis: finding.ruling.basis
        });
    }
    const approach = review.verdict?.approach;
    if (approach) report.approaches.push({ ...where, ...approach });
  }
  return report;
}

export function reviewBasis(value: unknown): string {
  return bounded(value, "裁定依据", 2000);
}

export function reviewChecks(value: unknown, label = "检查记录"): ReviewCheck[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20)
    throw new ProjectDataInvalidError(`${label}须为不超过 20 条`);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new ProjectDataInvalidError(`${label}必须是对象`);
    const input = item as Record<string, unknown>;
    const exitCode = Number(input.exitCode);
    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)
      throw new ProjectDataInvalidError(`${label}的退出码须为 0–255 的整数`);
    return {
      name: bounded(input.name, `${label}名称`, 200),
      ...(input.command === undefined ? {} : { command: bounded(input.command, `${label}命令`, 4000) }),
      exitCode,
      output: typeof input.output === "string" ? input.output.slice(0, 8000) : "",
      at: input.at === undefined ? now() : bounded(input.at, `${label}时间`, 100)
    };
  });
}

export function reviewPlanInput(value: unknown): {
  channel: ReviewChannel;
  basis: string;
  checks: ReviewCheck[];
  candidate: ReviewCandidate;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("审查通道判断必须是对象");
  const input = value as Record<string, unknown>;
  return {
    channel: reviewChannel(input.channel),
    basis: bounded(input.basis, "审查通道依据", 2000),
    checks: reviewChecks(input.checks),
    candidate: reviewCandidate(input.candidate)
  };
}

export function reviewCandidate(value: unknown): ReviewCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("审查候选必须是对象");
  const input = value as Record<string, unknown>;
  return {
    commit: reviewCommit(input.commit, "候选提交"),
    tree: reviewCommit(input.tree, "候选树"),
    branch: bounded(input.branch, "候选分支", 200),
    workspace: ledgerProjectDirectory(input.workspace)
  };
}

export function reviewAuthor(value: unknown): ReviewAuthor {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("候选执行身份必须是对象");
  const input = value as Record<string, unknown>;
  return {
    role: "executor",
    callId: reviewCallId(input.callId, "执行工作项 callId"),
    agentId: reviewCallId(input.agentId, "执行工作项身份"),
    workspace: ledgerProjectDirectory(input.workspace)
  };
}

export function reviewReviewer(value: unknown): ReviewReviewer {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("审查身份必须是对象");
  const input = value as Record<string, unknown>;
  if (input.role !== "reviewer") throw new ProjectDataInvalidError("审查身份角色须为 reviewer");
  return {
    role: "reviewer",
    taskId: ledgerIdentifier(input.taskId, "审查任务"),
    callId: reviewCallId(input.callId, "审查工作项 callId"),
    agentId: reviewCallId(input.agentId, "审查工作项身份"),
    workspace: ledgerProjectDirectory(input.workspace),
    ...(input.conclusion === undefined ? {} : { conclusion: reviewerConclusion(input.conclusion) })
  };
}

function reviewerConclusion(value: unknown): ReviewerConclusion {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("审查者结论必须是对象");
  const input = value as Record<string, unknown>;
  if (input.verdict !== "pass" && input.verdict !== "changes_requested")
    throw new ProjectDataInvalidError("审查者结论须为 pass / changes_requested");
  let previousFindings: ReviewerConclusion["previousFindings"];
  if (input.previousFindings !== undefined) {
    if (!Array.isArray(input.previousFindings) || input.previousFindings.length > 50)
      throw new ProjectDataInvalidError("上一轮发现的答复须为不超过 50 条");
    previousFindings = input.previousFindings.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new ProjectDataInvalidError("上一轮发现的答复必须是对象");
      const answer = entry as Record<string, unknown>;
      if (typeof answer.fixed !== "boolean") throw new ProjectDataInvalidError("答复须写明是否修好");
      return {
        findingId: ledgerIdentifier(answer.findingId, "答复的发现 ID"),
        fixed: answer.fixed,
        evidence: bounded(answer.evidence, "答复证据", 4000)
      };
    });
  }
  return {
    verdict: input.verdict,
    ...(previousFindings ? { previousFindings } : {}),
    at: bounded(input.at, "审查者结论时间", 100)
  };
}

function reviewApproach(value: unknown): ReviewApproach {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("换办法记录必须是对象");
  const input = value as Record<string, unknown>;
  return {
    kind: approachKind(input.kind),
    basis: bounded(input.basis, "换办法理由", 2000),
    at: bounded(input.at, "换办法时间", 100)
  };
}

export function reviewRework(value: unknown): ReviewRework {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("返修记录必须是对象");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.findingIds) || input.findingIds.length === 0)
    throw new ProjectDataInvalidError("返修记录须关联至少一条发现");
  return {
    fromCallId: reviewCallId(input.fromCallId, "原执行工作项 callId"),
    fromAgentId: reviewCallId(input.fromAgentId, "原执行工作项身份"),
    continuationCallId: reviewCallId(input.continuationCallId, "返修工作项 callId"),
    agentId: reviewCallId(input.agentId, "返修工作项身份"),
    workspace: ledgerProjectDirectory(input.workspace),
    findingIds: input.findingIds.map((entry) => reviewCallId(entry, "返修发现")),
    at: input.at === undefined ? now() : bounded(input.at, "返修时间", 100)
  };
}

function reviewRuling(value: unknown): ReviewRuling {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("裁定记录必须是对象");
  const input = value as Record<string, unknown>;
  const decision = rulingDecision(input.decision);
  const category = dismissalCategory(input.category);
  if (decision === "dismiss" && !category) throw new ProjectDataInvalidError("不采纳的裁定须记录原因类别");
  return {
    rulingId: ledgerIdentifier(input.rulingId, "裁定 ID"),
    decision,
    ...(category ? { category } : {}),
    basis: reviewBasis(input.basis),
    candidateCommit: reviewCommit(input.candidateCommit, "裁定时候选提交"),
    at: input.at === undefined ? now() : bounded(input.at, "裁定时间", 100)
  };
}

function reviewFindingSource(value: unknown): ReviewFindingSource {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("发现来源必须是对象");
  const input = value as Record<string, unknown>;
  if (input.role !== "reviewer") throw new ProjectDataInvalidError("发现来源角色须为 reviewer");
  return {
    role: "reviewer",
    callId: reviewCallId(input.callId, "发现来源 callId"),
    agentId: reviewCallId(input.agentId, "发现来源身份")
  };
}

export function reviewFinding(value: unknown): ReviewFinding {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("审查发现必须是对象");
  const input = value as Record<string, unknown>;
  return {
    findingId: ledgerIdentifier(input.findingId, "发现 ID"),
    title: bounded(input.title, "发现标题", 300),
    detail: bounded(input.detail, "发现说明", 4000),
    ...(optionalBounded(input.location, "发现位置", 1000)
      ? { location: optionalBounded(input.location, "发现位置", 1000)! }
      : {}),
    blocking: input.blocking !== false,
    ...(optionalBounded(input.basis, "发现依据", 40)
      ? { basis: optionalBounded(input.basis, "发现依据", 40)! }
      : {}),
    candidateCommit: reviewCommit(input.candidateCommit, "发现时候选提交"),
    state: findingState(input.state),
    checks: reviewChecks(input.checks, "发现检查记录"),
    ...(optionalBounded(input.rawFailure, "失败原件", 8000)
      ? { rawFailure: optionalBounded(input.rawFailure, "失败原件", 8000)! }
      : {}),
    ...(input.source === undefined ? {} : { source: reviewFindingSource(input.source) }),
    ...(input.ruling === undefined ? {} : { ruling: reviewRuling(input.ruling) }),
    ...(input.fixedCommit === undefined ? {} : { fixedCommit: reviewCommit(input.fixedCommit, "修复提交") }),
    ...(input.verifiedByReviewId === undefined
      ? {}
      : { verifiedByReviewId: ledgerIdentifier(input.verifiedByReviewId, "验证审查 ID") }),
    createdAt: bounded(input.createdAt, "发现创建时间", 100),
    updatedAt: bounded(input.updatedAt, "发现更新时间", 100)
  };
}

export function reviewFindingInput(value: unknown): {
  title: string;
  detail: string;
  location?: string;
  blocking: boolean;
  basis?: string;
  checks: ReviewCheck[];
  rawFailure?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("审查发现必须是对象");
  const input = value as Record<string, unknown>;
  const location = optionalBounded(input.location, "发现位置", 1000);
  const rawFailure = optionalBounded(input.rawFailure, "失败原件", 8000);
  const basis = optionalBounded(input.basis, "发现依据", 40);
  if (typeof input.blocking !== "boolean")
    throw new ProjectDataInvalidError("发现须写明是否拦截（blocking）");
  return {
    title: bounded(input.title, "发现标题", 300),
    detail: bounded(input.detail, "发现说明", 4000),
    ...(location ? { location } : {}),
    blocking: input.blocking,
    ...(basis ? { basis } : {}),
    checks: reviewChecks(input.checks, "发现检查记录"),
    ...(rawFailure ? { rawFailure } : {})
  };
}

export function reviewVerdict(value: unknown): ReviewVerdict {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("审查结论必须是对象");
  const input = value as Record<string, unknown>;
  return {
    summary: bounded(input.summary, "审查结论", 2000),
    checks: reviewChecks(input.checks, "复审检查记录"),
    at: input.at === undefined ? now() : bounded(input.at, "结论时间", 100),
    ...(input.approach === undefined ? {} : { approach: reviewApproach(input.approach) })
  };
}

/** Files changed between two candidates; kept bounded because it is a summary, not a diff. */
export function reviewChangedPaths(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 200)
    throw new ProjectDataInvalidError("复审改动文件须为不超过 200 条");
  return value.map((entry) => bounded(entry, "复审改动文件", 500));
}

/** Main's mapping as freeze_candidate takes it: rows of requirement and evidence, numbered here M1, M2… */
export function reviewMappingInput(value: unknown): MappingRow[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_MAPPING_ROWS)
    throw new ProjectDataInvalidError(`对照表须为 1–${MAX_MAPPING_ROWS} 行`);
  return value.map((entry, index) => {
    const row = (entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {}) as Record<
      string,
      unknown
    >;
    return {
      rowId: `M${index + 1}`,
      requirement: bounded(row.requirement, `对照表第 ${index + 1} 行的要求`, 1000),
      evidence: bounded(row.evidence, `对照表第 ${index + 1} 行的证据`, 2000)
    };
  });
}

/** A stored mapping, re-checked as it is read. */
export function reviewMapping(value: unknown): MappingRow[] {
  if (!Array.isArray(value) || value.length > MAX_MAPPING_ROWS)
    throw new ProjectDataInvalidError("对照表记录无效");
  return value.map((entry, index) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    if (row.rowId !== `M${index + 1}`) throw new ProjectDataInvalidError("对照表行号须依次为 M1、M2…");
    return {
      rowId: row.rowId,
      requirement: bounded(row.requirement, "对照表要求", 1000),
      evidence: bounded(row.evidence, "对照表证据", 2000)
    };
  });
}

/** Validate a new review row; the identifier and timestamps are assigned by the store. */
export function reviewCreate(value: Record<string, unknown>): {
  developmentId: string;
  kind: ReviewKind;
  candidate: ReviewCandidate;
  author?: ReviewAuthor;
  previousReviewId?: string;
  previousCandidateCommit?: string;
  changedPaths: string[];
  mapping?: MappingRow[];
} {
  const author = value.author === undefined ? undefined : reviewAuthor(value.author);
  return {
    developmentId: ledgerIdentifier(value.developmentId, "开发记录 ID"),
    kind: reviewKind(value.kind),
    candidate: reviewCandidate(value.candidate),
    ...(author ? { author } : {}),
    ...(value.previousReviewId === undefined
      ? {}
      : { previousReviewId: ledgerIdentifier(value.previousReviewId, "上一次审查 ID") }),
    ...(value.previousCandidateCommit === undefined
      ? {}
      : { previousCandidateCommit: reviewCommit(value.previousCandidateCommit, "上一次候选提交") }),
    changedPaths: reviewChangedPaths(value.changedPaths),
    ...(value.mapping === undefined ? {} : { mapping: reviewMapping(value.mapping) })
  };
}

export function reviewUpdate(value: Record<string, unknown>): {
  expectedRevision: number;
  state?: ReviewState;
  reviewer?: ReviewReviewer;
  findings?: ReviewFinding[];
  reworks?: ReviewRework[];
  verdict?: ReviewVerdict;
  drift?: string;
} {
  const expectedRevision = Number(value.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    throw new ProjectDataInvalidError("审查更新须带上读取时的 revision");
  let findings: ReviewFinding[] | undefined;
  if (value.findings !== undefined) {
    if (!Array.isArray(value.findings) || value.findings.length > 50)
      throw new ProjectDataInvalidError("审查发现须为不超过 50 条");
    findings = value.findings.map(reviewFinding);
  }
  let reworks: ReviewRework[] | undefined;
  if (value.reworks !== undefined) {
    if (!Array.isArray(value.reworks) || value.reworks.length > 20)
      throw new ProjectDataInvalidError("返修记录须为不超过 20 条");
    reworks = value.reworks.map(reviewRework);
  }
  return {
    expectedRevision,
    ...(value.state === undefined ? {} : { state: reviewState(value.state) }),
    ...(value.reviewer === undefined ? {} : { reviewer: reviewReviewer(value.reviewer) }),
    ...(findings ? { findings } : {}),
    ...(reworks ? { reworks } : {}),
    ...(value.verdict === undefined ? {} : { verdict: reviewVerdict(value.verdict) }),
    ...(value.drift === undefined ? {} : { drift: bounded(value.drift, "漂移原因", 2000) })
  };
}
