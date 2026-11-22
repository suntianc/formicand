import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { id, now } from "../domain/types.js";
import { atomicWrite } from "../storage/atomic-file.js";
import { JsonlEventStore } from "../storage/event-store.js";
import { git } from "../workspace/development-workspace.js";
import { prepareReviewSite, releaseReviewSite, type ReviewSite } from "../workspace/review-site.js";
import { DurableScheduler, type WorkItem } from "./scheduler.js";
import { isTerminalWorkStatus, type SubagentWorkPayload as WorkPayload } from "./subagent-work.js";
import { prepareWorkItemSite } from "../workspace/work-item-workspace.js";
import {
  AgentProcessHost,
  agentProcessDirectory,
  type AgentProcessRecord,
  type AgentProcessRole
} from "./agent-process.js";
import { enqueueMainCallback, formatSubagentSummary } from "./subagent-callback.js";
import { SubagentSettlement, settledResult, type SubagentProcessResult } from "./subagent-settlement.js";
import { pitfallsHint } from "./project-pitfalls.js";

export type { SubagentProcessResult } from "./subagent-settlement.js";

/**
 * The backend side of delegated agent processes.
 *
 * It turns a queued work item into a Pi process, keeps the queue lease alive
 * while that process runs, and projects the process's result record back into
 * the queue, the Run events and Main's Inbox. After a restart it adopts the
 * processes the previous backend was watching; a process that ended without a
 * result record is a failure, never a success with an empty answer.
 */
export interface SubagentProcessServiceOptions {
  workspaceRoot: string;
  harnessRoot: string;
  /** Model connection and configuration facts the launcher needs. */
  env: NodeJS.ProcessEnv;
  /**
   * Per-item environment, resolved when that item actually starts.
   *
   * A role binding and its connection are read on this host at the start
   * boundary, so a binding changed while an item waited applies to this start,
   * and a recovered item re-reads the configuration instead of replaying one.
   */
  envFor?: (item: WorkItem) => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
  /** How often an adopted process's identity is checked. */
  pollMs?: number;
  /** Queue lease period; renewed every service cycle while the process runs. */
  leaseMs?: number;
  graceMs?: number;
  onSettled?: (result: SubagentProcessResult) => void | Promise<void>;
}
/** The roles this service launches and settles; Main belongs to the run service. */
const DELEGATED_ROLES = ["executor", "reviewer"] as const;
export class SubagentProcessService {
  private readonly settlement: SubagentSettlement;
  private readonly host: AgentProcessHost;
  private readonly workspaceRoot: string;
  private readonly leaseMs: number;
  /** One due timer per Run: the retry the queue scheduled next. */
  private readonly retryTimers = new Map<string, { due: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly options: SubagentProcessServiceOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.leaseMs = Math.max(1_000, options.leaseMs ?? 60_000);
    this.host = new AgentProcessHost({
      workspaceRoot: options.workspaceRoot,
      harnessRoot: options.harnessRoot,
      env: options.env,
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
      onExit: (record) => this.settle(record)
    });
    this.settlement = new SubagentSettlement(
      this.workspaceRoot,
      this.host,
      (run) => this.armQueueRetry(run),
      (result) => options.onSettled?.(result)
    );
  }

  /** Take over the still-running processes of a Run and settle those already gone. */
  async adopt(input: { taskId: string; runId: string }): Promise<void> {
    // A Run's directory also holds Main's process record; only delegated roles
    // belong to this service, and adopting Main's record would settle the Main.
    await this.host.adopt({ ...input, roles: DELEGATED_ROLES });
  }

  /** This Run's delegated process records, never Main's. */
  private async delegatedRecords(input: { taskId: string; runId: string }) {
    return (await this.host.records(input.taskId, input.runId)).filter((record) => record.role !== "main");
  }

  /**
   * Launch every queued item whose prerequisites are terminal.
   *
   * An item with a live process record is already being executed by this or a
   * previous backend. It is never started twice.
   */
  async startQueued(input: { taskId: string; runId: string }): Promise<SubagentProcessResult[]> {
    const scheduler = new DurableScheduler(this.queuePath(input));
    await scheduler.reclaimExpired();
    const records = await this.delegatedRecords(input);
    await this.redeliverUnstarted(scheduler, records);
    const items = await scheduler.list();
    const active = new Set(records.filter((record) => !record.settledAt).map((record) => record.callId));
    const statusOf = new Map(items.map((item) => [item.stepId, item.status]));
    const terminal = new Set(
      items.filter((item) => isTerminalWorkStatus(item.status)).map((item) => item.stepId)
    );
    const results: SubagentProcessResult[] = [];
    const workerId = `subagent-process-${process.pid}`;
    for (const item of items) {
      if (item.status !== "queued") continue;
      // A running process whose lease expired (this backend was slow or away)
      // gets that lease back instead of a second process for the same call.
      if (active.has(item.stepId)) {
        const running = records.find((record) => record.callId === item.stepId && !record.settledAt);
        const reclaimed = await scheduler.claim(workerId, this.leaseMs, item.stepId);
        if (running && reclaimed?.lease) await this.host.updateLease(running, reclaimed.lease.token);
        continue;
      }
      const payload = (item.payload ?? {}) as WorkPayload;
      const dependsOn = [...new Set(payload.dependsOn ?? [])];
      // A work item with an unfinished prerequisite stays queued and holds no
      // lease, so it is visible as pending without a worker owning it.
      if (dependsOn.some((stepId) => !terminal.has(stepId))) continue;
      // Every prerequisite is terminal. One that did not complete ends this
      // item without starting it: an item that can never run must be settled
      // too, or its Task would wait for it forever.
      const failed = dependsOn.filter((stepId) => statusOf.get(stepId) !== "completed");
      if (failed.length > 0) {
        const reason = `前置工作 ${failed.join("、")} 未成功完成，本工作项未执行`;
        const result = await this.settleUnstarted(item, payload, reason);
        if (result) results.push(result);
        continue;
      }
      const claimed = await scheduler.claim(workerId, this.leaseMs, item.stepId);
      if (!claimed?.lease) continue;
      try {
        await this.launch(claimed, payload, claimed.lease.token);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failedItem = await scheduler
          .fail(claimed.stepId, claimed.lease.token, message, 0, { callbackPending: true })
          // eslint-disable-next-line no-restricted-syntax -- 队列写入失败时租约仍在，reclaimExpired 到期后由下一次维护重新结算这次启动失败
          .catch(() => undefined);
        const retryScheduled = failedItem?.status !== "failed";
        if (!retryScheduled) {
          const role: AgentProcessRole = payload.delegation?.role === "reviewer" ? "reviewer" : "executor";
          results.push(await this.settlement.projectFailure(input, claimed, role, message));
          await scheduler.clearCallbackPending(claimed.stepId);
        }
      }
    }
    await this.armQueueRetry(input);
    return results;
  }

  /**
   * Finish the callback of an item that ended without a process, when an
   * earlier attempt stopped after the outcome and before the callback: no
   * process record exists to settle it, so the queue row is the only trace.
   */
  private async redeliverUnstarted(scheduler: DurableScheduler, records: AgentProcessRecord[]) {
    const recorded = new Set(records.map((record) => record.callId));
    for (const item of await scheduler.list()) {
      if (item.callbackPending !== true || recorded.has(item.stepId)) continue;
      if (item.status === "cancelled")
        await this.publishUnstartedCancel(scheduler, item, item.error ?? "Cancelled before it started");
      else if (item.status === "failed") {
        const payload = (item.payload ?? {}) as WorkPayload;
        const role: AgentProcessRole = payload.delegation?.role === "reviewer" ? "reviewer" : "executor";
        await this.settlement.projectFailure(
          { taskId: item.taskId, runId: item.runId },
          item,
          role,
          item.error ?? "Subagent failed"
        );
        await scheduler.clearCallbackPending(item.stepId);
      }
    }
  }

  /**
   * Settle an item whose prerequisites ended without completing.
   *
   * It never starts, so no process, lease or callback would otherwise exist for
   * it; the queue row, the dependency event and Main's callback are the whole
   * outcome. Recording them here is what keeps a cancelled prerequisite from
   * leaving a work item Main would wait for forever.
   */
  private async settleUnstarted(
    item: WorkItem,
    payload: WorkPayload,
    reason: string
  ): Promise<SubagentProcessResult | undefined> {
    const scheduler = new DurableScheduler(this.queuePath({ taskId: item.taskId, runId: item.runId }));
    await scheduler.failUnstarted(item.stepId, reason, { callbackPending: true });
    const role: AgentProcessRole = payload.delegation?.role === "reviewer" ? "reviewer" : "executor";
    await new JsonlEventStore(join(this.workspaceRoot, item.taskId, "runs", item.runId, "run_events.jsonl"))
      .append({
        eventId: id("event"),
        type: "call.dependency_failed",
        taskId: item.taskId,
        runId: item.runId,
        agentId: item.agentId,
        callId: item.stepId,
        occurredAt: now(),
        payload: { callId: item.stepId, dependsOn: payload.dependsOn ?? [], error: reason }
      })
      // eslint-disable-next-line no-restricted-syntax -- 诊断事件写失败不能阻止给 Main 的失败回调，队列行已经带着原因
      .catch(() => undefined);
    const failure = await this.settlement.projectFailure(
      { taskId: item.taskId, runId: item.runId },
      item,
      role,
      reason
    );
    await scheduler.clearCallbackPending(item.stepId);
    return failure;
  }

  /** Renew the leases of running processes so a second backend cannot claim them. */
  async maintain(input: { taskId: string; runId: string }): Promise<void> {
    const scheduler = new DurableScheduler(this.queuePath(input));
    for (const record of await this.delegatedRecords(input)) {
      if (record.settledAt || !record.leaseToken) continue;
      try {
        await scheduler.renew(record.callId, record.leaseToken, this.leaseMs);
        // eslint-disable-next-line no-restricted-syntax -- 续租失败说明租约已被其他后端收回；该过程仍由身份核对观察，不能因此误杀或重复启动
      } catch {
        /* another backend owns the lease; identity polling still observes this process */
      }
    }
  }

  /**
   * Stop one delegated process group and record it as cancelled.
   *
   * The durable queue is the authority: a call that already reached a terminal
   * state keeps that outcome and is never rewritten by a late stop request. A
   * process whose pid no longer matches its launch record is already gone, so
   * it is settled from its records without any signal being sent.
   */
  async stop(input: {
    taskId: string;
    runId: string;
    callId: string;
  }): Promise<SubagentProcessResult | undefined> {
    const record = await this.findRecord(input);
    if (!record) return undefined;
    const settled = settledResult(record);
    if (settled) return settled;
    const item = await this.findQueueItem(input.taskId, input.runId, input.callId);
    if (item && isTerminalWorkStatus(item.status)) return this.settlement.findSettled(record);
    if (await this.host.owns(record)) await this.markQueueCancelled(input.taskId, input.runId, record.callId);
    await this.host.stop(record);
    // Stopping settled the record: its durable outcome is the answer, and
    // reading it here avoids taking the queue lock again on a path that just
    // contended for it.
    const afterStop = settledResult((await this.findRecord(record)) ?? record);
    return afterStop ?? (await this.settlement.findSettled(record));
  }

  /**
   * Cancel an item that never started: no process will report it, so the
   * queue row and Main's callback are the whole outcome, written as a settled
   * process writes them.
   */
  async cancelUnstarted(
    input: { taskId: string; runId: string; callId: string },
    reason: string
  ): Promise<void> {
    const scheduler = new DurableScheduler(this.queuePath(input));
    const item = await scheduler.cancel(input.callId, { callbackPending: true });
    // A launch that acquired the queue lock first has now registered its process.
    const launched = await this.findRecord(input);
    if (launched && !launched.settledAt) await this.host.stop(launched);
    if (item.status !== "cancelled" || item.callbackPending !== true) return;
    await this.publishUnstartedCancel(scheduler, item, reason);
  }

  /** The callback of an item cancelled before it started, then the pending mark cleared. */
  private async publishUnstartedCancel(scheduler: DurableScheduler, item: WorkItem, reason: string) {
    const role: AgentProcessRole =
      (item.payload as WorkPayload | undefined)?.delegation?.role === "reviewer" ? "reviewer" : "executor";
    const diagnostics = {
      tracePath: `sessions/${item.agentId}/pi/${item.stepId}`,
      resultPath: relative(
        join(this.workspaceRoot, item.taskId),
        join(
          agentProcessDirectory(this.workspaceRoot, item.taskId, item.runId, role, item.agentId),
          "result.json"
        )
      )
    };
    await enqueueMainCallback({
      workspaceRoot: this.workspaceRoot,
      taskId: item.taskId,
      runId: item.runId,
      callId: item.stepId,
      agentId: item.agentId,
      status: "cancelled",
      response: formatSubagentSummary({
        status: "cancelled",
        rawResponse: "",
        outputFiles: [],
        diagnostics,
        error: reason
      }),
      outputFiles: [],
      diagnostics,
      error: reason
    });
    await scheduler.clearCallbackPending(item.stepId);
  }

  /** Whether any process this Run launched is still running. */
  async running(input: { taskId: string; runId: string }): Promise<boolean> {
    const records = await this.delegatedRecords(input);
    return records.some((record) => !record.settledAt);
  }

  close(): void {
    for (const { timer } of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.host.close();
  }

  /**
   * Start the retry the queue scheduled, at the time the queue allows it.
   *
   * The maintenance pass also reaches every runnable item; this timer is what
   * starts a retry at its own due time even when nothing else calls in, so the
   * retry is not left to a polling cadence.
   */
  private async armQueueRetry(input: { taskId: string; runId: string }): Promise<void> {
    const key = `${input.taskId}\0${input.runId}`;
    const items = await new DurableScheduler(this.queuePath(input)).list();
    let due: number | undefined;
    for (const item of items) {
      if (item.status !== "queued" || typeof item.notBefore !== "string") continue;
      const at = Date.parse(item.notBefore);
      if (Number.isFinite(at) && (due === undefined || at < due)) due = at;
    }
    const armed = this.retryTimers.get(key);
    if (due === undefined) {
      if (armed) clearTimeout(armed.timer);
      this.retryTimers.delete(key);
      return;
    }
    // The same (or a later) due time is already armed: keep that timer rather
    // than restarting it on every maintenance pass.
    if (armed && armed.due <= due) return;
    if (armed) clearTimeout(armed.timer);
    const timer = setTimeout(
      () => {
        this.retryTimers.delete(key);
        void this.startQueued(input).catch((error) =>
          console.error(
            `[cowork] starting a due subagent retry failed: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      },
      Math.max(0, due - Date.now())
    );
    timer.unref();
    this.retryTimers.set(key, { due, timer });
  }

  private async launch(item: WorkItem, payload: WorkPayload, leaseToken: string): Promise<void> {
    const role = payload.delegation?.role === "reviewer" ? "reviewer" : "executor";
    const site = await this.workingSite(item, payload, role);
    const taskWorkspace = join(this.workspaceRoot, item.taskId);
    // A continuation appends one turn to the Executor's own Pi session: the
    // session directory and id are the original call's, not this call's. The
    // chain root is recorded on the item, so a rework of a rework opens the
    // transcript that already contains every earlier round.
    const sessionCallId = payload.continuation
      ? (payload.continuation.sessionCallId ?? payload.continuation.fromCallId)
      : item.stepId;
    const sessionDirectory = join(taskWorkspace, "sessions", item.agentId, "pi", sessionCallId);
    const directory = agentProcessDirectory(this.workspaceRoot, item.taskId, item.runId, role, item.agentId);
    await mkdir(sessionDirectory, { recursive: true });
    // A continuation opens the earlier transcript by its file: the session id
    // lookup compares the header's working directory with this process's, and
    // the two spellings of the same symlinked work site need not agree.
    const sessionFile = payload.continuation ? await resumeSessionFile(sessionDirectory) : undefined;
    if (site.reviewSite) {
      // The marker goes first: a worktree that exists without one could never be
      // found and cleaned after a backend restart. A failed creation removes it.
      await atomicWrite(reviewSiteMarker(directory), `${JSON.stringify(site.reviewSite)}\n`);
      try {
        await prepareReviewSite(site.reviewSite);
      } catch (error) {
        await rm(reviewSiteMarker(directory), { force: true });
        throw error;
      }
    }
    let launched = false;
    try {
      const hint = payload.continuation ? undefined : await pitfallsHint(site.directory);
      const prompt = delegatedPrompt(payload.task ?? "Continue the delegated task.", hint);
      const env = await this.childEnv(item, role);
      const process = await this.host.launch({
        taskId: item.taskId,
        runId: item.runId,
        callId: item.stepId,
        agentId: item.agentId,
        role,
        ...(payload.agentDefinition ? { agent: payload.agentDefinition.name } : {}),
        workingDirectory: site.directory,
        // A resumed session takes the rework brief as its prompt argument: the
        // transcript it opened already owns stdin's role for the first turn.
        prompt: sessionFile ? "" : prompt,
        sessionDirectory,
        ...(sessionFile
          ? {
              sessionArgs: ["--session", sessionFile],
              args: ["--", prompt]
            }
          : {}),
        resultPath: join(directory, "result.json"),
        env,
        leaseToken
      });
      launched = process !== undefined;
    } finally {
      // Once launched, the process owns the site until settlement.
      if (!launched && site.reviewSite) await this.discardReviewSite(site.reviewSite, directory);
    }
  }

  /**
   * The site this work item runs in.
   *
   * A Reviewer never shares the Executor's checkout: an explicit review site
   * names the frozen candidate, and a requirement-bound work item is detached
   * at the development checkout's candidate commit instead of forking a branch
   * of its own. The checkout is removed when the review process ends.
   */
  private async workingSite(
    item: WorkItem,
    payload: WorkPayload,
    role: AgentProcessRole
  ): Promise<{ directory: string; reviewSite?: ReviewSite }> {
    if (role !== "reviewer" && payload.reviewSite !== undefined)
      throw new Error(
        "Executor work item must not carry a reviewSite; a candidate checkout belongs to a Reviewer"
      );
    const explicit = role === "reviewer" ? reviewSiteInput(payload.reviewSite) : undefined;
    if (explicit) return { directory: resolve(explicit.directory), reviewSite: explicit };
    if (role === "reviewer" && payload.workItemSite) {
      const directory = resolve(payload.workItemSite.directory);
      const reviewSite: ReviewSite = {
        repository: resolve(payload.workItemSite.developmentDirectory),
        commit: await git(payload.workItemSite.developmentDirectory, ["rev-parse", "HEAD"]),
        directory
      };
      return { directory, reviewSite };
    }
    if (role === "reviewer") {
      // A Reviewer without a requirement site still needs its own candidate
      // copy: its shell must never run in the user's project directory.
      const projectDirectory = payload.projectDirectory ? resolve(payload.projectDirectory) : undefined;
      if (!projectDirectory)
        throw new Error(
          "Reviewer work item has no candidate checkout: dispatch it with a projectDirectory, workItemSite or reviewSite"
        );
      const commit = await reviewerCandidate(projectDirectory);
      const directory = join(
        agentProcessDirectory(this.workspaceRoot, item.taskId, item.runId, role, item.agentId),
        "review-site"
      );
      return { directory, reviewSite: { repository: projectDirectory, commit, directory } };
    }
    return { directory: await this.workingDirectory(payload) };
  }

  /**
   * The item's own checkout when the requirement assigned one, otherwise the
   * project directory it was dispatched with. Site preparation stays the
   * existing implementation; this service only names the directory to run in.
   */
  private async workingDirectory(payload: WorkPayload): Promise<string> {
    if (payload.workItemSite) {
      await prepareWorkItemSite(payload.workItemSite);
      return resolve(payload.workItemSite.directory);
    }
    if (!payload.projectDirectory) throw new Error("Subagent work item has no working site");
    return resolve(payload.projectDirectory);
  }

  private async childEnv(item: WorkItem, role: AgentProcessRole): Promise<NodeJS.ProcessEnv> {
    const payload = (item.payload ?? {}) as WorkPayload;
    return {
      ...this.options.env,
      ...(this.options.envFor ? await this.options.envFor(item) : {}),
      COWORK_AGENT_ROLE: role,
      // A delegated process has no Dashboard tools; the host credential belongs
      // to the requesting Run and must not let a Subagent act as Main.
      COWORK_API_TOKEN: undefined,
      COWORK_DASHBOARD_URL: undefined,
      ...(payload.capabilityGrants && payload.capabilityGrants.length > 0
        ? { COWORK_AGENT_GRANTS: JSON.stringify(payload.capabilityGrants) }
        : {}),
      // The process applies the definition itself: its tools, skills, MCP servers and prompt.
      COWORK_AGENT_DEFINITION: payload.agentDefinition ? JSON.stringify(payload.agentDefinition) : undefined,
      COWORK_BUILTIN_AGENT: payload.builtinAgent ? JSON.stringify(payload.builtinAgent) : undefined,
      COWORK_REVIEW_SCOPE:
        role === "reviewer" && payload.reviewScope ? JSON.stringify(payload.reviewScope) : undefined,
      COWORK_TICKET_CRITERIA:
        role === "executor" && payload.ticketCriteria?.length
          ? JSON.stringify(payload.ticketCriteria)
          : undefined
    };
  }

  private async settle(record: AgentProcessRecord): Promise<void> {
    const result = await this.settlement.projectOutcome(record);
    // A Reviewer's checkout is the evidence its review was recorded against:
    // Main binds the review and checks the candidate's drift after the call is
    // over, so a successful review keeps the site. One that never produced a
    // conclusion leaves nothing to examine, and a retry recreates it.
    if (result.status !== "succeeded") await this.cleanupReviewSite(record);
  }

  /** Remove the Reviewer checkout and its marker after the process settled. */
  private async cleanupReviewSite(record: AgentProcessRecord): Promise<void> {
    const directory = agentProcessDirectory(
      this.workspaceRoot,
      record.taskId,
      record.runId,
      record.role,
      record.agentId
    );
    const site = await readReviewSiteMarker(reviewSiteMarker(directory));
    if (!site) return;
    await this.discardReviewSite(site, directory);
  }

  private async discardReviewSite(site: ReviewSite, processDirectory: string): Promise<void> {
    try {
      await releaseReviewSite(site);
      await rm(reviewSiteMarker(processDirectory), { force: true });
    } catch (error) {
      console.error(
        `[cowork] review site cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async markQueueCancelled(taskId: string, runId: string, callId: string): Promise<void> {
    const scheduler = new DurableScheduler(join(this.workspaceRoot, taskId, "runs", runId, "queue.json"));
    const item = (await scheduler.list()).find((candidate) => candidate.stepId === callId);
    if (!item || isTerminalWorkStatus(item.status)) return;
    // eslint-disable-next-line no-restricted-syntax -- 取消已由进程组与回调表达；队列写入失败时下一次取消或租约回收会补上终态
    await scheduler.cancel(callId).catch(() => undefined);
  }

  private async findQueueItem(taskId: string, runId: string, callId: string): Promise<WorkItem | undefined> {
    const scheduler = new DurableScheduler(join(this.workspaceRoot, taskId, "runs", runId, "queue.json"));
    return (await scheduler.list()).find((candidate) => candidate.stepId === callId);
  }

  private async findRecord(record: {
    taskId: string;
    runId: string;
    callId: string;
  }): Promise<AgentProcessRecord | undefined> {
    const records = await this.delegatedRecords(record);
    return records.find((candidate) => candidate.callId === record.callId);
  }

  private queuePath(input: { taskId: string; runId: string }): string {
    return join(this.workspaceRoot, input.taskId, "runs", input.runId, "queue.json");
  }
}

/** The commit a Reviewer without a recorded candidate can copy; refuse when there is none. */
async function reviewerCandidate(directory: string): Promise<string> {
  try {
    await git(directory, ["rev-parse", "--git-dir"]);
  } catch {
    throw new Error(
      `Reviewer work item has no candidate checkout: ${directory} is not a Git repository; dispatch it under a developmentId or pass a reviewSite with the candidate commit`
    );
  }
  try {
    return await git(directory, ["rev-parse", "--verify", "HEAD^{commit}"]);
  } catch {
    throw new Error(
      `Reviewer work item has no candidate checkout: ${directory} has no commit; commit the candidate or pass a reviewSite with the candidate commit`
    );
  }
}

function reviewSiteMarker(processDirectory: string): string {
  return join(processDirectory, "review-site.json");
}

/** Validate an explicit review site; a malformed one is a locatable launch error. */
function reviewSiteInput(value: unknown): ReviewSite | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Subagent review site is not an object");
  const input = value as Record<string, unknown>;
  const repository = typeof input.repository === "string" ? input.repository.trim() : "";
  const commit = typeof input.commit === "string" ? input.commit.trim() : "";
  const directory = typeof input.directory === "string" ? input.directory.trim() : "";
  if (!repository || !commit || !directory)
    throw new Error("Subagent review site requires repository, commit and directory");
  return { repository, commit, directory };
}

async function readReviewSiteMarker(path: string): Promise<ReviewSite | undefined> {
  try {
    return reviewSiteInput(JSON.parse(await readFile(path, "utf8")));
    // eslint-disable-next-line no-restricted-syntax -- 标记不存在或已损坏时没有可清理的审查现场；进程终态仍按结果记录结算
  } catch {
    return undefined;
  }
}

function delegatedPrompt(task: string, pitfalls?: string): string {
  return [
    `Main 分配的任务：${task}`,
    ...(pitfalls ? [pitfalls] : []),
    "完成后请返回完整结论；如果创建了 deliverables/ 文件，请列出路径。证据直接写在总结中；不要返回‘正在处理’之类的过程叙述，也不要声称没有执行过的操作。"
  ].join("\n");
}

/** The transcript a continuation appends to; absent when the earlier attempt left none. */
async function resumeSessionFile(directory: string): Promise<string> {
  const files = (
    await readdir(directory)
      // eslint-disable-next-line no-restricted-syntax -- 会话目录不存在就是没有可续接的记录，下面的报错是给调用方的结论
      .catch(() => [] as string[])
  )
    .filter((file) => file.endsWith(".jsonl"))
    .sort()
    .reverse();
  if (!files[0])
    throw new Error(`没有可续接的会话记录：${directory} 中没有 Pi 会话文件；不能新建 Agent 冒充原上下文`);
  return join(directory, files[0]);
}
