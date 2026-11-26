import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import type { HistoryService } from "./history-service.js";

const offset = z.number().int().min(0).optional();
const requestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("search"),
      query: z.string().min(1).max(300),
      role: z.enum(["user", "assistant", "toolResult", "custom"]).optional(),
      tool: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(20).optional()
    })
    .strict(),
  z
    .object({
      action: z.literal("read"),
      session: z.string().min(1).max(200),
      id: z.string().min(1).max(500),
      start: offset,
      end: offset,
      field: z.literal("structured").optional(),
      image: z.number().int().min(1).optional()
    })
    .strict()
]);

const TASK_PATH = /^\/api\/tasks\/([^/]+)\/history$/;

/** Main's search and read over the other sessions of its project, under `/api/tasks/:taskId/history`. */
export async function handleHistoryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  history: HistoryService | undefined
): Promise<boolean> {
  const match = history && url.pathname.match(TASK_PATH);
  if (!history || !match) return false;
  if (request.method !== "POST") throw new HttpError(405, "method not allowed");
  const parsed = requestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success)
    throw new HttpError(
      400,
      `历史请求参数不合法：${parsed.error.issues
        .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
        .join("；")}`,
      "history_input_invalid"
    );
  const taskId = decodeURIComponent(match[1]);
  const body = parsed.data;
  if (body.action === "search") {
    const { action: _action, limit, ...search } = body;
    sendJson(response, 200, await history.search(taskId, { ...search, limit: limit ?? 10 }));
  } else {
    const { action: _action, session, id, ...read } = body;
    sendJson(response, 200, await history.read(taskId, session, id, read));
  }
  return true;
}
