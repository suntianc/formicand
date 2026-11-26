import { conflict } from "./development-errors.js";
import {
  approachKind,
  reviewBasis,
  reviewKind,
  reviewMappingInput,
  reviewPlanInput,
  type ApproachKind,
  type DevelopmentReview
} from "../domain/development-review.js";
import { finalReviews, ticketOfReview } from "../domain/development-ticket.js";
import { developmentIdentifier, type DevelopmentRecord } from "../domain/project-development.js";
import {
  hasRegistryProblems,
  problemsSince,
  REGISTRY_FILE,
  registryProblems
} from "../domain/project-documents.js";
import { independentReviewReason, parseReviewRules } from "../domain/review-rules.js";
import { now } from "../domain/types.js";
import type { ProjectDataGateway } from "../workspace/project-data-service.js";
import {
  gitPaths,
  gitProbe,
  documentsAdded,
  documentsAt,
  fileAt
} from "../workspace/development-workspace.js";
import type { createDevelopmentWorkspaceService } from "./development-workspace-service.js";
import { chainOf, roundBudget, checkRound, previousRound } from "./development-review-rounds.js";
import type { createDevelopmentTicketService } from "./development-ticket-service.js";

export function createDevelopmentReviewStartService({
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
}: {
  gateway: () => Promise<ProjectDataGateway>;
  currentCandidate: ReturnType<typeof createDevelopmentWorkspaceService>["currentCandidate"];
  lastIntegration: ReturnType<typeof createDevelopmentTicketService>["lastIntegration"];
  requireTicket: ReturnType<typeof createDevelopmentTicketService>["requireTicket"];
  requireCall: ReturnType<typeof createDevelopmentWorkspaceService>["requireCall"];
  inspectDirectory: ReturnType<typeof createDevelopmentTicketService>["inspectDirectory"];
  inspectWorkspace: ReturnType<typeof createDevelopmentWorkspaceService>["inspectWorkspace"];
  ticketChangedPaths: ReturnType<typeof createDevelopmentTicketService>["ticketChangedPaths"];
  openDevelopment: ReturnType<typeof createDevelopmentWorkspaceService>["openDevelopment"];
  inDevelopment: ReturnType<typeof createDevelopmentWorkspaceService>["inDevelopment"];
  requiredMergeConfig: ReturnType<typeof createDevelopmentWorkspaceService>["requiredMergeConfig"];
  fromIntegration: ReturnType<typeof createDevelopmentTicketService>["fromIntegration"];
}) {
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
    if (
      !last ||
      !(await fromIntegration(projectId, record.workspace!.directory, last.commit, candidate.commit))
    )
      throw conflict(
        "需求现场不是最后一次并入票的版本；不要在现场直接提交改动，目标分支的新提交用 sync_target 合并",
        "candidate_changed"
      );
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
              await gitPaths(record.workspace!.directory, [
                "diff",
                "--name-only",
                `${previous.candidate.commit}..${candidate.commit}`
              ])
            ).slice(0, 200)
          }
        : {})
    });
  }

  /**
   * Freeze one ticket's own checkout for review.
   *
   * The candidate is the Executor's committed work, not the requirement
   * checkout, so each ticket is reviewed on its own; a file it changed outside
   * the ticket's scope is left to the Reviewer to judge.
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
    if (!ticket.work)
      throw conflict(
        `票 ${ticket.ticketId} 还没有开工：start_ticket 自己写，或派给 Executor`,
        "ticket_not_started"
      );
    if (ticket.state !== "in_progress" && ticket.state !== "rework")
      throw conflict(`票 ${ticket.ticketId} 现在不能送审`, "ticket_state_conflict");
    // A ticket Main writes itself has no Executor call to wait for.
    const fact = ticket.work.callId ? await requireCall(taskId, ticket.work.callId) : undefined;
    if (fact && fact.status !== "completed")
      throw conflict(
        `票 ${ticket.ticketId} 的 Executor ${fact.callId} 还没有完成（${fact.status}）`,
        "ticket_work_running"
      );
    const current = await inspectDirectory(ticket.work.workspace);
    if (current.changes)
      throw conflict(
        fact ? "票的现场有未提交改动；让 Executor 提交后再冻结" : "票的现场有未提交改动；提交后再冻结",
        "review_candidate_dirty"
      );
    const integration = await inspectWorkspace(record);
    const changed = await ticketChangedPaths(record.workspace!.directory, integration.commit, current.commit);
    if (!changed.length) throw conflict(`票 ${ticket.ticketId} 的现场没有新提交`, "ticket_no_changes");
    const { tickets } = await service.tickets(projectId, developmentId);
    const chain = chainOf(tickets, await service.queryReviews(projectId, developmentId), ticket);
    checkRound(chain, tickets, ticket);
    const previous = previousRound(chain, input.previousReviewId, current.commit);
    // A re-review looks at what this round changed, not everything since the fork.
    const roundChanges = previous
      ? await gitPaths(record.workspace!.directory, [
          "diff",
          "--name-only",
          "--no-renames",
          `${previous.candidate.commit}..${current.commit}`
        ])
      : changed;
    const review = await service.createReview(projectId, developmentId, {
      kind: "independent",
      candidate: {
        commit: current.commit,
        tree: current.tree,
        branch: current.branch,
        workspace: current.workspace
      },
      ...(fact
        ? {
            author: {
              role: "executor" as const,
              callId: fact.callId,
              agentId: fact.agentId,
              workspace: ticket.work.workspace
            }
          }
        : {}),
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
      const reason = await selfCheckRefusal(projectId, record, current.commit);
      if (reason)
        throw conflict(
          `这次改动须独立审查，不能只靠自查：${reason}。改用 review_plan channel=independent，再 freeze_candidate`,
          "independent_review_required"
        );
    }
    return (await gateway()).setReviewPlan(projectId, developmentId, plan);
  }

  /**
   * Why this change may not rest on Main's own checks. The rules are read at
   * the development's baseline, so the change cannot loosen its own; the files
   * are the ones it changed since the target branch, so target commits merged
   * into the checkout do not count as its own. A target that lives in another
   * repository is not visible here; the baseline stands in for it.
   */
  async function selfCheckRefusal(projectId: string, record: DevelopmentRecord, commit: string) {
    const directory = record.workspace!.directory;
    const { targetBranch } = await requiredMergeConfig(projectId);
    const target = await gitProbe(directory, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${targetBranch}`
    ]);
    const rules = parseReviewRules(await fileAt(directory, record.baseline.commit, REGISTRY_FILE));
    const changed = await gitPaths(directory, [
      "diff",
      "--name-only",
      "--no-renames",
      `${target ?? record.baseline.commit}...${commit}`
    ]);
    return independentReviewReason(rules, changed);
  }

  function startReview(projectId: string, taskId: string | undefined, input: Record<string, unknown>) {
    return inDevelopment(projectId, input, (record) => startReviewNow(projectId, taskId, record, input));
  }

  async function startReviewNow(
    projectId: string,
    taskId: string | undefined,
    record: DevelopmentRecord,
    input: Record<string, unknown>
  ): Promise<DevelopmentReview> {
    const developmentId = record.developmentId;
    const final = input.ticketId === undefined && record.route === "full";
    if (input.mapping !== undefined && !final)
      throw conflict("只有 full 路线的整体终审带对照表", "review_mapping_unexpected");
    if (input.ticketId !== undefined) return startTicketReview(projectId, taskId, record, input);
    if (final) return startFinalReview(projectId, record, input);
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
        await gitPaths(record.workspace!.directory, [
          "diff",
          "--name-only",
          `${previous.candidate.commit}..${candidate.commit}`
        ])
      ).slice(0, 200);
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

  return { changeApproach, setReviewPlan, startReview };
}
