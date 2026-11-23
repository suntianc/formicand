import { MainMessageEditConflict } from "../runtime/main-message-edit.js";
import { readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { ModelLevels } from "../runtime/model-levels.js";
import {
  applyTrustedClientCors,
  dashboardContentPolicy,
  HttpError,
  localRequestUrl,
  readJsonBody,
  sendJson,
  trustedClientOrigin,
  trustedClientOrigins
} from "./http.js";
import { protocolInfo } from "./backend-protocol.js";
import type { CatalogEvents } from "./catalog-events.js";
import { HOST_PRINCIPAL, type LocalAccess, type LocalPrincipal } from "./local-access.js";
import { handleSessionRequest } from "./session-routes.js";
import { type CommandRunner } from "./management-commands.js";
import { ProjectCatalogError } from "../workspace/project-catalog.js";
import { ProjectDataConflictError, ProjectDataError } from "../domain/project-ledger.js";
import { handleProjectDataRequest } from "./project-data-routes.js";
import type { ProjectDataRuntime } from "../workspace/project-data-service.js";
import type { MainRunLauncher } from "./main-run-launch.js";
import type { MainCapacityService } from "./main-capacity-service.js";
import { handleMainCapacityRequest } from "./main-capacity-routes.js";
import { handleMainSessionRequest } from "./main-session-routes.js";
import { handleDevelopmentRequest } from "./project-development-routes.js";
import type { ProjectDevelopmentService } from "./project-development-service.js";
import type { createMainSessionService } from "./main-session-service.js";
import { MainRequestConflictError } from "../runtime/main-request-retry.js";
import { MainRequestSnapshotError } from "../storage/main-request-store.js";
import { InputStore } from "../workspace/input-store.js";
import { handleUploadRequest } from "./upload-routes.js";
import { handleComputerRequest } from "./computer-routes.js";
import type { ComputerUse } from "../gui/computer-use.js";
import type { ComputerApproval } from "./computer-approval.js";

import type { createWebSearchSettings } from "./web-search-settings.js";
import type { createModelSettings } from "./model-settings.js";
import type { createDashboardRunService, RunServicePorts } from "./run-service.js";
import { ProjectCloneError, type ProjectCloneService } from "./project-clone-service.js";
import { handleSkillRequest } from "./skill-routes.js";
import type { SkillService } from "./skill-service.js";
import { handleMcpRequest } from "./mcp-routes.js";
import type { McpService } from "./mcp-service.js";
import { handleComposerRequest } from "./composer-routes.js";
import type { ProjectFileIndex } from "../workspace/project-file-index.js";
import { handleAgentRequest } from "./agent-routes.js";
import { handleMemoryRequest } from "./memory-routes.js";
import type { MemoryService } from "./memory-service.js";
import type { AgentService } from "./agent-service.js";
import type { ComposerService } from "./composer-service.js";
import { handleProjectCloneRequest } from "./project-clone-routes.js";
import { handleSubagentRequest } from "./subagent-routes.js";
import type { SubagentBackend } from "./subagent-backend.js";
import type { createWorkspaceDirectory } from "./workspace-directory.js";

type WorkspaceDirectory = ReturnType<typeof createWorkspaceDirectory>;
type RunService = ReturnType<typeof createDashboardRunService>;

import { handleProjectCatalogRequest } from "./project-catalog-routes.js";
import { handleModelSettingsRequest } from "./model-settings-routes.js";
import { handleTaskConversationRequest } from "./task-conversation-routes.js";
import { handleTaskLifecycleRequest } from "./task-lifecycle-routes.js";
import { handleTaskFileRequest } from "./task-file-routes.js";

export interface DashboardRoutePorts {
  backendInfo(): { backendId: string; pid: number; startedAt: string };
  /** Local session authorization; absent only in partial handlers that serve one router. */
  access?: LocalAccess;
  /** Durable receipts for idempotent change commands; absent in partial handlers. */
  commands?: CommandRunner;
  /** Snapshot and resumable catalog events; absent in partial handlers. */
  events?: CatalogEvents;
  /** Shared project ledger; absent only in partial handlers that serve one router. */
  projectData?: ProjectDataRuntime;
  /** Persistent project Main sessions; absent only in partial handlers that serve one router. */
  mainSessions?: ReturnType<typeof createMainSessionService>;
  /** Requirement development records and their isolated Git checkouts. */
  developments?: ProjectDevelopmentService;
  /** Delegated work items and the processes that run them. */
  subagents?: SubagentBackend;
  /** Git clones behind the add-project dialog; absent in partial handlers. */
  projectClones?: ProjectCloneService;
  /** Skill settings; absent in partial handlers. */
  skills?: SkillService;
  mcp?: McpService;
  composer?: ComposerService;
  /** The listing of project files behind `@` and file-reference lookup. */
  projectFiles: ProjectFileIndex;
  agents?: AgentService;
  /** Main's memory and Settings → Memory; absent in partial handlers. */
  memories?: MemoryService;
  mainCapacity?: MainCapacityService;
  uploads?: InputStore;
  computer: ComputerUse;
  computerHostRequest?: (input: unknown) => Promise<unknown>;
  computerApproval?: ComputerApproval;
  dashboardUrl: string;
  uiRoot: string;
  webSearchSettings: ReturnType<typeof createWebSearchSettings>;
  modelSettings: ReturnType<typeof createModelSettings>;
  workspaceRoot(): string;
  globalTaskPayload: WorkspaceDirectory["globalTaskPayload"];
  locateTask: WorkspaceDirectory["locateTask"];
  taskListItem: WorkspaceDirectory["taskListItem"];
  projectForRoot: WorkspaceDirectory["projectForRoot"];
  projectForId: WorkspaceDirectory["projectForId"];
  availableModels(): Promise<Array<{ id: string } & ModelLevels>>;
  chooseLocalDirectory(): Promise<string | undefined>;
  resolveWorkspacePath(value: unknown): Promise<string>;
  registerWorkspace(root: string): Promise<void>;
  switchWorkspace(root: string): Promise<void>;
  createProject: WorkspaceDirectory["createProject"];
  updateProject(
    projectId: string,
    input: { projectName?: unknown; projectDirectory?: unknown }
  ): Promise<unknown>;
  removeProject(projectId: string): Promise<{ projectId: string; removedAt: string; taskIds: string[] }>;
  createProjectTask: WorkspaceDirectory["createProjectTask"];
  createTemporaryTask: WorkspaceDirectory["createTemporaryTask"];
  createTemporaryWorkspace: WorkspaceDirectory["createTemporaryWorkspace"];
  normalizeModel(value: unknown): string | undefined;
  runtimeValue(name: "COWORK_API_BASE" | "COWORK_API_KEY" | "COWORK_MODEL"): string | undefined;
  startMainRun: RunService["startMainRun"];
  pauseTask: RunService["pauseTask"];
  compactMainContext: RunService["compactMainContext"];
  stopTask: RunService["stopTask"];
  launchMainRun: MainRunLauncher;
  editMainMessage: RunService["editMainMessage"];
  forkConversation(
    sourceTaskId: string,
    input: { taskId: string; messageId: string; title?: string }
  ): Promise<{ taskId: string }>;
  messageVersion(taskId: string, versionId: string): Promise<unknown>;
  /** Whether a Main turn is running right now, resident process or not. */
  mainTurnActive: RunService["taskTurnActive"];
  cancelTask: RunService["cancelTask"];
  taskLifecycle: RunService["taskLifecycle"];
  queuedMessageAction: RunService["queuedMessageAction"];
  queueInterjection: RunService["queueInterjection"];
  interjectionTarget: RunService["interjectionTarget"];
  resumeHumanAnswers: RunService["resumeHumanAnswers"];
  taskDetails(taskId: string): Promise<unknown>;
  appendRunEvent: RunServicePorts["appendRunEvent"];
}

/** HTTP validation and response mapping; all durable work is delegated to services. */
export function createDashboardHandler(
  ports: DashboardRoutePorts
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const { dashboardUrl, uiRoot, globalTaskPayload, locateTask, chooseLocalDirectory, resolveWorkspacePath } =
    ports;
  return async (request, response) => {
    try {
      if (request.url === "/api/host/computer" || request.url === "/api/host/computer/approve") {
        if (request.method !== "POST") throw new HttpError(405, "method not allowed");
        if (
          request.headers.origin !== undefined ||
          request.headers["sec-fetch-site"] !== undefined ||
          request.headers.cookie !== undefined ||
          typeof request.headers["x-atria-token"] !== "string" ||
          !request.headers["x-atria-token"] ||
          !ports.access
        )
          throw new HttpError(403, "需要本地连接凭据", "host_credential_required");
        const { principal } = ports.access.admit(request, dashboardUrl);
        if (!ports.computerHostRequest || !ports.computerApproval) throw new HttpError(404, "窗口访问不可用");
        const body = await readJsonBody(request, 16 * 1024);
        const identity = ports.backendInfo();
        if (
          body.backendId !== identity.backendId ||
          body.pid !== identity.pid ||
          body.startedAt !== identity.startedAt
        )
          throw new HttpError(409, "后端身份已改变，请重新连接", "backend_identity_changed");
        if (request.url === "/api/host/computer/approve") {
          if (principal.kind !== "host")
            throw new HttpError(403, "只有执行主机可以请求本机确认", "host_credential_required");
          if (Object.keys(body).some((key) => !["backendId", "pid", "startedAt"].includes(key)))
            throw new HttpError(400, "无效的本机身份验证请求");
          const controller = new AbortController();
          let issued: string | undefined;
          const disconnected = () => {
            if (!response.writableFinished) {
              controller.abort();
              if (issued) ports.computerApproval?.revokeIfCurrent(issued);
            }
          };
          const finished = () => response.off("close", disconnected);
          response.once("close", disconnected);
          response.once("finish", finished);
          try {
            const approval = await ports.computerApproval.approve(identity, controller.signal);
            if (controller.signal.aborted) {
              ports.computerApproval.revokeIfCurrent(approval.token);
              return;
            }
            issued = approval.token;
            response.setHeader("cache-control", "no-store");
            sendJson(response, 200, { ...identity, approval });
          } catch (error) {
            response.off("close", disconnected);
            response.off("finish", finished);
            throw error;
          }
          return;
        }
        const input = body.input as { operation?: unknown; enabled?: unknown } | undefined;
        const safe =
          input?.operation === "status" ||
          input?.operation === "access" ||
          input?.operation === "permissions" ||
          input?.operation === "pause" ||
          input?.operation === "end" ||
          input?.operation === "release-sessions" ||
          (input?.operation === "policy" && input.enabled === false);
        if (
          principal.kind !== "host" &&
          (input?.operation === "permissions" || (!safe && input?.operation !== "revoke-approval"))
        )
          throw new HttpError(403, "请在执行主机处理窗口访问权限", "host_credential_required");
        if (
          !safe &&
          !ports.computerApproval.valid(request.headers["x-computer-approval"] as string | undefined)
        )
          throw new HttpError(403, "请先完成本机身份验证", "host_approval_required");
        if (input?.operation === "revoke-approval") {
          if (Object.keys(input).length !== 1) throw new HttpError(400, "无效的本机身份验证请求");
          ports.computerApproval.revoke();
          sendJson(response, 200, { ...identity, result: null });
          return;
        }
        if (
          input?.operation === "pause" ||
          input?.operation === "end" ||
          input?.operation === "release-sessions"
        )
          ports.computerApproval.cancelPending();
        if (input?.operation === "policy" && input.enabled === false) ports.computerApproval.revoke();
        const result = await ports.computerHostRequest(body.input);
        sendJson(response, 200, { ...identity, result });
        return;
      }
      const admitted = ports.access?.admit(request, dashboardUrl);
      const url = admitted ? admitted.url : localRequestUrl(request, dashboardUrl);
      // A page served by another trusted local backend reads this response
      // through CORS. Same-origin requests get no extra headers.
      const trustedOrigin = trustedClientOrigin(request);
      if (trustedOrigin) applyTrustedClientCors(response, trustedOrigin);
      if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
        response.writeHead(204);
        response.end();
        return;
      }
      const principal: LocalPrincipal = admitted?.principal ?? HOST_PRINCIPAL;
      // Identity read-only: a host uses it to confirm that the process it
      // recorded is the one answering here, never to learn configuration.
      if (request.method === "GET" && url.pathname === "/api/backend") {
        sendJson(response, 200, { ...ports.backendInfo(), protocol: protocolInfo() });
        return;
      }
      if (
        ports.access &&
        (await handleSessionRequest(request, response, url, ports.access, ports.backendInfo, principal))
      )
        return;
      // A command receipt is how a client reconciles after a lost response: ask
      // whether its command landed, then retry with the same operation id.
      const operationMatch = url.pathname.match(/^\/api\/operations\/([^/]+)$/);
      if (request.method === "GET" && operationMatch && ports.commands) {
        const receipt = await ports.commands.read(
          principal.principalId,
          decodeURIComponent(operationMatch[1])
        );
        if (!receipt)
          throw new HttpError(404, "找不到该 operationId 的结果；命令可能尚未执行", "operation_unknown");
        sendJson(response, 200, receipt);
        return;
      }
      // The snapshot names the cursor it was taken at; the subscription replays
      // from that cursor, so a change made between the two is never lost.
      if (ports.events && request.method === "GET" && url.pathname === "/api/events/snapshot") {
        sendJson(response, 200, await ports.events.snapshot());
        return;
      }
      if (ports.events && request.method === "GET" && url.pathname === "/api/events/stream") {
        const raw = url.searchParams.get("cursor");
        const after = raw === null || raw === "" ? Number.NaN : Number(raw);
        if (!Number.isInteger(after) || after < 0)
          throw new HttpError(
            400,
            "事件订阅需要快照给出的 cursor（非负整数）；先取 GET /api/events/snapshot",
            "cursor_required"
          );
        const admitted = await ports.events.cursorState(after);
        if (!admitted.ok)
          throw new HttpError(
            409,
            admitted.code === "cursor_unknown"
              ? `cursor ${after} 不属于本次后端事件序列（当前 ${admitted.cursor}）；请重新获取快照`
              : `cursor ${after} 早于保留窗口（${admitted.earliest}–${admitted.cursor}）；请重新获取快照`,
            admitted.code
          );
        await ports.events.subscribe(request, response, after);
        return;
      }
      // Bind desktop request epochs before any awaited router can cross a
      // stop/revoke/resume boundary while this request is still being admitted.
      if (await handleComputerRequest(request, response, url, ports.computer, locateTask)) return;
      if (
        ports.projectData &&
        (await handleProjectDataRequest(request, response, url, {
          runtime: ports.projectData,
          backendId: ports.backendInfo().backendId,
          principal,
          project: async (projectId) => {
            const project = await ports.projectForId(projectId);
            return project
              ? {
                  projectId: project.projectId,
                  projectName: project.projectName,
                  projectDirectory: project.projectDirectory
                }
              : undefined;
          },
          taskProject: async (taskId) => {
            const location = await ports.locateTask(taskId);
            if (!location.projectId) return undefined;
            const project = await ports.projectForId(location.projectId);
            return project
              ? {
                  projectId: project.projectId,
                  projectName: project.projectName,
                  projectDirectory: project.projectDirectory
                }
              : undefined;
          }
        }))
      )
        return;
      if (
        ports.subagents &&
        (await handleSubagentRequest(request, response, url, { backend: ports.subagents }))
      )
        return;
      if (
        ports.developments &&
        (await handleDevelopmentRequest(request, response, url, {
          service: ports.developments,
          backendId: ports.backendInfo().backendId,
          taskProject: async (taskId) => {
            const location = await ports.locateTask(taskId);
            if (!location.projectId) return undefined;
            const project = await ports.projectForId(location.projectId);
            return project
              ? {
                  projectId: project.projectId,
                  projectName: project.projectName,
                  projectDirectory: project.projectDirectory
                }
              : undefined;
          }
        }))
      )
        return;
      if (ports.mainSessions && (await handleMainSessionRequest(request, response, url, ports.mainSessions)))
        return;
      if (ports.mainCapacity && (await handleMainCapacityRequest(request, response, url, ports.mainCapacity)))
        return;
      if (ports.uploads && (await handleUploadRequest(request, response, url, ports.uploads))) return;
      if (request.method === "GET" && url.pathname === "/") {
        const html = await readFile(join(uiRoot, "index.html"), "utf8");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          "content-security-policy": dashboardContentPolicy(trustedClientOrigins()),
          "x-content-type-options": "nosniff"
        });
        response.end(html);
        return;
      }
      if (
        request.method === "GET" &&
        (url.pathname === "/styles.css" || url.pathname === "/app.js" || url.pathname.startsWith("/assets/"))
      ) {
        const asset = await readFile(join(uiRoot, url.pathname.slice(1)));
        const extension = url.pathname.slice(url.pathname.lastIndexOf(".")).toLowerCase();
        const contentType =
          (
            {
              ".css": "text/css; charset=utf-8",
              ".js": "text/javascript; charset=utf-8",
              ".html": "text/html; charset=utf-8",
              ".json": "application/json",
              ".svg": "image/svg+xml",
              ".png": "image/png",
              ".jpg": "image/jpeg",
              ".jpeg": "image/jpeg",
              ".webp": "image/webp",
              ".gif": "image/gif",
              ".ico": "image/x-icon",
              ".woff": "font/woff",
              ".woff2": "font/woff2",
              ".ttf": "font/ttf",
              ".gz": "application/gzip",
              ".txt": "text/plain; charset=utf-8"
            } as Record<string, string>
          )[extension] ?? "application/octet-stream";
        response.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
        response.end(asset);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/tasks") {
        sendJson(response, 200, {
          ...(await globalTaskPayload()),
          connectionProfileId: ports.modelSettings.status().activeProfileId
        });
        return;
      }
      if (await handleProjectCloneRequest(request, response, url, ports.projectClones)) return;
      if (await handleSkillRequest(request, response, url, ports.skills)) return;
      if (await handleMcpRequest(request, response, url, ports.mcp)) return;
      if (await handleComposerRequest(request, response, url, ports.composer)) return;
      if (await handleAgentRequest(request, response, url, ports.agents)) return;
      if (await handleMemoryRequest(request, response, url, ports.memories)) return;
      if (await handleProjectCatalogRequest(request, response, url, ports, principal)) return;
      if (await handleModelSettingsRequest(request, response, url, ports)) return;
      if (request.method === "POST" && url.pathname === "/api/workspace/choose") {
        const body = await readJsonBody(request);
        if (body.taskId !== undefined) {
          sendJson(response, 410, { error: "会话级文件夹设置已移至项目，请在项目设置中更改文件夹。" });
          return;
        }
        const root =
          body.workspaceRoot === undefined
            ? await chooseLocalDirectory()
            : await resolveWorkspacePath(body.workspaceRoot);
        if (root) await ports.switchWorkspace(root);
        sendJson(response, 200, { cancelled: !root, ...(await globalTaskPayload()) });
        return;
      }
      if (await handleTaskConversationRequest(request, response, url, ports, principal)) return;
      if (await handleTaskFileRequest(request, response, url, ports)) return;
      await handleTaskLifecycleRequest(request, response, url, ports);
    } catch (error) {
      if (response.headersSent) response.destroy();
      else
        sendJson(
          response,
          error instanceof MainMessageEditConflict ||
            error instanceof HttpError ||
            error instanceof ProjectCatalogError ||
            error instanceof ProjectCloneError ||
            error instanceof ProjectDataError ||
            error instanceof MainRequestConflictError ||
            error instanceof MainRequestSnapshotError
            ? error.status
            : 400,
          {
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof HttpError && error.code ? { code: error.code } : {}),
            ...(error instanceof ProjectDataError && error.code ? { code: error.code } : {}),
            ...(error instanceof ProjectDataConflictError && error.currentRevision !== undefined
              ? { currentRevision: error.currentRevision }
              : {}),
            ...(error instanceof MainMessageEditConflict ||
            error instanceof MainRequestConflictError ||
            error instanceof MainRequestSnapshotError
              ? { code: error.code }
              : {})
          }
        );
    }
  };
}
