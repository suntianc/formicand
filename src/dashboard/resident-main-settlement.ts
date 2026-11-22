import type { ChildProcess } from "node:child_process";
import { listJobs } from "../tools/jobs.js";
import { join } from "node:path";
import { HumanRequestStore } from "../runtime/human.js";
import { resetMainSupervisorBackoff } from "../runtime/main-supervisor.js";
import { readSleep } from "../runtime/main-sleep.js";
import { type AgentProcessRecord } from "../runtime/agent-process.js";
import { InboxStore } from "../runtime/scheduler.js";
import { SubagentQuestionStore } from "../runtime/subagent-questions.js";
import { assessTaskCompletion, isFinalAssistantMessage } from "../runtime/task-completion.js";
import { mainRunFailure } from "./main-run-outcome.js";
import { type TaskRecord, type TaskStatus } from "../domain/types.js";
import type { TaskLocation } from "./workspace-directory.js";
import {
  type RunServicePorts,
  type FinalizedRunStatus,
  type InterjectionTarget,
  type ResumeHumanAnswers
} from "./run-service-contracts.js";
import { mainTurnState, type ResidentMain } from "./resident-main.js";

export function createResidentMainSettlement({
  onRunFinalized,
  activeRunIds,
  residentMains,
  locateTask,
  cancellations,
  appendRunEvent,
  isStopping,
  coordinator,
  finalizations,
  taskFinalizations,
  activeRuns,
  pendingTurns,
  interjectionTargets,
  onRunExit,
  mainCapacity,
  humanWakeups,
  resumeHumanAnswers,
  subagents,
  onRunSettled
}: {
  onRunFinalized: NonNullable<RunServicePorts["onRunFinalized"]>;
  activeRunIds: Map<string, string>;
  residentMains: Map<string, ResidentMain>;
  locateTask: RunServicePorts["locateTask"];
  cancellations: Set<string>;
  appendRunEvent: RunServicePorts["appendRunEvent"];
  isStopping: () => boolean;
  coordinator: RunServicePorts["coordinator"];
  finalizations: Set<Promise<void>>;
  taskFinalizations: Map<string, Promise<void>>;
  activeRuns: Map<string, ChildProcess>;
  pendingTurns: Map<string, number>;
  interjectionTargets: Map<string, InterjectionTarget>;
  onRunExit: NonNullable<RunServicePorts["onRunExit"]>;
  mainCapacity: RunServicePorts["mainCapacity"];
  humanWakeups: Set<string>;
  resumeHumanAnswers: ResumeHumanAnswers;
  subagents: RunServicePorts["subagents"];
  onRunSettled: NonNullable<RunServicePorts["onRunSettled"]>;
}) {
  async function finalizeSessionRun(
    location: TaskLocation,
    runId: string,
    status: FinalizedRunStatus
  ): Promise<void> {
    // The local Run has settled. A shared write failure must not interrupt
    // process cleanup or undo the local transition.
    try {
      await onRunFinalized(location, runId, status);
    } catch (error) {
      console.error(
        `[cowork] session run settlement failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async function prepareRunTransition(location: TaskLocation, runId: string, next: TaskStatus) {
    const { taskId } = location.task;
    let current = await location.store.readTask(taskId);
    // The durable Run identity is the ownership fact. An in-memory handle is
    // not required: a record discovered after a restart owns the same Run its
    // Task names, and that exit must still settle the Task.
    if ((activeRunIds.has(taskId) && activeRunIds.get(taskId) !== runId) || current.activeRunId !== runId)
      return;
    if (current.status === "cancelled") return;
    if (current.status === "completed" && next !== "completed") {
      // finish_task can succeed before the final provider response. Only this
      // still-owned execution may reopen its provisional completion; another
      // run's completed Task must remain untouched.
      if (current.completion?.signal !== "finish_task") return;
      current = await location.store.transitionTask(taskId, "running", {
        runId,
        reason: "dashboard_finish_task_pending_response",
        completion: { signal: "none" }
      });
    }
    return current;
  }

  /**
   * Drop interrupt commands a dead process never consumed.
   *
   * An interrupt is about the turn that was in flight. Once that process is
   * gone, the message would otherwise abort the first turn of the Main that
   * replaces it, which nobody asked for.
   */
  async function discardPendingInterrupts(
    location: TaskLocation,
    taskId: string,
    runId: string
  ): Promise<void> {
    const inbox = new InboxStore(
      join(location.workspaceRoot, taskId, "runs", runId, "agents", "main", "inbox-store.json")
    );
    // eslint-disable-next-line no-restricted-syntax -- 清理只是尽力而为；Inbox 读不到时下一条消息仍会按正常路径处理
    const messages = await inbox.list("main").catch(() => []);
    for (const message of messages) {
      if (message.state === "consumed") continue;
      if ((message.payload as { type?: unknown } | undefined)?.type !== "main.interrupt") continue;
      try {
        if (message.state === "ready")
          await inbox.leaseMessage("main", message.messageId, 60_000, "run-exit-cleanup");
        await inbox.consume(message.messageId);
      } catch (error) {
        // Another reader may have consumed it between the list and the lease.
        console.error(
          `[cowork] discarding a stale interrupt failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  /**
   * What one resident Main's exit means for its Task and Run.
   *
   * The process — not the turn — ends the Run. A replaced process leaves the
   * Task to whoever replaces it; a crashed one fails the turn it was in; one
   * that exits after a settled turn is the state-preserving stop (idle
   * timeout or a closed session), so the Task keeps the state its last turn
   * recorded and the next message starts a Main again.
   */
  function handleResidentExit(taskId: string, runId: string, record: AgentProcessRecord): Promise<void> {
    const resident = residentMains.get(taskId);
    if (resident && resident.runId !== runId) return Promise.resolve();
    const finalization = (async () => {
      const location = resident?.location ?? (await locateTask(taskId));
      const taskWorkspace = location.workspaceRoot;
      const replacing = resident?.replacing === true;
      const observed = resident?.observed === true;
      if (observed) {
        resident.output.finish();
        await resident.runtimeOutput?.finish();
      }
      await discardPendingInterrupts(location, taskId, runId);
      const settledTask = await location.store.readTask(taskId);
      if (replacing) return;
      if (cancellations.has(taskId) || settledTask.status === "cancelled") return;
      if (settledTask.activeRunId !== runId) return;
      // A process this backend spawned reports its own terminal message and
      // turn boundary. An adopted one has neither, so its exit is classified
      // by the durable turn state it wrote: a turn still marked running is a
      // mid-turn death, not an idle stop.
      const last = observed ? resident.output.message : undefined;
      const code = record.exitCode ?? null;
      const signal = (record.exitSignal as NodeJS.Signals | null) ?? null;
      const modelFailed = last?.role === "assistant" && last.stopReason === "error";
      const turn = await mainTurnState(location, taskId, runId);
      // The durable turn record is the source when it exists; a process that
      // died before writing one falls back to what its own event stream showed.
      const turnWasActive = turn ? turn.active : observed ? resident.turnActive : false;
      const turnId = turn?.turnId;
      const interrupted = last?.role === "assistant" && ["aborted", "length"].includes(last.stopReason ?? "");
      const event = (type: string, payload: unknown) =>
        appendRunEvent(taskWorkspace, taskId, runId, type, payload);
      if (isStopping()) {
        // The backend is going away and the process ended with it. Nothing is
        // failed; the Task is parked for the next Main.
        if (await prepareRunTransition(location, runId, "waiting"))
          await location.store.transitionTask(taskId, "waiting", { runId, reason: "desktop_shutdown" });
        return;
      }
      const settlePause = async (request: NonNullable<TaskRecord["pause"]>) => {
        if (!(await prepareRunTransition(location, runId, "paused"))) return;
        await location.store.transitionTask(taskId, "paused", { runId, reason: "ui_pause" });
        await event("main.run_paused", {
          code,
          signal,
          reason: "ui_pause",
          requestedAt: request.requestedAt
        });
        const paused = await location.store.readTask(taskId);
        if (paused.pause && !paused.pause.pausedAt)
          await location.store.updateTask(taskId, {
            pause: { ...paused.pause, pausedAt: new Date().toISOString() }
          });
      };
      // Aborting at a step boundary surfaces through Pi as an aborted
      // operation. The durable pause request identifies it, while a model
      // error that happened to overlap a pause still shows its own failure.
      const errorMessage = last?.errorMessage ?? "";
      if (settledTask.pause && modelFailed && /abort/i.test(errorMessage)) {
        await settlePause(settledTask.pause);
        return;
      }
      if (!modelFailed && !turnWasActive) {
        // Between turns: the process ends an idle Run. Its last turn already
        // recorded waiting, completed or paused, and that state is kept, so
        // the next message or callback starts a Main from it.
        await event("main.run_stopped", {
          code,
          signal,
          reason: settledTask.status === "paused" ? "paused" : "idle",
          status: settledTask.status,
          ...(turnId ? { turnId } : {})
        });
        const finalized = await location.store.readTask(taskId);
        if (
          finalized.activeRunId === runId &&
          (finalized.status === "completed" || finalized.status === "failed")
        )
          await finalizeSessionRun({ ...location, task: finalized }, runId, finalized.status);
        return;
      }
      if (modelFailed || (code !== 0 && !interrupted)) {
        // A model request that could not continue ends the resident process,
        // and a crash does the same: either way the Run settles as failed,
        // including the recorded request a person may replay.
        if (!(await prepareRunTransition(location, runId, "failed"))) return;
        const { error, failure } = mainRunFailure(last, code, signal);
        await event("main.run_failed", { error, code, signal, failure, ...(turnId ? { turnId } : {}) });
        try {
          await location.store.transitionTask(taskId, "failed", {
            runId,
            error,
            reason: "dashboard_main_exit"
          });
          // eslint-disable-next-line no-restricted-syntax -- 失败事件的原始错误已落盘，状态转换失败不能覆盖或中断收尾
        } catch {
          /* preserve original failure */
        }
        // This Run can never take another turn: its Session record is settled
        // here, exactly as an idle or completed exit settles its own.
        const failed = await location.store.readTask(taskId);
        if (failed.activeRunId === runId && (failed.status === "completed" || failed.status === "failed"))
          await finalizeSessionRun({ ...location, task: failed }, runId, failed.status);
        return;
      }
      // The process ended while a turn was in flight without reporting a
      // model error: settle that turn from what the Run recorded before exit.
      let coordination;
      try {
        coordination = await coordinator.waitForSubagents({
          taskId,
          runId,
          workspaceRoot: taskWorkspace,
          timeoutMs: 0
        });
      } catch (error) {
        if (!(await prepareRunTransition(location, runId, "waiting"))) return;
        await event("main.run_waiting", { reason: "completion_check_failed", error: String(error) });
        await location.store.transitionTask(taskId, "waiting", {
          runId,
          reason: "completion_check_failed"
        });
        return;
      }
      const assessment = assessTaskCompletion({
        pendingJobs: (
          await listJobs({
            directory: join(taskWorkspace, taskId, "runs", runId, "agents", "main", "jobs")
          })
        ).filter((job) => job.state === "running").length,
        pendingCalls: coordination.pending.length,
        pendingCallbacks: coordination.callbackPending.length,
        pendingHumanRequests: (await new HumanRequestStore(taskWorkspace).list(taskId, "pending")).length,
        pendingSubagentQuestions: (await new SubagentQuestionStore(taskWorkspace).list(taskId, "pending"))
          .length,
        // eslint-disable-next-line no-restricted-syntax -- 睡眠标记读不到时按未挂起处理，完成评估继续走正常判定
        parkedForWake: Boolean(await readSleep(taskWorkspace, taskId).catch(() => undefined)),
        hasFinalAnswer: isFinalAssistantMessage(last)
      });
      const pauseNow = assessment.ready ? undefined : (await location.store.readTask(taskId)).pause;
      if (pauseNow) {
        await settlePause(pauseNow);
        return;
      }
      const current = await prepareRunTransition(location, runId, assessment.ready ? "completed" : "waiting");
      if (!current) return;
      // eslint-disable-next-line no-restricted-syntax -- 停泊记录损坏时按未停泊处理，结算不因一条读不出的记录中断
      const parkedForWake = Boolean(await readSleep(taskWorkspace, taskId).catch(() => undefined));
      if (assessment.ready || parkedForWake) await resetMainSupervisorBackoff(taskWorkspace, taskId);
      await event(assessment.ready ? "main.run_completed" : "main.run_waiting", {
        code,
        signal,
        coordination,
        reason: assessment.reason
      });
      try {
        await location.store.transitionTask(taskId, assessment.ready ? "completed" : "waiting", {
          runId,
          reason: assessment.ready ? "dashboard_main_exit" : assessment.reason,
          completion: {
            signal: assessment.ready
              ? current.completion?.signal === "finish_task"
                ? "finish_task"
                : "natural_stop"
              : "interrupted"
          }
        });
        // eslint-disable-next-line no-restricted-syntax -- 终态事件已经落盘，状态转换失败不能让这次 Run 收尾中断
      } catch {
        /* preserve event */
      }
      const finalized = await location.store.readTask(taskId);
      if (
        finalized.activeRunId === runId &&
        (finalized.status === "completed" || finalized.status === "failed")
      )
        await finalizeSessionRun({ ...location, task: finalized }, runId, finalized.status);
    })()
      .catch((error) =>
        console.error(
          `[cowork] run finalization failed: ${error instanceof Error ? error.message : String(error)}`
        )
      )
      .finally(async () => {
        finalizations.delete(finalization);
        if (taskFinalizations.get(taskId) === finalization) taskFinalizations.delete(taskId);
        if (resident) resident.settled = true;
        if (residentMains.get(taskId) === resident) {
          residentMains.delete(taskId);
          activeRuns.delete(taskId);
          pendingTurns.delete(taskId);
          interjectionTargets.delete(taskId);
          onRunExit(taskId);
        }
        if (activeRunIds.get(taskId) === runId) activeRunIds.delete(taskId);
        // The process is gone, so this Run no longer occupies an external
        // slot; the next waiting demand may start now.
        if (resident?.requestId && mainCapacity)
          await mainCapacity
            .release(resident.requestId)
            .catch((error) =>
              console.error(
                `[cowork] external capacity release failed: ${error instanceof Error ? error.message : String(error)}`
              )
            );
        // A quick reply can arrive while askhuman's process is still exiting.
        // Wait for its durable settlement before starting the resumed session.
        if (!isStopping() && humanWakeups.has(taskId)) void resumeHumanAnswers(taskId);
      });
    finalizations.add(finalization);
    taskFinalizations.set(taskId, finalization);
    return finalization;
  }

  /**
   * What a resident Main's finished turn means for its Run and its place.
   *
   * The extension writes the Task's boundary and heartbeat before Pi emits the
   * event this backend observes, so the record already says whether the turn
   * completed, settled into waiting, or stopped at a pause. A terminal Run is
   * finalized here because its process may live for many more turns.
   *
   * The slot goes back to the queue only when this boundary still owns it and
   * the Run has no delegated work outstanding: a turn admitted (or delegated
   * work started) since the boundary keeps the place, and the release itself
   * re-checks the claim under the ledger lock so a late settlement can never
   * free a newer turn's slot. What the work held is released at the same
   * boundary, so a resource that belongs to the Run's work does not wait for
   * the process to end.
   */
  async function settleResidentTurn(
    resident: ResidentMain,
    boundaryRequestId: string | undefined
  ): Promise<void> {
    // eslint-disable-next-line no-restricted-syntax -- 回合结束的记账失败只影响这一个回合；进程退出与下一次回合边界仍会结算
    const task = await resident.location.store.readTask(resident.taskId).catch(() => undefined);
    if (!task || task.activeRunId !== resident.runId) return;
    if (task.status === "completed" || task.status === "failed")
      await finalizeSessionRun({ ...resident.location, task }, resident.runId, task.status);
    // A waiting Task still has delegated work to run; a running one has not
    // written its own boundary yet. Every resting state is between turns.
    if (!["completed", "paused", "failed", "cancelled"].includes(task.status)) return;
    // Delegated work keeps whatever the Run's work holds: a Subagent still
    // running or a callback that has not reached Main means the work has not
    // ended, whatever the turn records.
    const unfinished = subagents?.unfinishedWork
      ? await subagents
          .unfinishedWork({ taskId: resident.taskId, runId: resident.runId })
          // eslint-disable-next-line no-restricted-syntax -- 读不到时按仍有未完成工作处理，保守保留名额与会话
          .catch(() => true)
      : false;
    // The work ended at this boundary, but the process may live for many more
    // turns: what the work held is released now, at the same moment as its
    // place. A turn accepted since the boundary is the work now, and a pause
    // still has work to do, so both keep it.
    if (!unfinished && !resident.turnActive && !pendingTurns.has(resident.taskId) && task.status !== "paused")
      onRunSettled(resident.taskId);
    if (!boundaryRequestId || !mainCapacity) return;
    // This process may already have taken another turn since the boundary: a
    // delivery rebinds the claim, and an accepted turn that has not started is
    // recorded as pending. Either means the place is in use again.
    if (resident.requestId !== boundaryRequestId) return;
    // A slot is held while delegated work is unfinished, whatever the turn is
    // doing: a paused Main with a Subagent still running keeps its place.
    if (unfinished) return;
    // A turn that started after the boundary (or was accepted and has not
    // written its first boundary yet) owns the claim now.
    if (resident.turnActive || pendingTurns.has(resident.taskId)) return;
    const released = await mainCapacity
      .releaseIfCurrent(resident.taskId, resident.runId, boundaryRequestId)
      .catch((error) => {
        console.error(
          `[cowork] external capacity release failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return false;
      });
    if (released) resident.requestId = undefined;
  }

  return { finalizeSessionRun, prepareRunTransition, handleResidentExit, settleResidentTurn };
}
