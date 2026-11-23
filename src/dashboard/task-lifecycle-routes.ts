import { type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { readJsonBody, sendJson } from "./http.js";
import { readAgentTrajectory } from "../runtime/agent-trajectory.js";
import { readJsonFile } from "./event-stream.js";

import type { DashboardRoutePorts } from "./routes.js";
import { publishTask } from "./catalog-publication.js";

export async function handleTaskLifecycleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ports: Pick<
    DashboardRoutePorts,
    | "locateTask"
    | "pauseTask"
    | "stopTask"
    | "cancelTask"
    | "taskLifecycle"
    | "taskDetails"
    | "toolCallDetail"
    | "taskListItem"
    | "events"
    | "compactMainContext"
  >
): Promise<void> {
  const {
    locateTask,
    pauseTask,
    stopTask,
    cancelTask,
    taskLifecycle,
    taskDetails,
    toolCallDetail,
    taskListItem
  } = ports;
  const toolCallMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/tool-call$/);
  if (request.method === "GET" && toolCallMatch) {
    const taskId = decodeURIComponent(toolCallMatch[1]);
    const safeId = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
    if (!safeId.test(taskId)) throw new Error("unsafe task id");
    const callId = (url.searchParams.get("callId") ?? "").trim();
    if (!callId || callId.length > 256 || /[\0\r\n]/.test(callId)) {
      sendJson(response, 400, { error: "无效的工具调用标识" });
      return;
    }
    const rawRunId = url.searchParams.get("runId")?.trim() || undefined;
    if (rawRunId && !safeId.test(rawRunId)) {
      sendJson(response, 400, { error: "无效的运行标识" });
      return;
    }
    sendJson(response, 200, await toolCallDetail(taskId, { callId, runId: rawRunId }));
    return;
  }
  const trajectoryMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/agents\/([^/]+)\/trajectory$/);
  if (request.method === "GET" && trajectoryMatch) {
    const taskId = decodeURIComponent(trajectoryMatch[1]);
    const agentId = decodeURIComponent(trajectoryMatch[2]);
    const safeId = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
    if (!safeId.test(taskId) || !safeId.test(agentId)) throw new Error("unsafe task or agent id");
    const location = await locateTask(taskId);
    const task = location.task;
    const taskWorkspace = location.workspaceRoot;
    const runId = task.activeRunId;
    if (!runId) {
      sendJson(response, 200, { entries: [], total: 0 });
      return;
    }
    if (!safeId.test(runId)) throw new Error("unsafe run id");
    if (agentId !== "main") {
      const queue = await readJsonFile<Array<{ agentId: string }>>(
        join(taskWorkspace, taskId, "runs", runId, "queue.json"),
        []
      );
      if (!queue.some((entry) => entry.agentId === agentId)) {
        sendJson(response, 404, { error: "智能体不存在" });
        return;
      }
    }
    const tracePath =
      agentId === "main"
        ? join(taskWorkspace, taskId, "runs", runId, "runtime-output.log")
        : join(taskWorkspace, taskId, "runs", runId, "agents", "subagents", agentId, "agent-output.log");
    sendJson(response, 200, await readAgentTrajectory(tracePath));
    return;
  }
  const match = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/action)?$/);
  if (!match) {
    sendJson(response, 404, { error: "not found" });
    return;
  }
  const taskId = decodeURIComponent(match[1]);
  if (request.method === "GET") {
    sendJson(response, 200, await taskDetails(taskId));
    return;
  }
  if (request.method === "DELETE") {
    await taskLifecycle.deleteTask(taskId);
    await ports.events?.taskDeleted(taskId);
    sendJson(response, 200, { taskId, deleted: true });
    return;
  }
  if (request.method === "PATCH") {
    const body = await readJsonBody(request);
    const patch: { title?: string; pinned?: boolean; archived?: boolean } = {};
    if (body.title !== undefined) {
      if (
        typeof body.title !== "string" ||
        !body.title.trim() ||
        body.title.trim().length > 100 ||
        /[\0\r\n]/.test(body.title)
      )
        throw new Error("会话名称需为 1–100 个字符");
      patch.title = body.title.trim();
    }
    for (const field of ["pinned", "archived"] as const) {
      if (body[field] !== undefined) {
        if (typeof body[field] !== "boolean") throw new Error(`${field} 必须为布尔值`);
        patch[field] = body[field];
      }
    }
    sendJson(
      response,
      200,
      await publishTask(ports.events, await taskListItem(await taskLifecycle.updateTask(taskId, patch)))
    );
    return;
  }
  if (request.method === "POST" && url.pathname.endsWith("/action")) {
    const body = await readJsonBody(request);
    const action = body.action;
    if (action === "compact") {
      const result = await ports.compactMainContext(taskId);
      sendJson(response, result.error ? 409 : result.queued ? 202 : 200, result);
      return;
    }
    if (
      action !== "pause" &&
      action !== "stop" &&
      action !== "cancel" &&
      action !== "resume" &&
      action !== "complete"
    )
      throw new Error("unsupported task action");
    const location = await locateTask(taskId);
    if (action === "pause") {
      const paused = await pauseTask(taskId);
      if (paused.refused) {
        sendJson(response, 409, { error: "当前没有运行中的 Main" });
        return;
      }
      sendJson(
        response,
        200,
        await publishTask(ports.events, await taskListItem({ ...location, task: paused.task }))
      );
      return;
    }
    if (action === "stop") {
      const stopped = await stopTask(taskId);
      if (stopped.refused) {
        sendJson(response, 409, {
          error: stopped.refused === "paused" ? "已暂停的会话请先继续" : "当前没有正在运行的回合"
        });
        return;
      }
      sendJson(response, 202, stopped);
      return;
    }
    if (action === "complete") {
      const result = await taskLifecycle.completeTask(taskId);
      if (result.task)
        sendJson(
          response,
          200,
          await publishTask(ports.events, await taskListItem({ ...location, task: result.task }))
        );
      else sendJson(response, 409, result);
      return;
    }
    const next = action === "cancel" ? await cancelTask(taskId) : await taskLifecycle.resumeTask(taskId);
    sendJson(response, 200, await publishTask(ports.events, await taskListItem({ ...location, task: next })));
    return;
  }
  sendJson(response, 405, { error: "method not allowed" });
}
