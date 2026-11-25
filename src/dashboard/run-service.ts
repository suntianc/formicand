import { applyEndpointLimits } from "../runtime/model-limits.js";
import type { ChildProcess } from "node:child_process";

import { createTaskLifecycle } from "./task-lifecycle.js";
import type { ResidentMain } from "./resident-main.js";
import { createResidentMainSettlement } from "./resident-main-settlement.js";
import { createResidentMainRegistry } from "./resident-main-registry.js";
import { createResidentMainTurnDelivery } from "./resident-main-turn-delivery.js";
import { createMainRunAdmission } from "./main-run-admission.js";
import { createMainRunProcess } from "./main-run-process.js";
import { createMainRunGuardian } from "./main-run-guardian.js";
import { createMainMessageService } from "./main-message-service.js";
import { createTaskRunControl } from "./task-run-control.js";
import { createHumanRunRecovery } from "./human-run-recovery.js";

import {
  deferredMainLaunch,
  type InterjectionTarget,
  type MainLaunchAdmission,
  type MainLaunchReceipt,
  type MainLaunchSubmission,
  type RunServicePorts
} from "./run-service-contracts.js";

export type {
  InterjectionTarget,
  MainLaunchAdmission,
  MainLaunchSubmission,
  RunServicePorts
} from "./run-service-contracts.js";

/** Owns durable Run transitions and human-answer resumption; HTTP has no process ownership. */
export function createDashboardRunService({
  projectRoot,
  uploads,
  dashboardUrl,
  runCredential,
  coordinator,
  subagents,
  locateTask,
  readWindowDevelopment,
  resolveMainModel,
  endpointLimits = async () => undefined,
  onRunSettled = () => {},
  onRunExit = () => {},
  onRunFinalized = async () => {},
  onTaskCancelling = () => {},
  withTaskProjectLock = (_taskId, action) => action(),
  mainSessions,
  mainCapacity,
  mainGuardian,
  normalizeModel,
  appendRunEvent,
  readJsonFile
}: RunServicePorts) {
  const residentMains = new Map<string, ResidentMain>();

  // A turn accepted for delivery but not yet recorded by the extension. The
  // record wins as soon as it is newer than this acceptance, so the flag only
  // covers the gap between the API accepting the turn and Pi writing its
  // first boundary.
  const pendingTurns = new Map<string, number>();

  /** Spawned handles, so a stop can report the process it actually ended. */
  const activeRuns = new Map<string, ChildProcess>();
  const activeRunIds = new Map<string, string>();
  const interjectionTargets = new Map<string, InterjectionTarget>();
  let stopping = false;
  const finalizations = new Set<Promise<void>>();
  const taskFinalizations = new Map<string, Promise<void>>();
  const cancellations = new Set<string>();
  const taskOperations = new Map<string, Promise<unknown>>();

  function serialize<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const previous = taskOperations.get(taskId) ?? Promise.resolve();
    // eslint-disable-next-line no-restricted-syntax -- 上一次操作的失败已返回给它的调用方，串行队列只需让下一个动作继续执行
    const next = previous.catch(() => {}).then(action);
    taskOperations.set(taskId, next);
    void next
      .finally(() => {
        if (taskOperations.get(taskId) === next) taskOperations.delete(taskId);
      })
      // eslint-disable-next-line no-restricted-syntax -- 这条清理链只删除 taskOperations 映射，动作结果已由 next 返回给调用方
      .catch(() => {});
    return next;
  }

  const humanWakeups = new Set<string>();
  const humanResumes = new Map<string, Promise<{ status: string; error?: string }>>();

  const isStopping = () => stopping;

  const { finalizeSessionRun, prepareRunTransition, handleResidentExit, settleResidentTurn } =
    createResidentMainSettlement({
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
      resumeHumanAnswers: (taskId) => resumeHumanAnswers(taskId),
      subagents,
      onRunSettled
    });

  const {
    residentMain,
    stopResidentMain,
    adoptResidentMain,
    residentFor,
    adoptExistingMains,
    taskTurnActive,
    mainProcessRunning,
    ensureMainProcess,
    closeIdleMain
  } = createResidentMainRegistry({
    residentMains,
    taskFinalizations,
    projectRoot,
    handleResidentExit,
    activeRunIds,
    interjectionTargets,
    mainCapacity,
    locateTask,
    isStopping,
    mainGuardian,
    appendRunEvent,
    activeRuns,
    pendingTurns
  });

  const { deliverResidentTurn } = createResidentMainTurnDelivery({
    residentMain,
    normalizeModel,
    resolveMainModel,
    pendingTurns,
    appendRunEvent,
    interjectionTargets
  });

  const { admitExternal, reuseResidentMain } = createMainRunAdmission({
    mainSessions,
    mainCapacity,
    residentFor,
    stopResidentMain,
    coordinator,
    deliverResidentTurn
  });

  const { prepareMainRun, acceptMainRun, spawnResidentMain } = createMainRunProcess({
    resolveMainModel,
    normalizeModel,
    isStopping,
    appendRunEvent,
    pendingTurns,
    runCredential,
    dashboardUrl,
    projectRoot,
    residentMains,
    serialize,
    settleResidentTurn,
    activeRuns,
    handleResidentExit,
    finalizeSessionRun,
    mainCapacity,
    activeRunIds,
    interjectionTargets,
    onRunExit
  });

  async function launchMainRunWithAdmission(
    taskId: string,
    prompt: string,
    requestedRunId?: string,
    resume = false,
    requestedModel?: string,
    retryRequestId?: string,
    submission?: MainLaunchSubmission,
    admission: MainLaunchAdmission = { spawned: false }
  ): Promise<MainLaunchReceipt> {
    if (stopping) throw new Error("Runtime is shutting down");
    // A dispatched demand already owns its slot; keep that identity so the
    // process record and the release below address the same claim.
    if (submission?.admittedRequestId) admission.requestId = submission.admittedRequestId;
    const location = await locateTask(taskId);
    const task = location.task;
    // An answer can be queued while an edit replaces its Run. Validate before
    // any process decision so it cannot resume the replacement branch.
    if (submission?.source === "human" && task.activeRunId !== requestedRunId)
      throw new Error("该问题所属运行已变更，请刷新任务。");
    const options = { prompt, requestedRunId, resume, requestedModel, retryRequestId, submission };
    const resident = await reuseResidentMain(location, options, admission);
    if ("status" in resident) return resident;
    const { replaceResident } = resident;
    const existing = activeRuns.get(taskId);
    if (existing && !existing.killed && !replaceResident)
      throw new Error("Task already has an active Main run");
    const prepared = await prepareMainRun(location, options);
    const { runId, roleRequest } = prepared;
    // External capacity is decided here, with the Run id fixed and every other
    // refusal already applied. A queued demand records no Run and starts no
    // process, so "waiting for a slot" never looks like a running Main.
    const capacity = await admitExternal({
      location,
      runId,
      prompt,
      resume: prepared.continueSession,
      ...(submission ? { submission } : {}),
      ...(requestedModel ? { requestedModel } : {}),
      ...(retryRequestId ? { retryRequestId } : {})
    });
    if (capacity) {
      if (capacity.decision.state !== "running")
        return deferredMainLaunch(
          capacity.decision,
          capacity.sessionId,
          taskId,
          runId,
          prepared.configuredModel
        );
      admission.requestId = capacity.decision.requestId;
    }
    // The connection, model and reasoning profile are fixed here, at the moment
    // this demand owns a slot: a host/project default changed while it waited
    // applies now, while an explicit profile/model/thinking choice above stays
    // the user's. The snapshot lives only in this process and on the Run record.
    // A field the connection leaves to the endpoint takes this model's own value.
    const resolved = resolveMainModel(roleRequest);
    const selection = applyEndpointLimits(resolved, await endpointLimits(resolved));
    if (!selection.baseUrl || !selection.apiKey)
      throw new Error("模型 API 未配置：请填写 config.json 或 .formicand/config.json");
    // This demand owns its place and its model: the settled resident that
    // served the previous Run can be replaced now without stranding the demand
    // in the queue behind an idle process, and without ending a process for a
    // demand that never runs.
    if (replaceResident) await stopResidentMain(taskId, { replacing: true });
    const accepted = await acceptMainRun(location, options, prepared, selection);
    const result = await spawnResidentMain(location, submission, prepared, accepted, selection, admission);
    return capacity ? { ...result, sessionId: capacity.sessionId } : result;
  }

  async function launchMainRun(
    ...args: [
      taskId: string,
      prompt: string,
      requestedRunId?: string,
      resume?: boolean,
      requestedModel?: string,
      retryRequestId?: string,
      submission?: MainLaunchSubmission
    ]
  ) {
    const admission: MainLaunchAdmission = { spawned: false };
    try {
      return await launchMainRunWithAdmission(
        args[0],
        args[1],
        args[2],
        args[3] ?? false,
        args[4],
        args[5],
        args[6],
        admission
      );
    } catch (error) {
      // A Run that never reached a process owns no slot; one that did keeps its
      // slot until the process exits, and only its queue row is settled here.
      if (admission.requestId && mainCapacity) {
        // eslint-disable-next-line no-restricted-syntax -- 启动失败要原样抛给调用方，容量记账失败不能替换这个错误
        if (admission.spawned) await mainCapacity.markStarted(admission.requestId).catch(() => {});
        // eslint-disable-next-line no-restricted-syntax -- 启动失败要原样抛给调用方，释放容量失败不能替换这个错误
        else await mainCapacity.release(admission.requestId).catch(() => {});
      }
      throw error;
    }
  }

  function startMainRun(...args: Parameters<typeof launchMainRun>) {
    return withTaskProjectLock(args[0], () => serialize(args[0], () => launchMainRun(...args)));
  }

  const { runMainGuardianCycle, startMainGuardian, stopMainGuardian } = createMainRunGuardian({
    isStopping,
    mainGuardian,
    residentMain,
    activeRuns,
    startMainRun
  });

  const { editMainMessage, interjectionTarget, queueInterjection, queuedMessageAction } =
    createMainMessageService({
      withTaskProjectLock,
      serialize,
      locateTask,
      taskFinalizations,
      taskTurnActive,
      adoptResidentMain,
      stopResidentMain,
      uploads,
      launchMainRun,
      residentMain,
      activeRuns,
      residentFor,
      interjectionTargets,
      isStopping,
      activeRunIds,
      appendRunEvent,
      readJsonFile
    });

  const { withIdleProjectTasks, compactMainContext, pauseTask, stopTask, cancelTask } = createTaskRunControl({
    serialize,
    locateTask,
    adoptResidentMain,
    taskTurnActive,
    stopResidentMain,
    activeRuns,
    residentMains,
    taskFinalizations,
    coordinator,
    withTaskProjectLock,
    readJsonFile,
    resolveMainModel,
    readWindowDevelopment,
    appendRunEvent,
    subagents,
    onTaskCancelling,
    finalizeSessionRun,
    cancellations,
    mainCapacity,
    humanWakeups,
    activeRunIds,
    prepareRunTransition
  });

  const { pendingHumanAnswers, resumeHumanAnswers } = createHumanRunRecovery({
    humanResumes,
    locateTask,
    humanWakeups,
    adoptResidentMain,
    activeRuns,
    startMainRun
  });

  const taskLifecycle = createTaskLifecycle({
    locateTask,
    serialize,
    coordinator,
    ensureMainProcess,
    taskTurnActive,
    closeIdleMain
  });

  return {
    ownsMainProcess(root: string, taskId: string, runId: string): boolean {
      const resident = residentMains.get(taskId);
      const child = activeRuns.get(taskId);
      return (
        resident?.location.workspaceRoot === root &&
        resident.runId === runId &&
        child !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      );
    },
    activeRuns,
    taskTurnActive,
    mainProcessRunning,
    adoptExistingMains,
    isBusy: () => activeRuns.size > 0 || taskOperations.size > 0 || finalizations.size > 0,
    startMainRun,
    pauseTask,
    compactMainContext,
    stopTask,
    editMainMessage,
    interjectionTarget,
    queueInterjection,
    queuedMessageAction,
    withIdleProjectTasks,
    cancelTask,
    taskLifecycle,
    cancellations,
    pendingHumanAnswers,
    resumeHumanAnswers,
    runMainGuardianCycle,
    startMainGuardian,
    stopMainGuardian,
    async stop() {
      stopping = true;
      // Stop taking decisions first: a guardian that is already launching is
      // drained with the other task operations before its process is reaped.
      await stopMainGuardian();
      // A startup may be between durable writes and spawn. Drain accepted task
      // operations before dropping observers so they can settle without a child.
      await Promise.allSettled([...taskOperations.values()]);
      // A resident Main is not a child of this backend: a restart or upgrade
      // must leave it running. Only the observers go away; the next backend
      // adopts the processes from their durable records.
      for (const resident of residentMains.values()) {
        resident.host.close();
        activeRuns.delete(resident.taskId);
      }
      await Promise.all(finalizations);
    }
  };
}

export type RunService = ReturnType<typeof createDashboardRunService>;
