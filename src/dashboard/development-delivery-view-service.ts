import { conflict } from "./development-errors.js";
import { reviewReport, type DevelopmentReview, type ReviewPlan } from "../domain/development-review.js";
import { type DevelopmentMerge } from "../domain/development-merge.js";
import {
  type DeliveryDiff,
  type DeliveryPatch,
  type DeliveryPhase,
  type DeliveryRoleProgress,
  type DeliveryStage,
  type DeliveryView,
  type DevelopmentDelivery
} from "../domain/development-delivery.js";
import { ticketOfReview } from "../domain/development-ticket.js";
import { developmentIdentifier, type DevelopmentRecord } from "../domain/project-development.js";
import { ProjectDataNotFoundError } from "../domain/project-ledger.js";
import type { ProjectDataGateway } from "../workspace/project-data-service.js";
import { git } from "../workspace/development-workspace.js";
import { createDevelopmentMergeService } from "./project-development-merge-service.js";
import type { DevelopmentReadOptions, ProjectDevelopmentPorts } from "./project-development-service.js";
import type { createDevelopmentWorkspaceService } from "./development-workspace-service.js";
import { ProjectFileMissing, resolveProjectFile } from "../workspace/project-files.js";
import type { createDevelopmentReadinessService } from "./development-readiness-service.js";
/** Longest patch text one preview reads; a larger change is cut and marked truncated. */
const DELIVERY_PATCH_LIMIT = 200_000;
/** Longest single file the preview renders as content; a larger file is read from its patch. */
const DELIVERY_FILE_LIMIT = 120_000;

export function createDevelopmentDeliveryViewService({
  ports,
  mergeService,
  gateway,
  project,
  deliveryQualification
}: {
  ports: Pick<ProjectDevelopmentPorts, "call" | "backendId">;
  mergeService: Pick<
    ReturnType<typeof createDevelopmentMergeService>,
    "replayBeforeRead" | "pendingDelivery"
  >;
  gateway: () => Promise<ProjectDataGateway>;
  project: ReturnType<typeof createDevelopmentWorkspaceService>["project"];
  deliveryQualification: ReturnType<typeof createDevelopmentReadinessService>["deliveryQualification"];
}) {
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
    await mergeService.replayBeforeRead(projectId, options);
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
    const pending = await mergeService.pendingDelivery(projectId, record.developmentId);
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
   * Every requirement's phase records in one read per project, keyed by
   * requirement. The current development is the one find_by_requirement
   * returns: an open one first, else the latest. A requirement without a
   * development has no entry.
   */
  async function deliveryPhases(
    projectId: string,
    options: DevelopmentReadOptions = {}
  ): Promise<Record<string, DeliveryPhase>> {
    await project(projectId);
    await mergeService.replayBeforeRead(projectId, options);
    const service = await gateway();
    const [developments, reviews, merges, deliveries] = await Promise.all([
      service.queryDevelopments(projectId, ports.backendId),
      service.queryReviews(projectId),
      service.queryMerges(projectId),
      service.queryDeliveries(projectId)
    ]);
    const open = (record: DevelopmentRecord) => record.status === "active" || record.status === "paused";
    const current = new Map<string, DevelopmentRecord>();
    for (const record of developments) {
      const held = current.get(record.requirementId);
      const newer =
        !held ||
        (open(record) && !open(held)) ||
        (open(record) === open(held) &&
          `${record.createdAt}|${record.developmentId}` > `${held.createdAt}|${held.developmentId}`);
      if (newer) current.set(record.requirementId, record);
    }
    const phases: Record<string, DeliveryPhase> = {};
    for (const [requirementId, development] of current) {
      const id = development.developmentId;
      const plan = await service.reviewPlan(projectId, id);
      const { tickets } = await service.tickets(projectId, id);
      const delivery = deliveries.filter((entry) => entry.developmentId === id).at(-1);
      phases[requirementId] = {
        development,
        ...(plan ? { plan } : {}),
        reviews: reviews.filter((entry) => entry.developmentId === id),
        merges: merges.filter((entry) => entry.developmentId === id),
        ...(delivery ? { delivery } : {}),
        tickets
      };
    }
    return phases;
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

  /**
   * Where one changed file sits in the checkout this backend owns, for the
   * desktop to hand to an application. Only a file the delivery diff lists.
   */
  async function deliveryFileLocation(
    projectId: string,
    input: { developmentId?: unknown; requirementId?: unknown; path?: unknown },
    options: DevelopmentReadOptions = {}
  ): Promise<{ absolutePath: string }> {
    await project(projectId);
    const { record, plan, reviews, merges, delivery } = await resolvedDelivery(projectId, input, options);
    const workspace = record.workspace;
    if (!workspace || workspace.state !== "ready")
      throw conflict("需求现场不在这台设备上，无法打开文件", "delivery_patch_unavailable");
    const diff = await deliveryDiff(record, delivery, merges, plan, reviews);
    if (!diff) throw conflict("这台设备读不到需求现场，无法打开文件", "delivery_patch_unavailable");
    const path = typeof input.path === "string" ? input.path : "";
    if (!diff.files.some((file) => file.path === path))
      throw conflict("该文件不在这次改动中", "delivery_patch_path_unknown");
    try {
      return { absolutePath: (await resolveProjectFile(workspace.directory, path)).absolutePath };
    } catch (error) {
      if (error instanceof ProjectFileMissing)
        throw conflict("这个文件在需求现场里已不存在", "delivery_file_missing");
      throw error;
    }
  }

  return { deliveryView, deliveryPhases, deliveryPatch, deliveryFileLocation };
}
