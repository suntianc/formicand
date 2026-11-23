import { resetMainSupervisorBackoff } from "../../dist/src/runtime/main-supervisor.js";
import { queuedUserTurn } from "../../dist/src/runtime/queued-user-turn.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CoordinatorRuntime } from "../../dist/src/runtime/coordinator-runtime.js";
import { HumanRequestStore } from "../../dist/src/runtime/human.js";
import type { updateMainContextRuntime } from "../../dist/src/runtime/main-context.js";
import { HEARTBEAT_STALE_MS, writeHeartbeat } from "../../dist/src/runtime/main-heartbeat.js";
import { onProcessWake, startAgentWake, stopAgentWake } from "../../dist/src/runtime/agent-wake.js";
import { watchFiles, type StopWatching } from "../../dist/src/runtime/file-watch.js";
import {
  MainInboxDelivery,
  isCancelledCallback,
  type MainControlType
} from "../../dist/src/runtime/main-inbox-delivery.js";
import { pauseSubagents, resumeSubagents } from "../../dist/src/runtime/subagent-pause.js";
import {
  MAIN_CONTINUATION_TYPE,
  mainInputPath,
  readMainInput
} from "../../dist/src/runtime/main-continuation.js";
import { readSleep } from "../../dist/src/runtime/main-sleep.js";
import {
  configuredMainMaxTurns,
  configuredMainIdleTimeout,
  configuredMainTimeout
} from "../../dist/src/runtime/runtime-settings.js";
import { SubagentQuestionStore } from "../../dist/src/runtime/subagent-questions.js";
import { assessTaskCompletion, isFinalAssistantMessage } from "../../dist/src/runtime/task-completion.js";
import { JsonlEventStore } from "../../dist/src/storage/event-store.js";
import { LocalWorkspaceStore } from "../../dist/src/workspace/workspace-store.js";
import { errorMessage } from "./helpers.ts";
import type { registerContextWindows } from "./context-windows.ts";

interface MainLifecycleOptions {
  workspaceRoot: string;
  taskId: string;
  mainRunId: string;
  runtimeEnv: NodeJS.ProcessEnv;
  windows: Pick<ReturnType<typeof registerContextWindows>, "fromComposer">;
  pollJobs(): Promise<number>;
  isReplaying(): boolean;
  replayWithoutNewContext(): boolean;
  persistSession(ctx: ExtensionContext): Promise<void>;
  updateRuntime(patch: Parameters<typeof updateMainContextRuntime>[1]): Promise<void>;
}

/** Owns the turn, queue wakes and timers for this Main process. */
export function registerMainLifecycle(
  pi: ExtensionAPI,
  {
    workspaceRoot,
    taskId,
    mainRunId,
    runtimeEnv,
    windows,
    pollJobs,
    isReplaying,
    replayWithoutNewContext,
    persistSession,
    updateRuntime
  }: MainLifecycleOptions
) {
  const inboxDelivery = new MainInboxDelivery(workspaceRoot, taskId, mainRunId);
  // A resident Main serves many turns from one process. It is started in Pi's
  // long-lived interface, its Inbox wakes it, and it exits only when the
  // session is closed, when it has been idle long enough, or when a turn
  // cannot continue (a model request that failed).
  const resident = process.env.COWORK_MAIN_RESIDENT === "1";
  let agentStartedAt = 0;
  let sessionContext: ExtensionContext | undefined;
  let turnActive = false;
  // Until the process's first turn starts, the Inbox is read as one batch: the
  // queued messages are appended and exactly one of them opens the run, so a
  // callback queued before startup cannot open a second run beside the user's.
  let firstTurnStarted = false;
  // Unique per process lifetime: a backend that adopts this process sees the
  // id change at every new turn and knows the previous one is over.
  let turnId = `${process.pid}-0`;
  let turnCount = 0;
  pi.on("agent_start", () => {
    agentStartedAt = Date.now();
  });
  // Pi 1.5 enables prompt-cache warming by default. CoworkOS does not adopt the
  // capability in this upgrade, so every refresh stops until the next real
  // request instead of sending an extra model call while Main is idle.
  pi.on("cache_warming_decision", () => ({ action: "stop" }));
  // A one-turn host already has a user prompt to start the turn, so startup
  // Inbox delivery must append to that context instead of racing it. A
  // resident Main has no such prompt: its Inbox is what starts the first turn.
  let awaitingInitialPrompt = process.env.COWORK_INITIAL_PROMPT === "1" && !resident;
  /**
   * Whether this process's first turn was accepted before a pause request.
   *
   * A pause stops new turns from starting, but it does not cancel the turn the
   * Run was already launched with: that turn ends at the next boundary, where
   * the pause becomes the Task's state. A message accepted while the Task was
   * paused is newer than the request and stays in the Inbox.
   */
  let startupTurnBeforePause = false;
  const startupTurnAcceptedBeforePause = async (): Promise<boolean> => {
    // eslint-disable-next-line no-restricted-syntax -- 任务读不到时按暂停生效处理：宁可让消息等下一次唤醒，也不越过暂停开始回合
    const task = await new LocalWorkspaceStore(workspaceRoot).readTask(taskId).catch(() => undefined);
    const requestedAt = Date.parse(task?.pause?.requestedAt ?? "");
    if (!task?.pause || !Number.isFinite(requestedAt)) return false;
    // eslint-disable-next-line no-restricted-syntax -- 输入记录缺失时无法证明这一轮早于暂停，按暂停生效处理
    const input = await readMainInput(mainInputPath(workspaceRoot, taskId, mainRunId)).catch(() => undefined);
    if (!input) return false;
    return input.submittedAt < requestedAt;
  };
  /**
   * Whether the Inbox already holds the message that starts this process's
   * first turn. Only a message the startup delivery will actually send counts:
   * a paused Main reads only commands, and follow-ups wait for a later turn.
   */
  const startupTurnPending = async (): Promise<boolean> => {
    const paused = !startupTurnBeforePause && (await pausedNow());
    for (const message of await inboxDelivery.pending()) {
      if (message.state !== "ready") continue;
      const payload = message.payload as { type?: string; delivery?: string; initial?: boolean } | undefined;
      if (paused) {
        if (payload?.type === "main.resume") return true;
        continue;
      }
      if (message.kind === "human_command" && payload?.type === "human.message")
        return payload.initial === true;
      // A cancelled Subagent's callback never starts a turn.
      if (isCancelledCallback(message)) continue;
      return true;
    }
    return false;
  };
  const pausedNow = async (): Promise<boolean> =>
    new LocalWorkspaceStore(workspaceRoot)
      .readTask(taskId)
      .then((task) => Boolean(task.pause) || task.status === "paused")
      // eslint-disable-next-line no-restricted-syntax -- 任务记录读不到时按未暂停处理；真正的暂停检查在回合边界还会再读一次
      .catch(() => false);
  const deliverCallbacks = async (includeFollowUps = false) => {
    // While an exact replay is pending, ordinary work stays queued: the old
    // request is resent as it was, not mixed with what arrived since. The
    // resume command is what starts that replay, so it is still read.
    const replaying = isReplaying();
    await inboxDelivery.deliver(
      async (message, options) => {
        if (options.userTurn) {
          // The first message of a Run is the person's own turn. The identity
          // marker lets the Inbox receipt be confirmed from saved context.
          pi.sendUserMessage(
            queuedUserTurn({
              taskId,
              runId: mainRunId,
              messageId: options.userTurn.messageId,
              text: message.content
            }),
            { deliverAs: options.deliverAs }
          );
          return;
        }
        // A person's insertion that arrives while a turn is running joins that
        // turn. If the turn has already ended, the person is still waiting for
        // an answer, so the message opens one — it is never appended silently.
        pi.sendMessage(message, awaitingInitialPrompt ? { ...options, triggerTurn: false } : options);
      },
      {
        includeFollowUps,
        paused: replaying || (!(startupTurnBeforePause && !firstTurnStarted) && (await pausedNow())),
        // An externally budgeted Run resumes a durable answer through the
        // backend, which first admits the turn it opens to that budget; a Run
        // outside the budget still opens the turn here as it always did.
        holdAnswers: process.env.COWORK_MAIN_CAPACITY_MANAGED === "1" && (sessionContext?.isIdle() ?? true),
        // Only the startup read before the first turn needs the batch: after
        // that, each message is steered into the turn already in flight.
        batchStart: !firstTurnStarted && (sessionContext?.isIdle() ?? true),
        onControl: (type, message) => handleMainControl(type, message.messageId)
      }
    );
  };
  const coordinator = new CoordinatorRuntime();
  const humanStore = new HumanRequestStore(workspaceRoot);
  const questionStore = new SubagentQuestionStore(workspaceRoot);
  const mainMaxTurns = configuredMainMaxTurns(runtimeEnv);
  const mainTimeoutMs = configuredMainTimeout(runtimeEnv);
  let mainTurns = 0;
  let inboxDeliveryActive = false;
  // Every wake counts, so one that arrives while a delivery pass is running
  // repeats that pass instead of being dropped.
  let inboxWakeCount = 0;
  let stopInboxWatch: StopWatching | undefined;
  /** Unsubscribe functions for this process's wake channel, one per session. */
  const wakeSubscriptions: Array<() => void> = [];
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let mainTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let lastMainMessage: unknown;
  const mainIdleTimeoutMs = configuredMainIdleTimeout(runtimeEnv);
  /**
   * Main pausing: first its Subagents, then itself.
   *
   * The Subagents of this Run are held at the end of their current step, then
   * the Task records the boundary it stopped at and reports itself paused.
   * Main's next turn lifts the hold (see `agent_start`).
   */
  const recordPause = async (pause: { requestedAt: string }) => {
    const taskStore = new LocalWorkspaceStore(workspaceRoot);
    await pauseSubagents(workspaceRoot, taskId, mainRunId);
    // Record when the turn stopped before the Task reports itself paused:
    // a reader that sees `paused` must already find the boundary time.
    const current = await taskStore.readTask(taskId);
    if (current.pause && !current.pause.pausedAt)
      await taskStore.updateTask(taskId, {
        pause: { ...current.pause, pausedAt: new Date().toISOString() }
      });
    await taskStore.transitionTask(taskId, "paused", { runId: mainRunId, reason: "ui_pause" });
    // The Turn stopped at this boundary; the Run keeps the pause on
    // record even though a resident process stays alive for the resume.
    try {
      await new JsonlEventStore(join(workspaceRoot, taskId, "runs", mainRunId, "run_events.jsonl")).append({
        eventId: `pause-${randomUUID()}`,
        type: "main.run_paused",
        taskId,
        runId: mainRunId,
        agentId: "main",
        occurredAt: new Date().toISOString(),
        payload: { reason: "ui_pause", requestedAt: pause.requestedAt }
      });
      // eslint-disable-next-line no-restricted-syntax -- 暂停已写入 Task；事件只是记录，写不进去不影响暂停
    } catch {
      /* the Task's pause is the durable fact */
    }
    await updateRuntime({
      runtimePhase: "waiting",
      runtimeLastEvent: { type: "main_turn_settled", summary: "paused" }
    });
  };

  const handleMainControl = async (type: MainControlType, messageId: string): Promise<boolean> => {
    if (type === "main.compact") {
      if (!sessionContext) return false;
      try {
        await windows.fromComposer(sessionContext, messageId);
      } catch (error) {
        sessionContext.ui.notify(`Could not open a new context window: ${errorMessage(error)}`, "warning");
      }
      return true;
    }
    if (type === "main.pause") {
      // A pause asked for while Main has no turn (it waits for its Subagents
      // between turns) is taken here, at once; a turn in flight takes it at
      // its next step boundary instead.
      const task = await new LocalWorkspaceStore(workspaceRoot).readTask(taskId);
      if (task.pause && task.status !== "paused" && (sessionContext?.isIdle() ?? true))
        await recordPause(task.pause);
      return true;
    }
    if (type === "main.interrupt") {
      // Interrupting stops the turn in flight and nothing else: the process,
      // the Task and the Subagents already running stay as they are.
      sessionContext?.abort();
      return true;
    }
    // Resume is a turn in the same session without a new message from the
    // person; the task record no longer says paused by the time this runs.
    pi.sendMessage(
      { customType: MAIN_CONTINUATION_TYPE, content: [], display: false },
      { triggerTurn: true }
    );
    return true;
  };

  const stopMainIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  /**
   * Restart the idle clock.
   *
   * The clock only runs between turns: a resident Main that is waiting for a
   * Subagent is working, and one that still has a turn in flight is not idle
   * even when no model request is on the wire at that instant.
   */
  const touchMainActivity = () => {
    stopMainIdleTimer();
    if (!resident || turnActive || mainIdleTimeoutMs <= 0) return;
    const timer = setTimeout(async () => {
      const idle = await canExitWhenIdle();
      // A new turn, Inbox wake or session close invalidates this check during its reads.
      if (idleTimer !== timer) return;
      if (idle) sessionContext?.shutdown();
      else touchMainActivity();
    }, mainIdleTimeoutMs);
    idleTimer = timer.unref();
  };
  const canExitWhenIdle = async () => {
    if (inboxDelivery.queuedCount || sessionContext?.hasPendingMessages()) return false;
    const pending = await coordinator
      .waitForSubagents({ taskId, runId: mainRunId, workspaceRoot, timeoutMs: 0 })
      // eslint-disable-next-line no-restricted-syntax -- 协作者队列读不到时按仍有工作在跑处理，宁可多留一会儿也不丢失等待中的回调
      .catch(() => undefined);
    if (!pending || pending.pending.length || pending.callbackPending.length) return false;
    // A paused Task keeps its queued messages for the next Main.
    return (await pausedNow()) || (await inboxDelivery.pending()).length === 0;
  };
  /**
   * Close the Run's interval in the durable event log at a settled turn.
   *
   * The Run service used to write this when the one-turn process exited. A
   * resident Main ends its turn and keeps running, so its boundary is the only
   * place the close is written: readers of the exchange (the conversation's
   * final answer, Run duration and the pulse lanes) take the last of these
   * events as the turn's outcome, and without it a settled turn stays "running"
   * behind an earlier failure for the rest of the process's life.
   */
  const appendRunBoundary = async (type: string, payload: unknown): Promise<void> => {
    try {
      await new JsonlEventStore(join(workspaceRoot, taskId, "runs", mainRunId, "run_events.jsonl")).append({
        eventId: `boundary-${randomUUID()}`,
        type,
        taskId,
        runId: mainRunId,
        agentId: "main",
        occurredAt: new Date().toISOString(),
        payload
      });
      // eslint-disable-next-line no-restricted-syntax -- Task 状态已落盘；事件只是同一边界的记录，写不进去由进程退出时的结算补上
    } catch {
      /* the Task state is the durable fact */
    }
  };

  pi.on("agent_settled", async (_event, ctx) => {
    const settlingTurn = turnId;
    const failedTurn = lastMainMessage as { role?: string; stopReason?: string } | undefined;
    const modelFailed = failedTurn?.role === "assistant" && failedTurn.stopReason === "error";
    try {
      sessionContext = ctx;
      await persistSession(ctx);
      const replayOnly = replayWithoutNewContext();
      await inboxDelivery.settle(replayOnly ? [] : ctx.sessionManager.getEntries());
      try {
        const taskStore = new LocalWorkspaceStore(workspaceRoot);
        const task = await taskStore.readTask(taskId);
        // eslint-disable-next-line no-restricted-syntax -- sleep 记录缺失或损坏时按未 park 处理，settle 流程继续
        const parked = await readSleep(workspaceRoot, taskId).catch(() => undefined);
        if (
          isFinalAssistantMessage(lastMainMessage) ||
          (parked && Date.parse(parked.parkedAt) >= agentStartedAt)
        )
          await resetMainSupervisorBackoff(workspaceRoot, taskId);
        // A resident Main stays alive when a pause stops the turn: the pause
        // is recorded here, at the boundary it stopped at, and the process
        // waits with its Inbox untouched until the resume command arrives.
        // A resident Main's failed model request ends its process, and the Run
        // service settles that Run from the exit, so this boundary records
        // nothing. A one-turn host has no backend to project that exit: its
        // failed turn is still settled here, as it always was.
        if (resident && modelFailed) {
          ctx.shutdown();
          return;
        }
        if (task.pause && task.status === "running") {
          await recordPause(task.pause);
        } else if (task.status === "running" && !task.pause) {
          const pending = await coordinator.waitForSubagents({
            taskId,
            runId: mainRunId,
            workspaceRoot,
            timeoutMs: 0
          });
          const assessment = assessTaskCompletion({
            pendingCalls: pending.pending.length,
            pendingJobs: await pollJobs(),
            pendingCallbacks: Math.max(inboxDelivery.queuedCount, pending.callbackPending.length),
            pendingHumanRequests: (await humanStore.list(taskId, "pending")).length,
            pendingSubagentQuestions: (await questionStore.list(taskId, "pending")).length,
            // eslint-disable-next-line no-restricted-syntax -- 没有 sleep 记录或记录损坏时按未 park 处理，完成判定走正常路径
            parkedForWake: Boolean(await readSleep(workspaceRoot, taskId).catch(() => undefined)),
            hasFinalAnswer: isFinalAssistantMessage(lastMainMessage)
          });
          if (!assessment.ready) {
            await taskStore.transitionTask(taskId, "waiting", {
              runId: mainRunId,
              reason: assessment.reason,
              completion: {
                signal: isFinalAssistantMessage(lastMainMessage) ? "natural_stop" : "interrupted"
              }
            });
            await appendRunBoundary("main.run_waiting", {
              coordination: pending,
              reason: assessment.reason
            });
            await updateRuntime({
              runtimePhase: "waiting",
              runtimePendingDelegations: pending.pending.length + pending.callbackPending.length,
              runtimeLastEvent: { type: "main_turn_settled", summary: assessment.reason }
            });
          } else {
            const completed = await taskStore.transitionTask(taskId, "completed", {
              runId: mainRunId,
              reason: "main_turn_settled",
              completion: {
                signal: task.completion?.signal === "finish_task" ? "finish_task" : "natural_stop",
                verifiedAt: new Date().toISOString()
              }
            });
            await appendRunBoundary("main.run_completed", {
              coordination: pending,
              reason: "main_turn_settled"
            });
            await updateRuntime({
              runtimePhase: "completed",
              runtimePendingDelegations: 0,
              runtimeLastEvent: {
                type: "task_completed",
                summary: completed.completion?.summary ?? "Main turn completed"
              }
            });
          }
        }
      } catch (error) {
        ctx.ui.notify(`Task lifecycle update failed: ${errorMessage(error)}`, "warning");
      }
    } catch (error) {
      ctx.ui.notify(`Task settlement hook failed: ${errorMessage(error)}`, "warning");
    } finally {
      if (turnId === settlingTurn) {
        // A model failure stays active until the backend settles the process exit.
        turnActive = modelFailed;
        touchMainActivity();
      }
      // The durable turn record is what the next turn state is read from. It is
      // written after the boundary's Task status, so a reader never sees the
      // Task settled while the record still says a turn is running; a paused
      // Task is reported idle by the backend's read of this same record.
      if (resident) {
        // eslint-disable-next-line no-restricted-syntax -- 心跳只是存活与回合提示，写入失败由下一次写入重写
        void writeMainHeartbeat().catch(() => {});
      }
    }
  });

  const writeMainHeartbeat = () => writeHeartbeat(workspaceRoot, taskId, mainRunId, { turnActive, turnId });
  pi.on("agent_start", async (_event, ctx) => {
    awaitingInitialPrompt = false;
    lastMainMessage = undefined;
    sessionContext = ctx;
    firstTurnStarted = true;
    turnActive = true;
    turnCount += 1;
    turnId = `${process.pid}-${turnCount}`;
    stopMainIdleTimer();
    // Tell any supervisor, and a backend that adopted this process, that the
    // Task has a turn running right now. A one-turn process reports liveness
    // on the regular interval only; its turn flag is not what is read.
    if (resident) {
      // eslint-disable-next-line no-restricted-syntax -- 心跳只是存活与回合提示，写入失败由下一次写入重写
      void writeMainHeartbeat().catch(() => {});
    }
    if (mainTimeoutTimer) clearTimeout(mainTimeoutTimer);
    if (mainTimeoutMs > 0) {
      mainTimeoutTimer = setTimeout(() => {
        ctx.abort();
        ctx.ui.notify(
          `Main reached the ${mainTimeoutMs}ms wall-clock deadline; checkpoint and artifacts are resumable`,
          "warning"
        );
      }, mainTimeoutMs);
    }
    // A closed Task is not reopened by a message that arrived while it was
    // closing: a late Subagent callback must not turn a cancelled session back
    // into a running one. An explicit new run transitions it first.
    const taskStore = new LocalWorkspaceStore(workspaceRoot);
    const startedTask = await taskStore.readTask(taskId);
    if (startedTask.status !== "cancelled")
      await taskStore.transitionTask(taskId, "running", {
        runId: mainRunId,
        reason: "main_turn_started"
      });
    // Resuming: Main's turn has started, so its Subagents go on from where
    // they were held. A turn the pause has not lifted keeps them held.
    if (startedTask.status !== "cancelled" && !startedTask.pause)
      await resumeSubagents(workspaceRoot, taskId, mainRunId);
    await updateRuntime({
      runtimePhase: "active",
      runtimeRouting: { strategy: "undecided", reason: "Main turn started" },
      runtimeLastEvent: { type: "main_turn_started" }
    });
  });
  pi.on("agent_end", async (event, ctx) => {
    try {
      sessionContext = ctx;
      const last = event.messages.findLast((message) => message.role === "assistant");
      lastMainMessage = last;
      if (resident && last?.stopReason === "error" && !isContextOverflow(last)) {
        // A failed model request is not a resting state: the session cannot
        // continue past it, and the backend settles the Run (and frees the
        // retry slot) from this exit. A person's retry starts the archived
        // request again in a fresh process, as it always did. The record stays
        // active until that exit: the backend's failed settlement is the
        // boundary, so an idle record here would report a still-running Task
        // as having no turn.
        ctx.shutdown();
        return;
      }
      if (!last || ["error", "aborted", "length"].includes(last.stopReason)) return;
      // Pi awaits this hook before settling --print. Keep the Main session
      // alive for outstanding one-shot work and let queued callbacks trigger
      // another turn before a final answer is accepted.
      let waitingFor = "";
      while (!ctx.signal?.aborted && mainTurns < mainMaxTurns) {
        const task = await new LocalWorkspaceStore(workspaceRoot).readTask(taskId);
        if (
          ["cancelled", "failed", "paused"].includes(task.status) ||
          task.pause ||
          (await humanStore.list(taskId, "pending")).length
        )
          return;
        // Before delivery, so a job that just exited wakes Main on this pass
        // rather than waiting for the next one.
        const runningJobs = await pollJobs();
        await deliverCallbacks(true);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧版 Pi 宿主没有 hasPendingMessages，缺方法时只能依赖 Inbox 队列计数
        if (inboxDelivery.queuedCount || ctx.hasPendingMessages?.()) return;
        const pending = await coordinator.waitForSubagents({
          taskId,
          runId: mainRunId,
          workspaceRoot,
          timeoutMs: 0
        });
        if (runningJobs || pending.pending.length || pending.callbackPending.length) {
          const signature = JSON.stringify([runningJobs, pending.pending, pending.callbackPending]);
          if (signature !== waitingFor) {
            waitingFor = signature;
            updateRuntime({
              runtimePhase: "waiting",
              runtimePendingDelegations: pending.pending.length + pending.callbackPending.length
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        return;
      }
    } finally {
      if (mainTimeoutTimer) clearTimeout(mainTimeoutTimer);
      mainTimeoutTimer = undefined;
    }
  });
  pi.on("turn_end", async (event, ctx) => {
    // A user pause is read from the Task record at the boundary between two
    // steps: the current tool call and model reply have settled, so aborting
    // here starts no new tool call or model request. The Run's close path
    // records the pause only if this boundary did not complete the Task.
    const pausedTask = await new LocalWorkspaceStore(workspaceRoot).readTask(taskId);
    if (pausedTask.pause || pausedTask.status === "paused") {
      ctx.abort();
      return;
    }
    mainTurns += 1;
    if (mainTurns >= mainMaxTurns) {
      ctx.abort();
      ctx.ui.notify(`Main reached the ${mainMaxTurns}-turn session limit`, "warning");
    } else if (
      event.message.role === "assistant" &&
      !["error", "aborted"].includes(event.message.stopReason)
    ) {
      // Drain accepted user messages before Pi chooses its next model call.
      // Leave follow-ups durable and promotable until the current work ends.
      await deliverCallbacks(event.message.stopReason === "stop");
    }
  });

  async function startInbox(ctx: ExtensionContext) {
    if (!isReplaying()) await inboxDelivery.acknowledge(ctx.sessionManager.getEntries());
    // A pause that arrived after this Run's first turn was accepted stops the
    // next turn, not the accepted one. Decide that before any delivery: the
    // record of the accepted input is older than the pause request, while
    // work that arrived while paused is newer and stays queued.
    if (resident && !firstTurnStarted) startupTurnBeforePause = await startupTurnAcceptedBeforePause();
    const pollMainInbox = async (): Promise<void> => {
      inboxWakeCount += 1;
      // The running pass may have read the Inbox before this wake's write,
      // so it repeats once it is done rather than dropping the wake.
      if (inboxDeliveryActive) return;
      inboxDeliveryActive = true;
      try {
        for (;;) {
          const observed = inboxWakeCount;
          await deliverCallbacks();
          if (inboxWakeCount === observed) return;
        }
      } finally {
        inboxDeliveryActive = false;
      }
    };
    // A backend, a Subagent or a peer writes this Inbox and then nudges the
    // process that owns it. That nudge is what an OS directory event the host
    // reports late, coalesces or never delivers cannot take away; the watch
    // below stays as the second, best-effort wake.
    // The channel is bound once per process; each session only re-subscribes,
    // because a second listener on one endpoint would unlink the first.
    await startAgentWake().catch((error: unknown) =>
      ctx.ui.notify(`Main Inbox wake channel failed: ${errorMessage(error)}`, "warning")
    );
    for (const unsubscribe of wakeSubscriptions.splice(0)) unsubscribe();
    wakeSubscriptions.push(
      onProcessWake(() => {
        // eslint-disable-next-line no-restricted-syntax -- Pi 可能在子任务结束前销毁 Main，发送失败会释放 Inbox 租约并由下一次启动重新投递
        void pollMainInbox().catch(() => {
          // The next wake re-reads the same durable Inbox.
        });
        touchMainActivity();
      })
    );
    // The launch queued the turn that starts this process. Record it before
    // delivering, so a backend that reads the durable turn record between
    // process start and the first agent_start does not see an idle Main while
    // its first turn is already on its way.
    if (resident && !firstTurnStarted) {
      turnActive = await startupTurnPending();
      // eslint-disable-next-line no-restricted-syntax -- 心跳只是存活与回合提示，写入失败由下一次写入重写
      void writeMainHeartbeat().catch(() => {});
    }
    await pollMainInbox();
    // External events and callbacks are written to Main's Inbox by other
    // services. The writer's own notification is what reaches this process
    // while it is idle; the directory watch beside it is the fallback for a
    // queue the OS reports late or coalesces. Neither stdin nor polling is
    // involved, and if Main is offline the same messages stay durable for the
    // next startup.
    stopInboxWatch?.();
    stopInboxWatch = await watchFiles([inboxDelivery.inboxPath], () => {
      // eslint-disable-next-line no-restricted-syntax -- Pi 可能在子任务结束前销毁 Main，发送失败会释放 Inbox 租约并由下一次启动重新投递
      void pollMainInbox().catch(() => {
        // Pi can dispose Main before its children finish. Failed sends
        // release their leases; the next Main recovers the durable Inbox.
      });
      touchMainActivity();
    }).catch((error: unknown) => {
      // A watch that cannot attach leaves the durable Inbox for the next
      // process; turn boundaries still deliver what is already queued.
      ctx.ui.notify(`Main Inbox watch failed: ${errorMessage(error)}`, "warning");
      return undefined;
    });
    // Tell any supervisor that this Task already has a Main. Without this a
    // supervisor would read "no Main" while one is running and start a
    // second, putting two agents on the same project. The turn flag was
    // written above, before the delivery; it is not rewritten here because
    // Pi may already have started the turn and this write would be older.
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(
      // eslint-disable-next-line no-restricted-syntax -- 定时心跳写入失败时下一次 tick 会重写心跳文件，单次失败不影响 interval 本身
      () => void writeMainHeartbeat().catch(() => {}),
      Math.max(1_000, Math.floor(HEARTBEAT_STALE_MS / 3))
    );
    heartbeatTimer.unref();
    touchMainActivity();
  }
  async function close() {
    stopInboxWatch?.();
    stopInboxWatch = undefined;
    for (const unsubscribe of wakeSubscriptions.splice(0)) unsubscribe();
    await stopAgentWake();
    stopMainIdleTimer();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    // A message handed to Pi but never read before this process ends becomes
    // readable for the next Main now, not after the lease expires.
    // eslint-disable-next-line no-restricted-syntax -- 进程正在退出；未能交回的消息仍会在租约到期后可读
    await inboxDelivery.releaseUnconfirmed().catch(() => {});
  }
  return {
    coordinator,
    humanStore,
    questionStore,
    inboxDelivery,
    deliverCallbacks,
    startInbox,
    close,
    setSession(ctx: ExtensionContext) {
      sessionContext = ctx;
    },
    get turnCount() {
      return mainTurns;
    },
    maxTurns: mainMaxTurns
  };
}
