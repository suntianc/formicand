import { conflict } from "./development-errors.js";
import {
  PITFALLS_DIRECTORY,
  hasRetroSignals,
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
  type MergeRetro
} from "../domain/development-merge.js";
import { PITFALLS_INDEX_PAGE, pitfallProblems } from "../domain/pitfall-entries.js";
import {
  developmentIdentifier,
  developmentNotActive,
  type DevelopmentRecord
} from "../domain/project-development.js";
import { now } from "../domain/types.js";
import type { ProjectDataGateway } from "../workspace/project-data-service.js";
import { changedPagesUnder, fileAt } from "../workspace/development-workspace.js";
import { createDevelopmentMergeService } from "./project-development-merge-service.js";
import type { ProjectDevelopmentPorts } from "./project-development-service.js";
import type { createDevelopmentWorkspaceService } from "./development-workspace-service.js";
import type { createDevelopmentReadinessService } from "./development-readiness-service.js";
import type { createDevelopmentTicketService } from "./development-ticket-service.js";

export function createDevelopmentMergeRequestService({
  gateway,
  project,
  reviewDevelopment,
  requiredMergeConfig,
  deliveryQualification,
  recordedMergeChecks,
  ticketRoute,
  ports,
  mergeService
}: {
  gateway: () => Promise<ProjectDataGateway>;
  project: ReturnType<typeof createDevelopmentWorkspaceService>["project"];
  reviewDevelopment: ReturnType<typeof createDevelopmentWorkspaceService>["reviewDevelopment"];
  requiredMergeConfig: ReturnType<typeof createDevelopmentWorkspaceService>["requiredMergeConfig"];
  deliveryQualification: ReturnType<typeof createDevelopmentReadinessService>["deliveryQualification"];
  recordedMergeChecks: ReturnType<typeof createDevelopmentReadinessService>["recordedMergeChecks"];
  ticketRoute: ReturnType<typeof createDevelopmentTicketService>["ticketRoute"];
  ports: Pick<ProjectDevelopmentPorts, "backendId">;
  mergeService: Pick<ReturnType<typeof createDevelopmentMergeService>, "applyMerges">;
}) {
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

  /**
   * Record a merge request and, on the backend that owns the target, apply it.
   *
   * Without `settled` the call waits for the merge and returns its result. With
   * it the call returns the recorded request at once (after calling `applying`),
   * and `settled` receives the merge once the checks on the combined version and
   * the update are done.
   */
  async function requestMerge(
    projectId: string,
    input: Record<string, unknown>,
    settled?: (merge: DevelopmentMerge) => Promise<void>,
    applying?: () => void
  ): Promise<DevelopmentMerge> {
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
    if (record.status !== "active") throw conflict(developmentNotActive(record.status), "development_closed");
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
    const applied = mergeService
      .applyMerges(projectId)
      .then(
        async (merges) =>
          merges.find((entry) => entry.mergeId === created.mergeId) ??
          service.getMerge(projectId, created.mergeId)
      );
    if (!settled) return applied;
    applying?.();
    void applied
      .then(settled, async (error: unknown) =>
        settled({
          ...(await service.getMerge(projectId, created.mergeId)),
          detail: error instanceof Error ? error.message : String(error)
        })
      )
      // The merge record holds the outcome; a lost notice costs only Main's prompt wake.
      .catch((error: unknown) => console.error("通知 Main 合入结果失败", error));
    return created;
  }

  return { requestMerge };
}
