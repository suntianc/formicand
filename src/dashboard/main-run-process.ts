import { RuntimeOutputRecorder } from "../runtime/runtime-output.js";
import {
  readyMessageEditTransaction,
  finishMessageEditTransaction
} from "../runtime/main-message-edit-transaction.js";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import {
  saveAcceptedMainMessage,
  prepareMessageEdit,
  readMessageVersions,
  alignMessageVersionSession,
  MainMessageEditConflict
} from "../runtime/main-message-edit.js";
import { readQueuedUserTurn } from "../runtime/queued-user-turn.js";
import { mainInputPath, readMainInput, saveMainInput } from "../runtime/main-continuation.js";
import { appendFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mainRunEnv } from "./main-run-env.js";
import { MainRequestConflictError, mainRequestEnvironment } from "../runtime/main-request-retry.js";
import {
  MainRequestStore,
  MainRequestSnapshotError,
  mainRequestPath
} from "../storage/main-request-store.js";
import { assertMainRequestExecutionScope } from "../runtime/main-request-execution-scope.js";
import { HumanRequestStore } from "../runtime/human.js";
import { AgentProcessHost, type AgentProcessRecord } from "../runtime/agent-process.js";
import { InboxStore } from "../runtime/scheduler.js";
import { MainRunOutput } from "./main-run-outcome.js";
import { normalizeReasoningEffort } from "../runtime/runtime-settings.js";
import { modelRoleSnapshot, type ModelRoleRequest, type ResolvedModelRole } from "../runtime/role-models.js";
import { now } from "../domain/types.js";
import type { TaskLocation } from "./workspace-directory.js";
import {
  type RunServicePorts,
  type MainLaunchReceipt,
  type MainLaunchSubmission,
  type MainLaunchAdmission,
  type MainLaunchOptions,
  type InterjectionTarget,
  type SerializeTask
} from "./run-service-contracts.js";
import { hasQueuedTurn, type ResidentMain } from "./resident-main.js";
import type { createResidentMainSettlement } from "./resident-main-settlement.js";

export function createMainRunProcess({
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
}: {
  resolveMainModel: RunServicePorts["resolveMainModel"];
  normalizeModel: RunServicePorts["normalizeModel"];
  isStopping: () => boolean;
  appendRunEvent: RunServicePorts["appendRunEvent"];
  pendingTurns: Map<string, number>;
  runCredential: RunServicePorts["runCredential"];
  dashboardUrl: RunServicePorts["dashboardUrl"];
  projectRoot: RunServicePorts["projectRoot"];
  residentMains: Map<string, ResidentMain>;
  serialize: SerializeTask;
  settleResidentTurn: ReturnType<typeof createResidentMainSettlement>["settleResidentTurn"];
  activeRuns: Map<string, ChildProcess>;
  handleResidentExit: ReturnType<typeof createResidentMainSettlement>["handleResidentExit"];
  finalizeSessionRun: ReturnType<typeof createResidentMainSettlement>["finalizeSessionRun"];
  mainCapacity: RunServicePorts["mainCapacity"];
  activeRunIds: Map<string, string>;
  interjectionTargets: Map<string, InterjectionTarget>;
  onRunExit: NonNullable<RunServicePorts["onRunExit"]>;
}) {
  async function prepareMainRun(
    { task, workspaceRoot: taskWorkspace }: TaskLocation,
    { prompt, requestedRunId, resume, requestedModel, retryRequestId, submission }: MainLaunchOptions
  ) {
    const { taskId } = task;
    // Completing a request ends a run, not the conversation's Pi session.
    const continueSession = resume || Boolean(task.activeRunId);
    const continuation = resume && !prompt.trim();
    const requestStore = new MainRequestStore(mainRequestPath(taskWorkspace, taskId), taskId);
    // The connection a retry must still belong to. Resolving it here also refuses
    // an explicit profile id before this request is admitted.
    const roleRequestBase = {
      ...(submission?.profileId ? { profileId: submission.profileId } : {}),
      // The project's own Main settings win over the host's.
      ...(task.projectDirectory ? { projectDirectory: task.projectDirectory } : {})
    };
    const retryRequest = continuation
      ? await requestStore.inspectPending(async (snapshot) => {
          if (
            retryRequestId &&
            (["completed", "cancelled"].includes(task.status) || snapshot?.requestId !== retryRequestId)
          )
            throw new MainRequestSnapshotError(
              "要重试的原请求已变化或已取消，已有内容仍保留。请刷新后重试。"
            );
          if (!snapshot) return undefined;
          if (snapshot.runId !== task.activeRunId)
            throw new MainRequestSnapshotError("原请求所属运行已变化，已有内容仍保留。请刷新后重试。");
          if (
            (await realpath(resolve(task.projectDirectory ?? taskWorkspace))) !==
            snapshot.environment.projectDirectory
          )
            throw new MainRequestConflictError(
              "原请求的项目目录已变化，已有内容仍保留。请恢复原目录后重试，或发送新消息。"
            );
          const current = await mainRequestEnvironment(
            taskWorkspace,
            taskId,
            snapshot.environment.projectDirectory
          );
          try {
            assertMainRequestExecutionScope(snapshot.executionScope, current.executionScope);
          } catch (error) {
            throw new MainRequestConflictError(error instanceof Error ? error.message : String(error));
          }
          const endpoint = (value: string) => value.replace(/\/+$/, "").replace(/\/v1$/, "");
          const configuredBase = resolveMainModel(roleRequestBase).baseUrl;
          if (endpoint(configuredBase) !== endpoint(snapshot.model.baseUrl))
            throw new MainRequestConflictError(
              "原请求的模型连接已变化，已有内容仍保留。请恢复原连接后重试，或发送新消息。"
            );
          return snapshot;
        })
      : undefined;
    const runId =
      requestedRunId?.trim() ||
      (retryRequestId ? retryRequest?.runId : undefined) ||
      ((task.status === "running" || task.status === "waiting" || task.status === "paused") &&
      task.activeRunId
        ? task.activeRunId
        : `main-${Date.now()}`);
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(runId)) throw new Error("unsafe run id");
    // What this request asks the role resolver for. The shape carries only the
    // user's explicit choices (profile, model, thinking level, retry snapshot);
    // a queued demand keeps this shape, never a resolved default.
    const roleRequest: ModelRoleRequest = {
      ...roleRequestBase,
      ...(retryRequest
        ? { retryModel: retryRequest.model.id }
        : requestedModel
          ? { model: normalizeModel(requestedModel) }
          : { taskModel: task.model }),
      ...(submission?.thinkingLevel
        ? { thinkingLevel: normalizeReasoningEffort(submission.thinkingLevel, "thinkingLevel") }
        : {})
    };
    // Refuse an unusable host configuration before a demand may wait for a slot.
    // This resolution is a readiness check and is not stored anywhere.
    const configuredSelection = resolveMainModel(roleRequest);
    if (!configuredSelection.baseUrl || !configuredSelection.apiKey)
      throw new Error("模型 API 未配置：请填写 config.json 或 .cowork/config.json");
    if (prompt.includes("\0")) throw new Error("消息包含不支持的二进制字符，请移除附件后重试");
    if (Buffer.byteLength(prompt, "utf8") > 512 * 1024) throw new Error("消息及附件合计不能超过 512 KB");
    if (!prompt.trim() && !continuation) throw new Error("prompt must not be empty");
    if (continuation && !task.activeRunId) throw new Error("没有可继续的请求，请先发送消息。");
    // Shutdown may begin while task/configuration validation is awaiting I/O.
    if (isStopping()) throw new Error("Runtime is shutting down");
    if (
      (task.status === "running" || task.status === "waiting" || task.status === "paused") &&
      task.activeRunId &&
      task.activeRunId !== runId &&
      !submission?.edit
    )
      throw new Error("Task already has a running Main session");
    if (submission?.edit && task.activeRunId !== submission.edit.runId)
      throw new MainMessageEditConflict("原运行已变化，编辑内容仍保留，请刷新后重试。");
    const messageId = readQueuedUserTurn(prompt)?.messageId ?? randomUUID();
    const edit = submission?.edit
      ? await prepareMessageEdit(taskWorkspace, taskId, submission.edit, prompt, runId, messageId)
      : undefined;
    if (edit?.rollback) submission?.onPrepared?.(edit.rollback);
    // Preparing an edit retires only questions from the replaced message's tail.
    // Ordinary continuation and unrelated pending decisions retain the same gate.
    if ((await new HumanRequestStore(taskWorkspace).list(taskId, "pending")).length)
      throw new Error("请先回答任务中待确认的问题，再继续运行。");
    const savedVersions = await readMessageVersions(taskWorkspace, taskId);
    const versions = savedVersions
      ? await alignMessageVersionSession(
          taskWorkspace,
          taskId,
          task.projectDirectory ?? taskWorkspace,
          savedVersions
        )
      : undefined;
    return {
      runId,
      continuation,
      continueSession,
      requestStore,
      retryRequest,
      roleRequest,
      configuredModel: configuredSelection.model,
      messageId,
      edit,
      versionSessionFile: versions?.sessionFile
    };
  }

  type PreparedMainRun = Awaited<ReturnType<typeof prepareMainRun>>;

  async function acceptMainRun(
    location: TaskLocation,
    { prompt, submission }: MainLaunchOptions,
    { runId, continuation, continueSession, requestStore, retryRequest, messageId, edit }: PreparedMainRun,
    selection: ResolvedModelRole
  ) {
    const { task, workspaceRoot: taskWorkspace } = location;
    const { taskId } = task;
    const { model } = selection;
    // Every check that can refuse this request has passed and the Run id it will
    // launch is fixed. Ownership is recorded only now, so a refused request
    // cannot rewrite a Run another process owns.
    if (submission?.onRunAccepted) await submission.onRunAccepted(location, runId);
    const inputPath = mainInputPath(taskWorkspace, taskId, runId);
    // A promoted queued message carries the queue marker so this launch can
    // find its row; the accepted message is the person's own text.
    const queuedTurn = readQueuedUserTurn(prompt);
    const input = continuation
      ? await readMainInput(mainInputPath(taskWorkspace, taskId, task.activeRunId!))
      : {
          version: 1 as const,
          prompt: queuedTurn?.text ?? prompt,
          submittedAt: Date.now(),
          body: submission?.body,
          taskId,
          runId,
          attachmentIds: submission?.attachmentIds,
          textAttachments: submission?.textAttachments,
          ...(submission?.thinkingLevel
            ? { thinkingLevel: normalizeReasoningEffort(submission.thinkingLevel, "thinkingLevel") }
            : {}),
          messageId,
          source: submission?.source ?? (queuedTurn ? ("inbox" as const) : ("composer" as const))
        };
    if (!input)
      throw new MainRequestSnapshotError("这次继续缺少已保存的输入记录，无法恢复；会话与记录仍保留。");
    await saveMainInput(inputPath, input);
    if (!continuation) {
      await saveAcceptedMainMessage(taskWorkspace, taskId, input);
      submission?.onAcceptedInput?.(input.messageId!);
    }
    if (!continuation) await requestStore.clear();
    if (retryRequest) await requestStore.reassignRun(retryRequest, runId);
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      await location.store.transitionTask(taskId, "running", { runId, reason: "dashboard_run_restart" });
    }
    await location.store.updateTask(taskId, {
      goal: edit?.goalForTask ?? (task.goal || prompt.slice(0, 4_000)),
      model,
      activeRunId: runId,
      ...(task.pause ? { pause: undefined } : {})
    });
    await location.store.createRun(taskId, runId);
    await appendRunEvent(taskWorkspace, taskId, runId, "main.run_spawned", {
      model,
      modelSelection: modelRoleSnapshot(selection),
      prompt: prompt.slice(0, 4_000),
      resumed: continueSession,
      ...(continuation ? { continuation: true } : {})
    });
    if (isStopping()) {
      // This request claimed a Run before shutdown, but never acquired a process.
      // Settle it here: no child close event exists to persist its waiting state.
      await location.store.transitionTask(taskId, "waiting", {
        runId,
        reason: "desktop_shutdown_before_spawn"
      });
      await appendRunEvent(taskWorkspace, taskId, runId, "main.run_waiting", {
        reason: "desktop_shutdown_before_spawn"
      });
      throw new Error("Runtime is shutting down");
    }
    if (submission?.edit) await readyMessageEditTransaction(taskWorkspace, taskId);
    // The first turn of this Run arrives the way every later one does: through
    // the process's own durable Inbox. A continuation starts without new
    // input, so it is woken by the resume command instead.
    const inbox = new InboxStore(
      join(taskWorkspace, taskId, "runs", runId, "agents", "main", "inbox-store.json")
    );
    const createdAt = now();
    // A continuation and a message edit both already have their turn in the
    // session (restored from the accepted input); the process only needs to be
    // told to start it. A fresh message is itself the turn.
    // A replay must start its own turn: the callbacks that are waiting are
    // held until the archived request has been resent, so queued work cannot
    // be what starts it.
    const hasQueuedWork = await hasQueuedTurn(inbox);
    if ((continuation || submission?.edit) && (retryRequest || !hasQueuedWork)) {
      const resumeId = `main-resume-${randomUUID()}`;
      await inbox.enqueue({
        messageId: resumeId,
        recipientAgentId: "main",
        kind: "human_command",
        eventId: `main-resume-event-${resumeId}`,
        priority: 100,
        state: "ready",
        payload: { type: "main.resume" },
        createdAt
      });
    } else if (!continuation && !submission?.edit) {
      // A promoted queued message already owns a durable row. This launch is
      // its turn, so it opens that row instead of leaving a copy the process
      // could never read; the process reads the person's text, not the queue
      // marker that carried the identity this far.
      await inbox.startTurn({
        messageId,
        recipientAgentId: "main",
        kind: "human_command",
        eventId: `main-turn-${messageId}`,
        priority: 120,
        state: "ready",
        payload: {
          type: "human.message",
          message: queuedTurn?.text ?? prompt,
          delivery: "steer",
          initial: true
        },
        createdAt
      });
    }
    return { inputPath, input };
  }

  async function spawnResidentMain(
    location: TaskLocation,
    submission: MainLaunchSubmission | undefined,
    { runId, continuation, continueSession, retryRequest, roleRequest, versionSessionFile }: PreparedMainRun,
    { inputPath, input }: Awaited<ReturnType<typeof acceptMainRun>>,
    selection: ResolvedModelRole,
    admission: MainLaunchAdmission
  ): Promise<MainLaunchReceipt> {
    const { task, workspaceRoot: taskWorkspace } = location;
    const { taskId } = task;
    const { baseUrl, apiKey, model } = selection;
    // This Run has a message that opens its first turn; the process is started
    // below. The extension replaces this acceptance with its own record at the
    // first boundary.
    pendingTurns.set(taskId, Date.now());
    const launchEnv: NodeJS.ProcessEnv = {
      ...process.env,
      COWORK_API_TOKEN: runCredential,
      ...mainRunEnv({
        baseUrl,
        apiKey,
        model,
        taskWorkspace,
        projectDirectory: task.projectDirectory,
        taskId,
        runId,
        dashboardUrl,
        piAgentDir: process.env.PI_CODING_AGENT_DIR,
        projectRoot,
        selection,
        ...(input.thinkingLevel
          ? { thinkingLevel: normalizeReasoningEffort(input.thinkingLevel, "thinkingLevel") }
          : {})
      }),
      // A continuation restores the accepted input this Run inherits, and an
      // edit restores its rewritten input, into the selected session before
      // Pi starts. The resident process never reads stdin.
      COWORK_MAIN_CONTINUATION: continuation || submission?.edit ? inputPath : "",
      // Admission is this process's budget decision; the launcher must not
      // ask for a second slot for the same Run.
      ...(admission.requestId ? { COWORK_MAIN_CAPACITY_GRANTED: admission.requestId } : {}),
      COWORK_MAIN_RETRY_REQUEST_ID: retryRequest?.requestId ?? "",
      COWORK_MAIN_RETRY_MODEL: retryRequest ? JSON.stringify(retryRequest.model) : ""
    };
    const outputPath = join(taskWorkspace, taskId, "runs", runId, "runtime-output.log");
    const stderrPath = join(taskWorkspace, taskId, "runs", runId, "runtime-stderr.log");
    // The turn boundary is the Process's own event stream: a resident Main
    // starts and settles turns while the backend watches.
    const runtimeOutput = new RuntimeOutputRecorder(outputPath);
    const runOutput = new MainRunOutput((type) => {
      const current = residentMains.get(taskId);
      if (!current || current.runId !== runId) return;
      if (type === "agent_start") {
        current.turnActive = true;
        // The accepted turn is running: its first boundary is what will settle
        // it, so the acceptance no longer marks a place that must be kept.
        pendingTurns.delete(taskId);
      } else if (type === "agent_settled") {
        // A failed request ends this process; the Run stays "working" until
        // the exit settles it as failed, so a page cannot read it as idle.
        if (runOutput.message?.stopReason === "error") return;
        current.turnActive = false;
        // The process outlives its turn, so its Run and its place in the queue
        // are settled at this boundary rather than at the exit. The claim is
        // taken now; the settlement runs after any launch that is already in
        // flight, on the same queue that admits turns.
        void serialize(taskId, () => settleResidentTurn(current, current.requestId));
      }
    });
    // Concurrent appendFile calls can reorder chunks; diagnostics keep the
    // order they arrived in. The runtime log has its own recorder.
    let outputWrites = Promise.resolve();
    const persistOutput = (path: string, chunk: Buffer) => {
      outputWrites = outputWrites
        .then(() => appendFile(path, chunk))
        .catch((error) =>
          console.error(
            `[cowork] output persist failed: ${error instanceof Error ? error.message : String(error)}`
          )
        );
    };
    // Registered before the launch returns: a process that exits during the
    // launch's own awaits must still be settled, and its late events must not
    // re-register it.
    const entry: ResidentMain = {
      taskId,
      runId,
      location,
      host: undefined as unknown as AgentProcessHost,
      record: undefined as unknown as AgentProcessRecord,
      output: runOutput,
      runtimeOutput,
      // The turn this launch enqueued has been accepted; it clears when Pi
      // reports the Run settled.
      turnActive: true,
      observed: true,
      replacing: false,
      settled: false,
      ...(admission.requestId ? { requestId: admission.requestId } : {}),
      ...(roleRequest.profileId ? { pinnedConnection: selection.connectionId ?? roleRequest.profileId } : {})
    };
    const host = new AgentProcessHost({
      workspaceRoot: taskWorkspace,
      harnessRoot: projectRoot,
      env: launchEnv,
      onSpawn: (spawned, child) => {
        if (entry.settled) return;
        entry.record = spawned;
        activeRuns.set(taskId, child);
      },
      onExit: (record) => handleResidentExit(taskId, record.runId, record)
    });
    entry.host = host;
    residentMains.set(taskId, entry);
    let record: AgentProcessRecord;
    try {
      record = await host.launch({
        taskId,
        runId,
        callId: runId,
        agentId: "main",
        role: "main",
        workingDirectory: projectRoot,
        projectDirectory: task.projectDirectory ?? taskWorkspace,
        // One Pi session for the life of the resident process; a message edit
        // resumes exactly the version it rewrote.
        sessionDirectory: join(taskWorkspace, taskId, "sessions", "main", "pi"),
        resultPath: join(taskWorkspace, taskId, "runs", runId, "agents", "main", "process-result.json"),
        env: { COWORK_API_TOKEN: runCredential },
        mode: "resident",
        ...(versionSessionFile
          ? { sessionArgs: ["--session", versionSessionFile] }
          : continueSession
            ? { sessionArgs: ["--continue"] }
            : { sessionArgs: ["--session-id", runId] }),
        onStdout: (chunk) => {
          runOutput.write(chunk);
          runtimeOutput.write(chunk);
        },
        // A diagnostic can arrive between stdout fragments of one JSON event.
        // Preserve its original bytes without corrupting the model event stream.
        onStderr: (chunk) => persistOutput(stderrPath, chunk)
      });
    } catch (error) {
      // A process that never started owns no Run state to settle later, so the
      // failure is recorded here, once, with the cause the OS reported.
      const message = error instanceof Error ? error.message : String(error);
      runOutput.finish();
      await runtimeOutput.finish();
      await appendRunEvent(taskWorkspace, taskId, runId, "main.run_failed", {
        error: message,
        code: null,
        signal: null,
        failure: { kind: "main_process", spawn: true }
      });
      try {
        const failed = await location.store.transitionTask(taskId, "failed", {
          runId,
          error: message,
          reason: "dashboard_main_exit"
        });
        await finalizeSessionRun({ ...location, task: failed }, runId, "failed");
      } catch (error) {
        console.error(
          `[cowork] settling startup failure for ${taskId} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (admission.requestId && mainCapacity)
        // eslint-disable-next-line no-restricted-syntax -- 启动失败已记录，释放名额失败不能替换这个错误
        await mainCapacity.release(admission.requestId).catch(() => {});
      activeRunIds.delete(taskId);
      interjectionTargets.delete(taskId);
      pendingTurns.delete(taskId);
      // This launch registered the resident entry before spawning; a process
      // that never existed must not leave an entry claiming the Task's Main.
      if (residentMains.get(taskId)?.runId === runId) residentMains.delete(taskId);
      onRunExit(taskId);
      if (submission?.edit) await finishMessageEditTransaction(taskWorkspace, taskId);
      return {
        taskId,
        runId,
        status: "failed",
        model,
        error: message
      };
    }
    admission.spawned = true;
    if (admission.requestId && mainCapacity)
      await mainCapacity
        .bindProcess(admission.requestId, record.pid)
        .catch((error) =>
          console.error(
            `[cowork] external capacity process record failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
    entry.record = record;
    activeRunIds.set(taskId, runId);
    interjectionTargets.set(taskId, { runId });
    if (submission?.edit) await finishMessageEditTransaction(taskWorkspace, taskId);
    return {
      taskId,
      runId,
      status: "running",
      model
    };
  }

  return { prepareMainRun, acceptMainRun, spawnResidentMain };
}
