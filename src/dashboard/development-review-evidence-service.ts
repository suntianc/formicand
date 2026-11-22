import { conflict } from "./development-errors.js";
import { dirname, join, resolve } from "node:path";
import {
  parseReviewConclusion,
  type ReviewConclusion,
  type ReviewScope
} from "../runtime/subagent-review.js";
import {
  dismissalCategory,
  reviewBasis,
  reviewFindingInput,
  reviewVerdict,
  rulingDecision,
  type DevelopmentReview,
  type ReviewCandidate,
  type ReviewFinding
} from "../domain/development-review.js";
import { completionCriterionIds, ticketOfReview, type RereviewBrief } from "../domain/development-ticket.js";
import { developmentIdentifier } from "../domain/project-development.js";
import { ProjectDataNotFoundError } from "../domain/project-ledger.js";
import { id, now } from "../domain/types.js";
import type { ProjectDataGateway } from "../workspace/project-data-service.js";
import { git } from "../workspace/development-workspace.js";
import { releaseReviewSite } from "../workspace/review-site.js";
import type { ProjectDevelopmentPorts } from "./project-development-service.js";
import type { createDevelopmentWorkspaceService } from "./development-workspace-service.js";

export function createDevelopmentReviewEvidenceService({
  gateway,
  ports,
  requireCall
}: {
  gateway: () => Promise<ProjectDataGateway>;
  ports: Pick<ProjectDevelopmentPorts, "backendId" | "call">;
  requireCall: ReturnType<typeof createDevelopmentWorkspaceService>["requireCall"];
}) {
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

  return {
    reviewScopeOf,
    releaseDevelopmentReviewSites,
    attachReviewer,
    recordFinding,
    ruleFinding,
    recordRework,
    completeReview
  };
}
