import {
  ledgerIdentifier,
  ledgerProjectId,
  ProjectDataConflictError,
  ProjectDataNotFoundError
} from "../domain/project-ledger.js";
import {
  reviewAuthor,
  reviewCandidate,
  reviewChangedPaths,
  reviewChecks,
  reviewCreate,
  reviewMapping,
  reviewFinding,
  reviewPlanInput,
  reviewRework,
  reviewReviewer,
  reviewState,
  reviewUpdate,
  reviewVerdict,
  type DevelopmentReview,
  type ReviewKind,
  type ReviewPlan
} from "../domain/development-review.js";
import { developmentIdentifier } from "../domain/project-development.js";
import { id, now } from "../domain/types.js";
import type { SqlTransaction } from "../storage/project-data/database.js";

import type { DevelopmentRepository } from "./development-repository.js";
import { storedArray, storedJson } from "./project-data-json.js";

interface ReviewPlanRow {
  project_id: string;
  development_id: string;
  channel: string;
  basis: string;
  checks: string;
  candidate_commit: string;
  candidate_tree: string;
  candidate_branch: string;
  candidate_workspace: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
interface ReviewRow {
  project_id: string;
  review_id: string;
  development_id: string;
  kind: string;
  state: string;
  revision: number;
  candidate_commit: string;
  candidate_tree: string;
  candidate_branch: string;
  candidate_workspace: string;
  author: string | null;
  previous_review_id: string | null;
  previous_candidate_commit: string | null;
  changed_paths: string;
  mapping: string | null;
  reviewer: string | null;
  findings: string;
  reworks: string;
  verdict: string | null;
  drift: string | null;
  created_at: string;
  updated_at: string;
}
function planOf(row: ReviewPlanRow): ReviewPlan {
  return {
    projectId: row.project_id,
    developmentId: row.development_id,
    channel: row.channel as ReviewPlan["channel"],
    basis: row.basis,
    checks: reviewChecks(storedArray(row.checks, "审查通道检查")),
    candidate: reviewCandidate({
      commit: row.candidate_commit,
      tree: row.candidate_tree,
      branch: row.candidate_branch,
      workspace: row.candidate_workspace
    }),
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function reviewOf(row: ReviewRow): DevelopmentReview {
  return {
    projectId: row.project_id,
    reviewId: row.review_id,
    developmentId: row.development_id,
    kind: row.kind as ReviewKind,
    state: reviewState(row.state),
    revision: Number(row.revision),
    candidate: reviewCandidate({
      commit: row.candidate_commit,
      tree: row.candidate_tree,
      branch: row.candidate_branch,
      workspace: row.candidate_workspace
    }),
    ...(row.author ? { author: reviewAuthor(storedJson(row.author, "候选执行身份")) } : {}),
    ...(row.previous_review_id ? { previousReviewId: row.previous_review_id } : {}),
    ...(row.previous_candidate_commit ? { previousCandidateCommit: row.previous_candidate_commit } : {}),
    changedPaths: reviewChangedPaths(storedJson(row.changed_paths, "复审改动文件")),
    ...(row.mapping ? { mapping: reviewMapping(storedJson(row.mapping, "对照表")) } : {}),
    ...(row.reviewer ? { reviewer: reviewReviewer(storedJson(row.reviewer, "审查身份")) } : {}),
    findings: storedArray(row.findings, "审查发现").map(reviewFinding),
    reworks: storedArray(row.reworks, "返修记录").map(reviewRework),
    ...(row.verdict ? { verdict: reviewVerdict(storedJson(row.verdict, "审查结论")) } : {}),
    ...(row.drift ? { drift: row.drift } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class DevelopmentReviewRepository {
  constructor(
    private readonly transaction: SqlTransaction,
    private readonly lockRows: boolean,
    private readonly requireProject: (projectId: string) => Promise<unknown>,
    private readonly developments: Pick<DevelopmentRepository, "requireDevelopment">
  ) {}

  async reviewPlan(projectIdValue: unknown, developmentIdValue: unknown): Promise<ReviewPlan | undefined> {
    const projectId = ledgerProjectId(projectIdValue);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    const rows = await this.transaction.query<ReviewPlanRow>(
      `SELECT * FROM project_data_development_review_plans
        WHERE project_id = ? AND development_id = ?`,
      [projectId, developmentId]
    );
    return rows[0] ? planOf(rows[0]) : undefined;
  }

  /** The latest channel decision for one development; a later write replaces it. */
  async setReviewPlan(
    projectIdValue: unknown,
    developmentIdValue: unknown,
    inputValue: unknown
  ): Promise<ReviewPlan> {
    const projectId = ledgerProjectId(projectIdValue);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    await this.developments.requireDevelopment(projectId, developmentId);
    const input = reviewPlanInput(inputValue);
    const timestamp = now();
    const existing = await this.reviewPlan(projectId, developmentId);
    const revision = (existing?.revision ?? 0) + 1;
    const checks = JSON.stringify(input.checks);
    const candidate = input.candidate;
    if (existing)
      await this.transaction.execute(
        `UPDATE project_data_development_review_plans
            SET channel = ?, basis = ?, checks = ?, candidate_commit = ?, candidate_tree = ?,
                candidate_branch = ?, candidate_workspace = ?, revision = ?, updated_at = ?
          WHERE project_id = ? AND development_id = ?`,
        [
          input.channel,
          input.basis,
          checks,
          candidate.commit,
          candidate.tree,
          candidate.branch,
          candidate.workspace,
          revision,
          timestamp,
          projectId,
          developmentId
        ]
      );
    else
      await this.transaction.execute(
        `INSERT INTO project_data_development_review_plans
           (project_id, development_id, channel, basis, checks, candidate_commit, candidate_tree,
            candidate_branch, candidate_workspace, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          projectId,
          developmentId,
          input.channel,
          input.basis,
          checks,
          candidate.commit,
          candidate.tree,
          candidate.branch,
          candidate.workspace,
          revision,
          timestamp,
          timestamp
        ]
      );
    return (await this.reviewPlan(projectId, developmentId))!;
  }

  /** Freeze one candidate as a new review; the Reviewer attaches to it separately. */
  async createReview(
    projectIdValue: unknown,
    developmentIdValue: unknown,
    inputValue: unknown
  ): Promise<DevelopmentReview> {
    const projectId = ledgerProjectId(projectIdValue);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    await this.developments.requireDevelopment(projectId, developmentId);
    const input = reviewCreate({
      ...(inputValue && typeof inputValue === "object" && !Array.isArray(inputValue)
        ? (inputValue as Record<string, unknown>)
        : {}),
      developmentId
    });
    if (input.mapping) {
      // requireDevelopment holds the parent row until this insert commits.
      const open = await this.transaction.query<{ review_id: string }>(
        `SELECT review_id FROM project_data_development_reviews
          WHERE project_id = ? AND development_id = ? AND mapping IS NOT NULL AND state = 'in_review' LIMIT 1`,
        [projectId, developmentId]
      );
      if (open.length)
        throw new ProjectDataConflictError("已有一份进行中的整体终审", undefined, "review_open");
    }
    if (input.previousReviewId) await this.requireReview(projectId, input.previousReviewId);
    const reviewId = id("review");
    const timestamp = now();
    await this.transaction.execute(
      `INSERT INTO project_data_development_reviews
         (project_id, review_id, development_id, kind, state, revision,
          candidate_commit, candidate_tree, candidate_branch, candidate_workspace,
          author, previous_review_id, previous_candidate_commit, changed_paths, mapping,
          reviewer, findings, reworks, verdict, drift, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        reviewId,
        developmentId,
        input.kind,
        "in_review",
        1,
        input.candidate.commit,
        input.candidate.tree,
        input.candidate.branch,
        input.candidate.workspace,
        input.author ? JSON.stringify(input.author) : null,
        input.previousReviewId ?? null,
        input.previousCandidateCommit ?? null,
        JSON.stringify(input.changedPaths),
        input.mapping ? JSON.stringify(input.mapping) : null,
        null,
        "[]",
        "[]",
        null,
        null,
        timestamp,
        timestamp
      ]
    );
    return this.getReview(projectId, reviewId);
  }

  async getReview(projectIdValue: unknown, reviewIdValue: unknown): Promise<DevelopmentReview> {
    const projectId = ledgerProjectId(projectIdValue);
    const reviewId = ledgerIdentifier(reviewIdValue, "审查 ID");
    return reviewOf(await this.requireReview(projectId, reviewId));
  }

  async queryReviews(projectIdValue: unknown, developmentIdValue?: unknown): Promise<DevelopmentReview[]> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.requireProject(projectId);
    const developmentId =
      developmentIdValue === undefined ? undefined : developmentIdentifier(developmentIdValue, "开发记录 ID");
    const rows = await this.transaction.query<ReviewRow>(
      `SELECT * FROM project_data_development_reviews
        WHERE project_id = ?${developmentId ? " AND development_id = ?" : ""}
        ORDER BY created_at ASC, review_id ASC`,
      developmentId ? [projectId, developmentId] : [projectId]
    );
    return rows.map(reviewOf);
  }

  /** Replace one review's mutable fields; a stale revision is refused, like a record update. */
  async updateReview(
    projectIdValue: unknown,
    reviewIdValue: unknown,
    inputValue: unknown
  ): Promise<DevelopmentReview> {
    const projectId = ledgerProjectId(projectIdValue);
    const reviewId = ledgerIdentifier(reviewIdValue, "审查 ID");
    const current = await this.requireReview(projectId, reviewId);
    const input = reviewUpdate(
      inputValue && typeof inputValue === "object" && !Array.isArray(inputValue)
        ? (inputValue as Record<string, unknown>)
        : {}
    );
    const timestamp = now();
    const changed = await this.transaction.execute(
      `UPDATE project_data_development_reviews
          SET state = ?, revision = ?, reviewer = ?, findings = ?, reworks = ?, verdict = ?, drift = ?, updated_at = ?
        WHERE project_id = ? AND review_id = ? AND revision = ?`,
      [
        input.state ?? current.state,
        Number(current.revision) + 1,
        input.reviewer === undefined ? current.reviewer : JSON.stringify(input.reviewer),
        input.findings === undefined ? current.findings : JSON.stringify(input.findings),
        input.reworks === undefined ? current.reworks : JSON.stringify(input.reworks),
        input.verdict === undefined ? current.verdict : JSON.stringify(input.verdict),
        input.drift === undefined ? current.drift : input.drift,
        timestamp,
        projectId,
        reviewId,
        input.expectedRevision
      ]
    );
    if (changed !== 1)
      throw new ProjectDataConflictError(
        "审查记录已被另一写入更新，请重新读取",
        undefined,
        "revision_conflict"
      );
    return this.getReview(projectId, reviewId);
  }

  private async requireReview(projectId: string, reviewId: string): Promise<ReviewRow> {
    const rows = await this.transaction.query<ReviewRow>(
      `SELECT * FROM project_data_development_reviews
        WHERE project_id = ? AND review_id = ?${this.lockRows ? " FOR UPDATE" : ""}`,
      [projectId, reviewId]
    );
    if (!rows.length) throw new ProjectDataNotFoundError("审查记录不存在");
    return rows[0];
  }
}
