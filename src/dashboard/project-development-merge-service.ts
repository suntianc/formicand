import { join } from "node:path";
import type { DevelopmentMerge } from "../domain/development-merge.js";
import { deliveryFromMerge, type DevelopmentDelivery } from "../domain/development-delivery.js";
import { developmentIdentifier, type MergeConfig } from "../domain/project-development.js";
import { ProjectDataConflictError } from "../domain/project-ledger.js";
import { now } from "../domain/types.js";
import type { ProjectDataGateway } from "../workspace/project-data-service.js";
import { DeliveryOutbox, type DeliveryIntent } from "../workspace/delivery-outbox.js";
import {
  isAncestor,
  mergeCandidate,
  publishMerge,
  removeMergeSite,
  runMergeChecks,
  targetTip
} from "../workspace/project-merge.js";

import type {
  DevelopmentReadOptions,
  DevelopmentProject,
  ProjectDevelopmentPorts
} from "./project-development-service.js";

interface DevelopmentMergePorts extends Pick<
  ProjectDevelopmentPorts,
  "backendId" | "startedAt" | "developmentRoot" | "deliveryRoot" | "mergeFaultInject"
> {
  gateway(): Promise<ProjectDataGateway>;
  ensureProject(projectId: string): Promise<DevelopmentProject>;
  requiredMergeConfig(projectId: string): Promise<MergeConfig>;
  acceptanceReasons(projectId: string, merge: DevelopmentMerge): Promise<string[]>;
  releaseReviewSites(projectId: string, developmentId: string): Promise<void>;
}

/** Owns the local publication queue and recovery for this execution backend. */
export function createDevelopmentMergeService(ports: DevelopmentMergePorts) {
  const { gateway } = ports;
  const deliveryOutbox = new DeliveryOutbox(
    ports.deliveryRoot ?? join(ports.developmentRoot, "delivery-sync")
  );

  const conflict = (message: string, code: string) => new ProjectDataConflictError(message, undefined, code);

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
      const reasons = await ports.acceptanceReasons(projectId, merge);
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
    await ports.ensureProject(projectId);
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
    const merge = await service.getMerge(projectId, intent.mergeId).catch(() => undefined);
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
    // Let lookup errors reach the per-intent retry boundary, before any cleanup.
    const tip = await targetTip(config.repository, merge.targetBranch);
    if (tip && (await isAncestor(config.repository, intent.mergedCommit, tip))) {
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
    await ports.ensureProject(projectId);
    const config = await ports.requiredMergeConfig(projectId);
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
        if (merged.state === "merged") await ports.releaseReviewSites(projectId, merged.developmentId);
      }
      return processed;
    });
  }

  async function pendingDelivery(
    projectId: string,
    developmentId: string
  ): Promise<DeliveryIntent | undefined> {
    // eslint-disable-next-line no-restricted-syntax -- 本地 outbox 读失败时视为没有待同步条目，条目仍在盘上等下次重放
    return [...(await deliveryOutbox.list(projectId).catch(() => []))]
      .reverse()
      .find((intent) => intent.developmentId === developmentId);
  }

  return {
    applyMerges,
    pendingDelivery,
    replayBeforeRead,
    retryDevelopmentDelivery,
    resumePendingDeliveries,
    startDeliveryRecovery,
    stopDeliveryRecovery
  };
}
