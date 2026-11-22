import { createWebSearchSettings } from "./web-search-settings.js";
import { createSkillService } from "./skill-service.js";
import { createMcpService } from "./mcp-service.js";
import { createComposerService } from "./composer-service.js";
import { createAgentService } from "./agent-service.js";
import { createMemoryService } from "./memory-service.js";
import { agentLocations, resolveAgent } from "../runtime/agent-definitions.js";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { id, now } from "../domain/types.js";
import { coworkConfigPath, readCoworkConfig, readHostCoworkConfig } from "../runtime/config.js";
import { normalizeReasoningEffort } from "../runtime/runtime-settings.js";
import { availableModels as catalogModels, selectionLimits } from "../runtime/model-catalog.js";
import { modelLevels, type ModelLevels } from "../runtime/model-levels.js";
import { atriaDataPaths } from "../../scripts/data-home.cjs";
import { CoordinatorRuntime } from "../runtime/coordinator-runtime.js";
import { findSubagentCall } from "../runtime/progress.js";
import { JsonlEventStore } from "../storage/event-store.js";
import { InputStore } from "../workspace/input-store.js";

import { readJsonFile } from "./event-stream.js";
import { readHeartbeat } from "../runtime/main-heartbeat.js";
import { createModelSettings } from "./model-settings.js";
import { resolveModelRole } from "../runtime/role-models.js";
import { createDashboardHandler, type DashboardRoutePorts } from "./routes.js";
import { createDashboardRunService } from "./run-service.js";
import { LocalAccess } from "./local-access.js";
import { FileCommandRunner } from "./management-commands.js";
import { createCatalogEvents } from "./catalog-events.js";
import { createProjectCloneService } from "./project-clone-service.js";
import { EventLedger } from "./event-ledger.js";
import { createWorkspaceDirectory } from "./workspace-directory.js";
import { createMainSessionService } from "./main-session-service.js";
import { createMainCapacityService } from "./main-capacity-service.js";
import { hasUnfinishedSubagentWork } from "../runtime/subagent-work.js";
import { createMainRunLauncher } from "./main-run-launch.js";
import { MainCapacityStore, mainCapacityStatePath } from "../storage/main-capacity-store.js";
import { withFileLock } from "../storage/file-lock.js";
import { ProjectDataRuntime } from "../workspace/project-data-service.js";
import { createProjectDevelopmentService } from "./project-development-service.js";
import { createSubagentBackend } from "./subagent-backend.js";
import { attachmentGrants } from "../workspace/attachment-capabilities.js";
import { ComputerUse } from "../gui/computer-use.js";
import type { ComputerDriver } from "../gui/computer-use.js";
import { MacComputerDriver } from "../gui/macos-driver.js";
import { createMacComputerApproval } from "../gui/macos-approval.js";
import { ComputerApproval, type ComputerApprovalAuthentication } from "./computer-approval.js";

import { createTaskConversationService } from "./task-conversation-service.js";
import { createComputerHostRequest } from "./computer-host-service.js";
/** Assemble one local Dashboard; importing this module never opens a port or installs signals. */
export function createDashboardApplication(
  options: {
    projectRoot?: string;
    port?: number;
    computerDriver?: ComputerDriver;
    computerClock?: () => number;
    /** Local management credential used by the optional open development dashboard. */
    localAccessToken?: string;
    computerApprovalAuthenticate?: ComputerApprovalAuthentication;
    computerApprovalClock?: () => number;
    computerApprovalTtlMs?: number;
    /** Supplied by a host that persists identity; otherwise this process is the identity. */
    backendIdentity?: { backendId: string; startedAt: string };
  } = {}
) {
  const projectRoot = resolve(options.projectRoot ?? process.env.COWORK_HARNESS_ROOT ?? process.cwd());
  const port = options.port ?? Number(process.env.COWORK_UI_PORT ?? 3880);
  const backendIdentity = options.backendIdentity ?? { backendId: id("backend"), startedAt: now() };
  /**
   * Where this Dashboard answers.
   *
   * One constant, because the Agent's host-dependent tools reach this Dashboard
   * over HTTP and the browser reaches the same origin. Deriving it twice is how
   * they drift; assuming the default port breaks every instance that is not on
   * it, including every test.
   */
  const dashboardUrl = `http://127.0.0.1:${port}`;
  // The host-owned credential store is overlaid here, so child processes and routes share it.
  const runtimeConfig = readHostCoworkConfig(projectRoot);
  const data = atriaDataPaths(process.env, runtimeConfig, projectRoot);
  let workspaceRoot = data.workspaceRoot;
  const coordinator = new CoordinatorRuntime();
  const computerDriver = new MacComputerDriver();
  let folderPickerOpen = false;
  const globalIndexPath = data.globalIndex;
  /**
   * Local session authorization for this data root.
   *
   * It lives beside the backend identity so sessions survive a restart, and it
   * reads the host credential the serving process published. The credential is
   * read through a getter because a daemon sets it before assembling services.
   */
  const access = new LocalAccess(
    dirname(globalIndexPath),
    () => process.env.COWORK_API_TOKEN,
    () => options.localAccessToken ?? process.env.COWORK_API_TOKEN
  );
  const computerApproval = new ComputerApproval(
    options.computerApprovalAuthenticate ?? createMacComputerApproval(projectRoot),
    options.computerApprovalClock,
    options.computerApprovalTtlMs
  );
  /**
   * Durable receipts for idempotent change commands, beside the sessions and
   * the backend identity so a restart can answer a retry with the saved result.
   */
  const commands = new FileCommandRunner(join(dirname(globalIndexPath), "operations"));
  const workspaces = createWorkspaceDirectory(workspaceRoot, globalIndexPath, runtimeValue);
  /**
   * The shared project ledger's one authority.
   *
   * Opened from the resolved configuration and reported through `ready`: an
   * explicit PostgreSQL choice that cannot be reached refuses to start rather
   * than falling back to a local SQLite database.
   */
  const projectData = new ProjectDataRuntime({
    config: runtimeConfig.projectData,
    env: process.env,
    configPath: coworkConfigPath(projectRoot),
    dataRoot: dirname(globalIndexPath),
    backendId: backendIdentity.backendId
  });
  const mainSessions = createMainSessionService({
    runtime: projectData,
    backendId: backendIdentity.backendId,
    project: async (projectId) => {
      const project = await workspaces.projectForId(projectId);
      return project
        ? {
            projectId: project.projectId,
            projectName: project.projectName,
            projectDirectory: project.projectDirectory
          }
        : undefined;
    },
    projectTasks: workspaces.projectTasks,
    createProjectTask: workspaces.persistProjectTask,
    capacity: {
      settings: () => runtimeConfig.mainCapacity,
      sessionUsage: (projectId) =>
        mainCapacity
          .sessionUsage(projectId)
          .then((usage) =>
            usage ? { regular: usage.regular, continuation: usage.continuation } : undefined
          ),
      noteSession: (record) => mainCapacity.noteSession(record),
      withCreateLock: (action) => mainCapacity.withCreateLock(action)
    }
  });
  /**
   * External Main capacity for this backend.
   *
   * The quotas are public configuration; the slots and the queue are local
   * execution facts beside the backend identity, because a pid and a waiting
   * Run belong to this host alone.
   */
  const mainCapacity = createMainCapacityService({
    store: new MainCapacityStore(mainCapacityStatePath(dirname(globalIndexPath))),
    backendId: backendIdentity.backendId,
    settings: () => runtimeConfig.mainCapacity,
    persistSettings: async (next) => {
      const path = coworkConfigPath(projectRoot);
      await withFileLock(path, async () => {
        const previous = existsSync(path) ? readCoworkConfig(projectRoot, { COWORK_CONFIG: path }) : {};
        const persisted = { ...previous, mainCapacity: next };
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.tmp-${randomUUID()}`;
        await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, path);
      });
      runtimeConfig.mainCapacity = next;
    },
    projects: async () =>
      (await (await projectData.service()).projects()).map((project) => ({
        projectId: project.projectId,
        projectName: project.projectName
      })),
    sessions: async (projectId) => await (await projectData.service()).listMainSessions(projectId),
    ...(process.env.COWORK_MAIN_CAPACITY_RETRY_MS
      ? { retryBaseMs: Number(process.env.COWORK_MAIN_CAPACITY_RETRY_MS) }
      : {}),
    taskState: async (taskId) => {
      // eslint-disable-next-line no-restricted-syntax -- 容量查询的 taskId 可能刚被删除，定位失败按没有活动 Run 处理
      const location = await locateTask(taskId).catch(() => undefined);
      if (!location) return undefined;
      return {
        status: location.task.status,
        ...(location.task.activeRunId ? { activeRunId: location.task.activeRunId } : {})
      };
    },
    unfinishedWork: async (taskId, runId) => {
      // eslint-disable-next-line no-restricted-syntax -- 任务定位失败时没有可读的工作项，按没有未完成工作处理；名额清扫仍会看心跳与任务快照
      const location = await locateTask(taskId).catch(() => undefined);
      if (!location) return false;
      return hasUnfinishedSubagentWork({ workspaceRoot: location.workspaceRoot, taskId, runId });
    },
    heartbeat: async (taskId) => {
      // eslint-disable-next-line no-restricted-syntax -- 心跳只在任务仍可定位时读取，定位失败视为没有心跳
      const location = await locateTask(taskId).catch(() => undefined);
      if (!location) return undefined;
      const beat = await readHeartbeat(location.workspaceRoot, taskId);
      return beat
        ? {
            pid: beat.pid,
            host: beat.host,
            runId: beat.runId,
            updatedAt: beat.updatedAt,
            ...(beat.turnActive === undefined ? {} : { turnActive: beat.turnActive })
          }
        : undefined;
    }
  });
  /**
   * Requirement development records: the shared goal/baseline through the
   * ledger gateway, and an isolated `git worktree` under the data root.
   */
  const developments = createProjectDevelopmentService({
    runtime: projectData,
    backendId: backendIdentity.backendId,
    startedAt: backendIdentity.startedAt,
    developmentRoot: join(dirname(globalIndexPath), "development-workspaces"),
    // A published merge that the shared store has not accepted yet is kept on
    // this host until its ledger/board delivery is written.
    deliveryRoot: join(dirname(globalIndexPath), "delivery-sync"),
    // Test-only crash window: kill this process between the target update and
    // its record so recovery has to reconcile against real Git facts.
    ...(process.env.COWORK_MERGE_FAULT_INJECT
      ? { mergeFaultInject: process.env.COWORK_MERGE_FAULT_INJECT }
      : {}),
    // Review identity comes from this Task's own durable queue, never a body.
    call: async (taskId, callId) => {
      // eslint-disable-next-line no-restricted-syntax -- 评审引用的任务可能已被删除，定位失败按调用不存在返回 undefined
      const location = await workspaces.locateTask(taskId).catch(() => undefined);
      if (!location) return undefined;
      return findSubagentCall({ workspaceRoot: location.workspaceRoot, taskId, callId });
    },
    project: async (projectId) => {
      const project = await workspaces.projectForId(projectId);
      return project
        ? {
            projectId: project.projectId,
            projectName: project.projectName,
            projectDirectory: project.projectDirectory
          }
        : undefined;
    },
    taskProject: async (taskId) => {
      // eslint-disable-next-line no-restricted-syntax -- 项目归属查询对已删除的任务返回 undefined，调用方按无项目处理
      const location = await workspaces.locateTask(taskId).catch(() => undefined);
      if (!location?.projectId) return undefined;
      const project = await workspaces.projectForId(location.projectId);
      return project
        ? {
            projectId: project.projectId,
            projectName: project.projectName,
            projectDirectory: project.projectDirectory
          }
        : undefined;
    }
  });
  // Retry delivery facts this host published but could not record while the
  // shared service was unreachable. One bounded interval in this process only
  // looks at local pending facts, so no user read or restart is required.
  const deliverySyncTickMs = Number(process.env.COWORK_DELIVERY_SYNC_TICK_MS);
  developments.startDeliveryRecovery(
    Number.isFinite(deliverySyncTickMs) && deliverySyncTickMs > 0 ? deliverySyncTickMs : undefined
  );
  const { knownWorkspaceRoots, locateTask, taskListItem, globalTaskPayload } = workspaces;
  /**
   * The durable catalog event log, beside the sessions and receipts.
   *
   * A client reconciles against it after a disconnect: the snapshot and its
   * cursor come from the same serialized section, so a change made in the
   * handoff is replayed instead of lost, and a cursor older than the retained
   * log is refused so the client takes a fresh snapshot.
   */
  const catalogEvents = createCatalogEvents({
    ledger: EventLedger.open(join(dirname(globalIndexPath), "events"), backendIdentity.backendId, {
      ...(process.env.COWORK_EVENT_LEDGER_RECORDS
        ? { maxRecords: Number(process.env.COWORK_EVENT_LEDGER_RECORDS) }
        : {}),
      ...(process.env.COWORK_EVENT_FAULT_INJECT ? { faultInject: process.env.COWORK_EVENT_FAULT_INJECT } : {})
    }),
    readCatalog: globalTaskPayload,
    ...(process.env.COWORK_EVENT_RECONCILE_MS
      ? { reconcileMs: Number(process.env.COWORK_EVENT_RECONCILE_MS) }
      : {})
  });
  /**
   * Git clones for the add-project dialog. The record carries the operation
   * identity; a project exists only after git exits successfully.
   */
  const projectClones = createProjectCloneService({
    dataRoot: join(dirname(globalIndexPath), "project-clones"),
    createProject: async (input) => {
      const project = await workspaces.createProject({
        projectName: input.projectName,
        projectDirectory: input.projectDirectory
      });
      await catalogEvents.project(project);
      return project;
    },
    projectForDirectory: async (directory) => {
      const project = await workspaces.projectForRoot(directory);
      return project
        ? {
            projectId: project.projectId,
            projectName: project.projectName,
            projectDirectory: project.projectDirectory
          }
        : undefined;
    }
  });
  const computer = new ComputerUse(
    options.computerDriver ?? computerDriver,
    options.computerClock ?? Date.now,
    locateTask
  );
  const uploads = new InputStore(join(dirname(globalIndexPath), "uploads"));
  /**
   * Delegated execution for every workspace root this backend serves.
   *
   * Main requests work through its own Task; the backend registers the item in
   * that Run's durable queue, launches it, and settles it. It is one owner per
   * root, so a CLI worker does not take the same work item at the same time.
   */
  const subagents = createSubagentBackend({
    projectRoot,
    dashboardUrl,
    locateTask,
    workspaceRoots: knownWorkspaceRoots,
    config: () => runtimeConfig,
    resolveMainModel: (request) => resolveModelRole(runtimeConfig, request),
    development: async ({ taskId, developmentId }) => {
      const site = await developments.dispatchSiteForTask(taskId, developmentId);
      return { directory: site.directory };
    },
    frozenCandidate: async ({ taskId, developmentId, reviewId }) =>
      await developments.frozenCandidateForTask(taskId, developmentId, reviewId),
    ticket: async ({ taskId, developmentId, ticketId, continuation }) =>
      await developments.ticketForDispatch(taskId, developmentId, ticketId, continuation),
    ticketStarted: async ({ taskId, developmentId, ticketId, work }) =>
      await developments.ticketStarted(taskId, developmentId, ticketId, work),
    grants: async ({ taskId, attachments }) => {
      const location = await locateTask(taskId);
      return await attachmentGrants(join(location.workspaceRoot, taskId), attachments);
    },
    agent: async ({ taskId, name }) =>
      await resolveAgent(
        await agentLocations(data.home, (await locateTask(taskId)).task.projectDirectory),
        name
      ),
    configPath: () => coworkConfigPath(projectRoot),
    piAgentDir: () => data.piAgentDir,
    ...(process.env.COWORK_SUBAGENT_POLL_MS ? { pollMs: Number(process.env.COWORK_SUBAGENT_POLL_MS) } : {})
  });
  const runs = createDashboardRunService({
    onRunFinalized: async (location, runId, status) => {
      if (!location.projectId) return;
      // A Run keeps the session that owned it after it settles.
      await mainSessions.settle(location.projectId, location.task.taskId, runId, status);
    },
    onTaskCancelling: (taskId) => computer.stop(taskId, "ended"),
    uploads,
    projectRoot,
    dashboardUrl,
    runCredential: access.runCredential(),
    coordinator,
    subagents,
    locateTask,
    readWindowDevelopment: developments.contextHandoffForTask,
    mainSessions: {
      resolve: (location, input) => mainSessions.resolve(location, input)
    },
    mainCapacity,
    mainGuardian: {
      workspaceRoots: knownWorkspaceRoots,
      // A host with no Main connection has nothing to launch, and a connection
      // added later is seen on the next cycle.
      modelConfigured: () => Boolean(runtimeValue("COWORK_API_BASE") && runtimeValue("COWORK_API_KEY"))
    },
    withTaskProjectLock: workspaces.withTaskProjectLock,
    resolveMainModel: (request) => resolveModelRole(runtimeConfig, request),
    endpointLimits: (selection) => selectionLimits(selection, runtimeConfig),
    // The Run's work ended: release what it held, though its process lives on.
    onRunSettled: (taskId) => computer.finishTask(taskId),
    onRunExit: (taskId) => computer.finishTask(taskId),
    normalizeModel,
    appendRunEvent,
    readJsonFile
  });
  const { activeRuns, startMainRun, resumeHumanAnswers } = runs;
  /**
   * Whether any resident Main is producing an answer right now.
   *
   * The Run outlives its turn, so settings that the next turn reads may be
   * changed while the process rests; only a turn in flight holds them.
   */
  const anyTurnActive = async () => {
    for (const taskId of activeRuns.keys()) if (await runs.taskTurnActive(taskId)) return true;
    return false;
  };
  const launchMainRun = createMainRunLauncher({ locateTask, mainSessions, startMainRun });
  /**
   * Start the demand that just got a slot.
   *
   * Everything a queued request needs is in its durable entry, so a restart or
   * a completion starts exactly that demand through the same launcher the page
   * uses — no second scheduler and no second Run identity.
   */
  mainCapacity.attachStarter(async (entry) => {
    const result = await launchMainRun({
      taskId: entry.taskId,
      prompt: entry.prompt,
      runId: entry.runId,
      resume: entry.resume,
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.retryRequestId ? { retryRequestId: entry.retryRequestId } : {}),
      mainSessionId: entry.sessionId,
      ...(entry.requirementId ? { requirementId: entry.requirementId } : {}),
      ...(entry.submission?.body === undefined ? {} : { body: entry.submission.body }),
      ...(entry.submission?.profileId ? { profileId: entry.submission.profileId } : {}),
      ...(entry.submission?.thinkingLevel
        ? {
            thinkingLevel: normalizeReasoningEffort(entry.submission.thinkingLevel, "thinkingLevel")
          }
        : {}),
      ...(entry.submission?.attachmentIds ? { attachmentIds: entry.submission.attachmentIds } : {}),
      ...(entry.submission?.textAttachments ? { textAttachments: entry.submission.textAttachments } : {}),
      ...(entry.submission?.source ? { source: entry.submission.source } : {}),
      admittedRequestId: entry.requestId,
      queueWhenFull: false
    });
    if (result.status === "failed") throw new Error(result.error);
  });

  const uiRoot = process.env.COWORK_UI_DIR ?? join(projectRoot, "web");

  function runtimeValue(name: "COWORK_API_BASE" | "COWORK_API_KEY" | "COWORK_MODEL"): string | undefined {
    if (name === "COWORK_API_BASE")
      return process.env[name] || runtimeConfig.baseUrl || runtimeConfig.apiBase;
    if (name === "COWORK_API_KEY") return process.env[name] || runtimeConfig.apiKey;
    return process.env[name] || runtimeConfig.model || "glm-5.3";
  }

  function normalizeModel(value: unknown): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") throw new Error("model 必须是字符串");
    const model = value.trim();
    // Model ids are passed to a child process as one argv item. Keep the
    // accepted alphabet deliberately narrow so a UI request can never turn
    // into shell syntax or an oversized environment value.
    if (!model || model.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model))
      throw new Error("model id 不合法");
    return model;
  }

  /** The connection's models, each with the reasoning levels it accepts (#27). */
  async function availableModels(): Promise<Array<{ id: string } & ModelLevels>> {
    const baseUrl = runtimeValue("COWORK_API_BASE");
    const catalog = await catalogModels({
      ...runtimeConfig,
      model: runtimeValue("COWORK_MODEL") ?? "glm-5.3",
      baseUrl,
      apiKey: runtimeValue("COWORK_API_KEY")
    });
    return Promise.all(
      catalog.map(async (entry) => ({
        id: entry.id,
        ...(await modelLevels({
          baseUrl: baseUrl ?? "",
          model: entry.id,
          endpoint: entry.levels,
          manual: runtimeConfig.reasoningLevels
        }))
      }))
    );
  }

  async function appendRunEvent(
    taskWorkspace: string,
    taskId: string,
    runId: string,
    type: string,
    payload: unknown
  ): Promise<void> {
    const events = new JsonlEventStore(join(taskWorkspace, taskId, "runs", runId, "run_events.jsonl"));
    await events.append({
      eventId: id("event"),
      type,
      taskId,
      runId,
      agentId: "main",
      occurredAt: now(),
      payload
    });
  }

  async function resolveWorkspacePath(value: unknown): Promise<string> {
    if (typeof value !== "string" || !value.trim() || !isAbsolute(value))
      throw new Error("workspaceRoot 必须是本机绝对路径");
    const path = resolve(value);
    try {
      if (!(await stat(path)).isDirectory()) throw new Error("workspaceRoot 不是目录");
    } catch (error) {
      if (error instanceof Error && error.message === "workspaceRoot 不是目录") throw error;
      throw new Error("workspaceRoot 不存在或无法访问");
    }
    return path;
  }

  async function chooseLocalDirectory(): Promise<string | undefined> {
    if (folderPickerOpen) throw new Error("文件夹选择窗口已经打开");
    folderPickerOpen = true;
    try {
      const command =
        process.platform === "darwin"
          ? "/usr/bin/osascript"
          : process.platform === "win32"
            ? "powershell.exe"
            : "zenity";
      const args =
        process.platform === "darwin"
          ? [
              "-e",
              'try\nreturn POSIX path of (choose folder with prompt "选择 Cowork 工作空间")\non error number -128\nreturn ""\nend try'
            ]
          : process.platform === "win32"
            ? [
                "-NoProfile",
                "-STA",
                "-Command",
                'Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = "选择 Cowork 工作空间"; if ($picker.ShowDialog() -eq "OK") { Write-Output $picker.SelectedPath }; $picker.Dispose()'
              ]
            : ["--file-selection", "--directory", "--title=选择 Cowork 工作空间"];
      const selected = await new Promise<string>((resolveSelection, reject) => {
        const picker = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        picker.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        picker.once("error", () => reject(new Error("无法打开系统文件夹选择器，请使用桌面版")));
        picker.once("close", (code) => {
          if (code === 0 || (process.platform === "linux" && code === 1)) resolveSelection(output.trim());
          else reject(new Error("文件夹选择窗口未能正常打开，请重试"));
        });
      });
      return selected ? await resolveWorkspacePath(selected) : undefined;
    } finally {
      folderPickerOpen = false;
    }
  }

  async function switchWorkspace(nextRoot: string): Promise<void> {
    if (activeRuns.size > 0) throw new Error("请先等待运行中的任务结束，再切换工作空间");
    computer.close();
    workspaceRoot = await resolveWorkspacePath(nextRoot);
    await workspaces.switchRoot(workspaceRoot);
  }

  const computerHostRequest = createComputerHostRequest(
    computer,
    () => options.computerDriver ?? computerDriver
  );
  const modelSettings = createModelSettings(projectRoot, runtimeConfig);
  const { taskDetails, forkConversation, messageVersion } = createTaskConversationService({
    workspaces,
    coordinator,
    runs,
    runtimeConfig,
    runtimeValue: () => runtimeValue("COWORK_MODEL"),
    modelSettings
  });
  const routes: DashboardRoutePorts = {
    projectData,
    mainSessions,
    developments,
    projectClones,
    mcp: createMcpService({
      home: data.home,
      userHome: homedir(),
      piAgentDir: data.piAgentDir,
      harnessRoot: projectRoot
    }),
    agents: createAgentService({
      harnessRoot: projectRoot,
      home: data.home,
      userHome: homedir(),
      projectForId: workspaces.projectForId,
      builtins: { config: modelSettings.config, save: modelSettings.saveRole }
    }),
    memories: createMemoryService({
      home: data.home,
      projectForId: workspaces.projectForId,
      taskProjectId: async (taskId) => (await workspaces.locateTask(taskId)).projectId
    }),
    composer: createComposerService({
      harnessRoot: projectRoot,
      home: data.home,
      userHome: homedir(),
      projectForId: workspaces.projectForId
    }),
    skills: createSkillService({
      harnessRoot: projectRoot,
      home: data.home,
      userHome: homedir(),
      projectForId: workspaces.projectForId
    }),
    mainCapacity,
    launchMainRun,
    access,
    commands,
    events: catalogEvents,
    backendInfo: () => ({
      backendId: backendIdentity.backendId,
      pid: process.pid,
      startedAt: backendIdentity.startedAt
    }),
    uploads,
    computer,
    computerHostRequest,
    computerApproval,
    dashboardUrl,
    uiRoot,
    // A resident Main keeps its Run between turns, so "a Run exists" is not "a
    // turn is running": both settings services may only refuse while a turn is
    // actually producing an answer, and the next turn reads what was saved.
    webSearchSettings: createWebSearchSettings(projectRoot, runtimeConfig, anyTurnActive),
    modelSettings,
    globalTaskPayload,
    locateTask,
    projectForRoot: workspaces.projectForRoot,
    projectForId: workspaces.projectForId,
    workspaceRoot: () => workspaceRoot,
    availableModels,
    chooseLocalDirectory,
    resolveWorkspacePath,
    registerWorkspace: workspaces.register,
    switchWorkspace,
    createProject: workspaces.createProject,
    updateProject: (projectId, input) =>
      workspaces.updateProject(projectId, input, runs.withIdleProjectTasks),
    removeProject: (projectId) =>
      workspaces.removeProject(projectId, (taskIds, action) =>
        runs.withIdleProjectTasks(taskIds, action, "移除项目")
      ),
    createProjectTask: workspaces.createProjectTask,
    createTemporaryTask: workspaces.createTemporaryTask,
    createTemporaryWorkspace: workspaces.createTemporaryWorkspace,
    normalizeModel,
    runtimeValue,
    startMainRun,
    pauseTask: runs.pauseTask,
    compactMainContext: runs.compactMainContext,
    stopTask: runs.stopTask,
    editMainMessage: runs.editMainMessage,
    forkConversation,
    messageVersion,
    mainTurnActive: runs.taskTurnActive,
    cancelTask: runs.cancelTask,
    taskLifecycle: runs.taskLifecycle,
    queuedMessageAction: runs.queuedMessageAction,
    queueInterjection: runs.queueInterjection,
    interjectionTarget: runs.interjectionTarget,
    resumeHumanAnswers,
    subagents,
    taskDetails,
    taskListItem,
    appendRunEvent
  };
  const server = createServer(createDashboardHandler(routes));
  server.once("listening", () => void mainCapacity.start());
  // Take over the Mains a previous backend left running before any management
  // call can be asked about them: close, pause, interrupt and insertion all
  // read the adopted state, not the next message.
  server.once("listening", () => void runs.adoptExistingMains());
  // Delegated processes a previous backend launched outlive it; take them over
  // before any request can ask about their work item.
  server.once("listening", () => void subagents.start());
  server.once("listening", () => runs.startMainGuardian());

  return {
    server,
    runs,
    dashboardUrl,
    routePorts: routes,
    computerHostRequest,
    /** Resolves when the project data service is migrated and reachable. */
    ready: projectData.ready,
    async stop() {
      await subagents.stop();
      await developments.stopDeliveryRecovery();
      await computerApproval.close();
      await catalogEvents.close();
      computer.close();
      // A recovery cycle must not start a Main into a service that is going
      // away, and it must finish before capacity stops admitting.
      await runs.stopMainGuardian();
      server.closeAllConnections();
      await projectClones.stop();
      // Stop admitting before the processes exit, so no shutdown release
      // starts the next demand while the service is going away.
      await mainCapacity.stop();
      await runs.stop();
      await new Promise<void>((done) => server.close(() => done()));
      // After the listener is closed, so no in-flight ledger request loses its database.
      await projectData.close();
    }
  };
}
