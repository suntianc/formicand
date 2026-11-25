import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { id, now } from "../domain/types.js";
import { JsonlEventStore } from "../storage/event-store.js";
import {
  agentProcessDirectory,
  type AgentProcessHost,
  type AgentProcessRecord,
  type AgentProcessRole,
  type AgentProcessStatus
} from "./agent-process.js";
import { DurableScheduler, type WorkItem } from "./scheduler.js";
import { isTerminalWorkStatus, type SubagentWorkPayload as WorkPayload } from "./subagent-work.js";
import { enqueueMainCallback, formatSubagentSummary } from "./subagent-callback.js";
import { parseReviewConclusion, type ReviewConclusion } from "./subagent-review.js";
import { executorReportText, parseExecutorReport } from "./executor-report.js";

export interface SubagentProcessResult {
  taskId: string;
  runId: string;
  callId: string;
  agentId: string;
  status: AgentProcessStatus;
  response: string;
  outputFiles: string[];
  diagnostics: { tracePath: string; resultPath: string };
  /** A Reviewer's structured conclusion; absent for an Executor result. */
  review?: ReviewConclusion;
  error?: string;
}
/** The result record the subagent extension writes before its process exits. */
interface AgentResultRecord {
  version?: unknown;
  taskId?: unknown;
  runId?: unknown;
  callId?: unknown;
  agentId?: unknown;
  token?: unknown;
  termination?: unknown;
  stopReason?: unknown;
  response?: unknown;
  outputFiles?: unknown;
  diagnostics?: unknown;
  review?: unknown;
  report?: unknown;
  error?: unknown;
}

/**
 * How long a retryable delegated failure waits before its next attempt.
 *
 * The queue records this as the item's next allowed time, so the retry starts
 * from a timer at that moment (not from polling) and the same failure is not
 * repeated back to back.
 */
const RETRY_DELAY_MS = 1_000;

/** Projects process exit facts into the shared queue, Run events and Main's Inbox. */
export class SubagentSettlement {
  constructor(
    private readonly workspaceRoot: string,
    private readonly host: Pick<AgentProcessHost, "markSettled">,
    private readonly armQueueRetry: (run: { taskId: string; runId: string }) => Promise<void>,
    private readonly onSettled: (result: SubagentProcessResult) => void | Promise<void>
  ) {}

  async projectOutcome(record: AgentProcessRecord): Promise<SubagentProcessResult> {
    const result = await this.findSettled(record);
    const runRoot = join(this.workspaceRoot, record.taskId, "runs", record.runId);
    const scheduler = new DurableScheduler(join(runRoot, "queue.json"));
    const current = (await scheduler.list()).find((item) => item.stepId === record.callId);
    // A retryable failure is still in flight, so it is not an outcome Main may
    // act on; the callback follows the terminal attempt.
    const publishOutcome = async (): Promise<{ messageId: string; queued: boolean }> => {
      return await enqueueMainCallback({
        workspaceRoot: this.workspaceRoot,
        taskId: record.taskId,
        runId: record.runId,
        callId: record.callId,
        agentId: record.agentId,
        status: result.status,
        ...(result.review ? { callbackMetadata: { review: result.review } } : {}),
        response: formatSubagentSummary({
          status: result.status,
          rawResponse: result.response,
          outputFiles: result.outputFiles,
          diagnostics: result.diagnostics,
          ...(result.error ? { error: result.error } : {})
        }),
        outputFiles: result.outputFiles,
        diagnostics: result.diagnostics,
        ...(result.error ? { error: result.error } : {})
      });
    };
    // A terminal row and its callback are one consistent pair for readers: the
    // outcome becomes durable first, marked `callbackPending`, then the callback
    // is queued, then the mark is cleared. `callbackPending` is what keeps Main
    // from treating the call as settled until its callback exists, so the row
    // can be written before the callback without the old race. A settlement
    // interrupted between the steps is completed by the next attempt below.
    if (current && isTerminalWorkStatus(current.status) && current.callbackPending === true) {
      const callback = await publishOutcome();
      await scheduler.clearCallbackPending(record.callId);
      await this.host.markSettled(record, {
        status: result.status,
        response: result.response,
        outputFiles: result.outputFiles,
        diagnostics: result.diagnostics,
        ...(result.error ? { error: result.error } : {})
      });
      await this.onSettled(result);
      return result;
    }
    let retryScheduled = false;
    let callback: { messageId: string; queued: boolean } | undefined;
    if (result.status === "cancelled") {
      await scheduler.cancel(record.callId, { callbackPending: true });
      callback = await publishOutcome();
      await scheduler.clearCallbackPending(record.callId);
    } else if (result.status === "succeeded") {
      await this.completeQueue(scheduler, record.callId, record.leaseToken, { callbackPending: true });
      callback = await publishOutcome();
      await scheduler.clearCallbackPending(record.callId);
    } else {
      const outcome = await this.failQueue(
        scheduler,
        record,
        result.error ?? "Subagent process failed",
        async () => {
          callback = await publishOutcome();
        }
      );
      // Another owner holds the call: its settlement is the outcome, so this
      // attempt records no failure event and no failure callback for it.
      if (outcome === "foreign") {
        await this.host.markSettled(record, {
          status: result.status,
          response: result.response,
          outputFiles: result.outputFiles,
          diagnostics: result.diagnostics,
          ...(result.error ? { error: result.error } : {})
        });
        return result;
      }
      retryScheduled = outcome === "retry";
      // The failed attempt has no process left to observe; the due timer is
      // what starts its retry when the queue allows it.
      if (retryScheduled)
        await this.armQueueRetry({ taskId: record.taskId, runId: record.runId }).catch((error) =>
          console.error(
            `[formicand] scheduling a subagent retry failed: ${error instanceof Error ? error.message : String(error)}`
          )
        );
    }

    const events = new JsonlEventStore(join(runRoot, "run_events.jsonl"));
    // A retry the queue scheduled is not an outcome Main may act on yet, but
    // the Run still records that this attempt is being replaced.
    if (retryScheduled)
      await events.append({
        eventId: id("event"),
        type: "run.retry_scheduled",
        taskId: record.taskId,
        runId: record.runId,
        agentId: record.agentId,
        callId: record.callId,
        occurredAt: now(),
        payload: { callId: record.callId, error: result.error }
      });
    const eventType =
      result.status === "succeeded"
        ? "run.completed"
        : result.status === "cancelled"
          ? "run.cancelled"
          : "run.failed";
    await events.append({
      eventId: id("event"),
      type: eventType,
      taskId: record.taskId,
      runId: record.runId,
      agentId: record.agentId,
      callId: record.callId,
      occurredAt: now(),
      payload: {
        callId: record.callId,
        ...(result.status === "succeeded" ? {} : { error: result.error, state: result.status }),
        ...(retryScheduled ? { retryScheduled: true } : {}),
        outputFiles: result.outputFiles,
        diagnostics: result.diagnostics,
        ...(callback?.queued ? { callbackMessageId: callback.messageId } : {})
      }
    });
    await this.host.markSettled(record, {
      status: result.status,
      response: result.response,
      outputFiles: result.outputFiles,
      diagnostics: result.diagnostics,
      ...(result.review ? { review: result.review } : {}),
      ...(result.error ? { error: result.error } : {})
    });
    await this.onSettled(result);
    return result;
  }

  async findSettled(record: AgentProcessRecord): Promise<SubagentProcessResult> {
    const taskWorkspace = join(this.workspaceRoot, record.taskId);
    const result = await readResult(record.resultPath);
    const diagnostics = {
      tracePath: relative(taskWorkspace, record.sessionDirectory),
      resultPath: relative(taskWorkspace, record.resultPath)
    };
    const base = {
      taskId: record.taskId,
      runId: record.runId,
      callId: record.callId,
      agentId: record.agentId,
      outputFiles: [] as string[],
      diagnostics
    };
    // Cancellation is a durable queue fact, so the backend that observes the
    // exit and the backend that requested the stop agree even across restarts.
    const item = (
      await new DurableScheduler(
        join(this.workspaceRoot, record.taskId, "runs", record.runId, "queue.json")
      ).list()
    ).find((candidate) => candidate.stepId === record.callId);
    if (item?.status === "cancelled")
      return { ...base, status: "cancelled", response: "", error: "Subagent was cancelled by the backend" };
    if (!result || result.token !== record.token || typeof result.termination !== "string")
      return {
        ...base,
        status: "failed",
        response: "",
        error: "Subagent exited without writing a result record"
      };
    const outputFiles = Array.isArray(result.outputFiles)
      ? result.outputFiles.filter((path): path is string => typeof path === "string")
      : [];
    const response = typeof result.response === "string" ? result.response.trim() : "";
    // A Reviewer's conclusion is the result Main acts on; a record with a
    // completed turn but no usable conclusion is a failed call, not a review
    // Main has to interpret from prose.
    let review: ReviewConclusion | undefined;
    if (record.role === "reviewer" && !record.agent && result.termination === "completed") {
      const parsed = parseReviewConclusion(result.review);
      if (!parsed.ok)
        return {
          ...base,
          status: "failed",
          response,
          outputFiles,
          error: `Reviewer result has no valid review conclusion: ${parsed.errors.join("; ")}`
        };
      review = parsed.review;
    }
    // A ticket Executor's report answers each criterion; without it Main would
    // have to read the criteria out of prose, so it is a failed call.
    let reported = response;
    const payload = (item?.payload ?? {}) as WorkPayload;
    if (record.role === "executor" && payload.ticketCriteria?.length && result.termination === "completed") {
      const parsed = parseExecutorReport(result.report, payload.ticketCriteria);
      if (!parsed.ok)
        return {
          ...base,
          status: "failed",
          response,
          outputFiles,
          error: `Executor result has no valid ticket report: ${parsed.errors.join("; ")}`
        };
      reported = `${response}\n\n${executorReportText(parsed.report)}`;
    }
    if (result.termination !== "completed")
      return {
        ...base,
        status: "failed",
        response,
        outputFiles,
        error:
          typeof result.error === "string" && result.error
            ? result.error
            : `Subagent ended with termination ${result.termination}`
      };
    if (!response)
      return {
        ...base,
        status: "failed",
        response: "",
        outputFiles,
        error: "Subagent completed without returning a textual summary"
      };
    return { ...base, status: "succeeded", response: reported, outputFiles, ...(review ? { review } : {}) };
  }

  async projectFailure(
    input: { taskId: string; runId: string },
    item: WorkItem,
    role: AgentProcessRole,
    message: string
  ): Promise<SubagentProcessResult> {
    const taskWorkspace = join(this.workspaceRoot, item.taskId);
    const diagnostics = {
      tracePath: `sessions/${item.agentId}/pi/${item.stepId}`,
      resultPath: relative(
        taskWorkspace,
        join(
          agentProcessDirectory(this.workspaceRoot, item.taskId, item.runId, role, item.agentId),
          "result.json"
        )
      )
    };
    const result: SubagentProcessResult = {
      ...input,
      callId: item.stepId,
      agentId: item.agentId,
      status: "failed",
      response: "",
      outputFiles: [],
      diagnostics,
      error: message
    };
    await new JsonlEventStore(join(this.workspaceRoot, item.taskId, "runs", item.runId, "run_events.jsonl"))
      .append({
        eventId: id("event"),
        type: "run.failed",
        taskId: item.taskId,
        runId: item.runId,
        agentId: item.agentId,
        callId: item.stepId,
        occurredAt: now(),
        payload: {
          callId: item.stepId,
          error: message,
          state: "failed",
          retryScheduled: false,
          outputFiles: [],
          diagnostics
        }
      })
      // eslint-disable-next-line no-restricted-syntax -- 启动失败的诊断事件写失败不能阻止给 Main 的失败回调，原始错误已经随回调与队列返回
      .catch(() => undefined);
    await enqueueMainCallback({
      workspaceRoot: this.workspaceRoot,
      taskId: item.taskId,
      runId: item.runId,
      callId: item.stepId,
      agentId: item.agentId,
      status: "failed",
      response: formatSubagentSummary({
        status: "failed",
        rawResponse: "",
        outputFiles: [],
        diagnostics,
        error: message
      }),
      outputFiles: [],
      diagnostics,
      error: message
    });
    return result;
  }

  private async completeQueue(
    scheduler: DurableScheduler,
    callId: string,
    token: string | undefined,
    options: { callbackPending?: boolean } = {}
  ): Promise<void> {
    if (!token) return;
    const item = (await scheduler.list()).find((candidate) => candidate.stepId === callId);
    if (!item || isTerminalWorkStatus(item.status)) return;
    // The write failure propagates: the callback must not be published for a
    // row that is still in flight. The lease expiry re-runs the settlement.
    await scheduler.complete(callId, token, options);
  }

  /**
   * Record a failed attempt and publish its outcome when it is terminal.
   *
   * A retryable attempt is requeued and reports no outcome. A terminal attempt
   * becomes durable first with `callbackPending`, then the callback is queued
   * and the mark cleared, so a reader that sees the callback also sees the
   * settled row and Main waits for both.
   */
  private async failQueue(
    scheduler: DurableScheduler,
    record: AgentProcessRecord,
    error: string,
    beforeTerminal?: () => Promise<void>
  ): Promise<"retry" | "foreign" | "terminal"> {
    const item = (await scheduler.list()).find((candidate) => candidate.stepId === record.callId);
    // A terminal item was settled by someone else: this attempt is not the
    // outcome, and a second callback would report work twice.
    if (item && isTerminalWorkStatus(item.status)) return "foreign";
    const ownsLease =
      Boolean(record.leaseToken) && item?.status === "leased" && item.lease?.token === record.leaseToken;
    // A lease this attempt does not hold belongs to another owner.
    if (item?.status === "leased" && !ownsLease) return "foreign";
    if (!item) {
      // A record adopted without a queue row (a call whose row was never
      // written or is already gone): there is no row to disagree with, so the
      // outcome is published and the record settles.
      await beforeTerminal?.();
      return "terminal";
    }
    if (ownsLease && item.attempts < (item.maxAttempts ?? 1)) {
      // Requeue the retry now with the time it may start, instead of leaving
      // the item leased until the lease expires. A failed queue write leaves
      // that lease in place and reclaimExpired still schedules the attempt.
      // eslint-disable-next-line no-restricted-syntax -- 队列写入失败时租约仍在，reclaimExpired 到期后会再次安排这次重试
      await scheduler.fail(record.callId, record.leaseToken!, error, RETRY_DELAY_MS).catch(() => undefined);
      return "retry";
    }
    const updated = ownsLease
      ? await scheduler.fail(record.callId, record.leaseToken!, error, 0, { callbackPending: true })
      : await scheduler.failUnstarted(record.callId, error, { callbackPending: true });
    // A concurrent claim may still have requeued it; then there is no outcome.
    if (updated.status === "queued") return "retry";
    await beforeTerminal?.();
    await scheduler.clearCallbackPending(record.callId);
    return "terminal";
  }
}
/** The recorded outcome of a process this backend already settled. */
export function settledResult(record: AgentProcessRecord): SubagentProcessResult | undefined {
  if (!record.settledAt || !record.outcome) return undefined;
  return {
    taskId: record.taskId,
    runId: record.runId,
    callId: record.callId,
    agentId: record.agentId,
    ...record.outcome
  };
}
async function readResult(path: string): Promise<AgentResultRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as AgentResultRecord;
    return value;
    // eslint-disable-next-line no-restricted-syntax -- 结果记录缺失或损坏就是“没有结果记录”，调用方据此把退出记为失败
  } catch {
    return undefined;
  }
}
