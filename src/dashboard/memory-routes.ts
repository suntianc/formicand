import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { MEMORY_TYPES } from "../runtime/memory-store.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import type { MemoryService } from "./memory-service.js";

const scope = z.enum(["user", "project"]);
const projectId = z.string().trim().min(1).max(200);
const name = z.string().trim().min(1).max(64);
const memory = z
  .object({
    name,
    description: z.string().max(1000),
    type: z.enum(MEMORY_TYPES),
    body: z.string().max(64 * 1024)
  })
  .strict();

const target = z.object({ scope, projectId: projectId.optional() }).strict();
const saveSchema = z.object({ target, memory, previousName: name.optional() }).strict();
const entrySchema = z.object({ target, name }).strict();
const enabledSchema = z.object({ projectId, enabled: z.boolean() }).strict();
const taskSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  // Read may leave out the scope: the project memory is looked up first, then the user one.
  z.object({ action: z.literal("read"), scope: scope.optional(), name }).strict(),
  z.object({ action: z.literal("write"), scope, memory }).strict(),
  z.object({ action: z.literal("delete"), scope, name }).strict()
]);

const TASK_PATH = /^\/api\/tasks\/([^/]+)\/memory$/;

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HttpError(
      400,
      `记忆请求参数不合法：${result.error.issues
        .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
        .join("；")}`,
      "memory_input_invalid"
    );
  return result.data;
}

function queryTarget(url: URL) {
  return parsed(target, {
    scope: url.searchParams.get("scope") ?? "user",
    ...(url.searchParams.get("projectId") ? { projectId: url.searchParams.get("projectId") } : {})
  });
}

/**
 * Settings → Memory under `/api/memory`, and Main's tool under
 * `/api/tasks/:taskId/memory`, whose project comes from the Task.
 */
export async function handleMemoryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  memories: MemoryService | undefined
): Promise<boolean> {
  if (!memories) return false;
  const taskMatch = url.pathname.match(TASK_PATH);
  if (!taskMatch && !url.pathname.startsWith("/api/memory")) return false;
  const get = () => {
    if (request.method !== "GET") throw new HttpError(405, "method not allowed");
  };
  const post = async () => {
    if (request.method !== "POST") throw new HttpError(405, "method not allowed");
    return readJsonBody(request);
  };
  if (taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1]);
    if (request.method === "GET") {
      sendJson(response, 200, await memories.forTask(taskId));
      return true;
    }
    const body = parsed(taskSchema, await post());
    sendJson(
      response,
      200,
      body.action === "list" ? await memories.forTask(taskId) : await memories.taskAction(taskId, body)
    );
    return true;
  }
  switch (url.pathname) {
    case "/api/memory": {
      get();
      const where = queryTarget(url);
      sendJson(response, 200, await memories.list(where.scope, where.projectId));
      return true;
    }
    case "/api/memory/read": {
      get();
      const where = queryTarget(url);
      sendJson(
        response,
        200,
        await memories.read(where.scope, parsed(name, url.searchParams.get("name")), where.projectId)
      );
      return true;
    }
    case "/api/memory/save": {
      const body = parsed(saveSchema, await post());
      sendJson(
        response,
        200,
        await memories.save(body.target.scope, body.memory, body.target.projectId, body.previousName)
      );
      return true;
    }
    case "/api/memory/delete": {
      const body = parsed(entrySchema, await post());
      sendJson(response, 200, await memories.delete(body.target.scope, body.name, body.target.projectId));
      return true;
    }
    case "/api/memory/enabled": {
      const body = parsed(enabledSchema, await post());
      sendJson(response, 200, await memories.setEnabled(body.projectId, body.enabled));
      return true;
    }
    default:
      return false;
  }
}
