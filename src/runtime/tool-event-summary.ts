const TOOL_ARGS_INLINE_LIMIT = 512;
const TOOL_RESULT_INLINE_LIMIT = 512;
const TOOL_PARTIAL_INLINE_LIMIT = 1024;
const DETAIL_TEXT_LIMIT = 1_500_000;

const SHORT_ARG_KEYS = [
  "path",
  "filePath",
  "file_path",
  "filename",
  "file",
  "sourcePath",
  "mode",
  "role",
  "agentName",
  "name",
  "resourceId",
  "jobId",
  "agentId",
  "callId",
  "url"
] as const;

const LIFECYCLE_DETAIL_KEYS = new Set([
  "callId",
  "accepted",
  "name",
  "agentName",
  "delivered",
  "requestId",
  "status",
  "jobId",
  "logPath",
  "parked",
  "wakeAt",
  "reason",
  "completed",
  "errorCode",
  "dispatchStatus"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clipText(value: string, limit: number): string {
  const chars = Array.from(value);
  return chars.length > limit ? `${chars.slice(0, Math.max(0, limit - 1)).join("")}…` : value;
}

function safeJsonSize(value: unknown): number {
  try {
    const serialized = JSON.stringify(value) as string | undefined;
    return typeof serialized === "string" ? serialized.length : 0;
    // eslint-disable-next-line no-restricted-syntax -- 异常对象（循环引用、BigInt）无法 JSON 序列化时按超限处理以走安全摘要路径
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function containsBinaryPart(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const content = value.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) =>
      isRecord(part) &&
      (part.type === "image" || part.type === "audio") &&
      typeof part.data === "string" &&
      part.data.length > 0
  );
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .filter(
        (part): part is { type: "text"; text: string } =>
          isRecord(part) && part.type === "text" && typeof part.text === "string"
      )
      .map((part) => part.text)
      .join("\n");
  }
  if (isRecord(value)) {
    const details = isRecord(value.details) ? value.details : undefined;
    const archived = isRecord(details?.archivedOutput) ? details.archivedOutput : undefined;
    if (archived && "content" in archived) return extractTextContent(archived.content);
    if ("content" in value) return extractTextContent(value.content);
  }
  return "";
}

function clipErrorExcerpt(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 1200) return trimmed;
  return `${trimmed.slice(0, 600)}\n…\n${trimmed.slice(-600)}`;
}

/**
 * Keep small tool arguments inline; summarize bulky write/edit/patch/heredoc
 * payloads to just the subject/routing fields needed for L1/L2 display.
 */
export function summarizeToolArgs(args: unknown): { args: unknown; omitted: boolean } {
  if (args === undefined || args === null) return { args, omitted: false };
  if (safeJsonSize(args) <= TOOL_ARGS_INLINE_LIMIT) return { args, omitted: false };
  if (typeof args === "string") return { args: clipText(args, 240), omitted: true };
  if (!isRecord(args)) return { args: {}, omitted: true };
  const compact: Record<string, unknown> = {};
  for (const key of SHORT_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) compact[key] = clipText(value, 240);
  }
  if (typeof args.command === "string") compact.command = clipText(args.command, 400);
  for (const key of ["query", "pattern"] as const) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) compact[key] = clipText(value, 200);
  }
  for (const key of ["task", "question", "summary", "message"] as const) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) compact[key] = clipText(value, 240);
  }
  if (isRecord(args.action) && typeof args.action.type === "string") {
    compact.action = { type: clipText(args.action.type, 80) };
  }
  return { args: compact, omitted: true };
}

function collectSummaryDetails(result: unknown): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  const absorb = (source: Record<string, unknown>, allowExtraScalars: boolean) => {
    for (const [key, value] of Object.entries(source)) {
      if (key === "archivedOutput" || value === undefined || value === null || value === "") continue;
      if (key === "pending" || key === "callbackPending") {
        if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
          summary[key] = value;
        }
        continue;
      }
      if (key === "error") {
        if (typeof value === "string") summary.error = clipText(value, 300);
        else if (isRecord(value) && typeof value.message === "string")
          summary.error = { message: clipText(value.message, 300) };
        continue;
      }
      if (LIFECYCLE_DETAIL_KEYS.has(key)) {
        if (typeof value === "boolean" || typeof value === "number") summary[key] = value;
        else if (typeof value === "string") summary[key] = clipText(value, 256);
        continue;
      }
      if (!allowExtraScalars) continue;
      if (typeof value === "boolean" || typeof value === "number") summary[key] = value;
      else if (typeof value === "string" && value.length <= 256) summary[key] = value;
    }
  };
  if (!isRecord(result)) return summary;
  // Parse compact JSON text content when tools return lifecycle metadata in content[].text.
  const rawText = extractTextContent(result.content).trim();
  if (rawText.startsWith("{") && rawText.length <= 16_384) {
    try {
      const parsed = JSON.parse(rawText) as unknown;
      if (isRecord(parsed)) absorb(parsed, false);
      // eslint-disable-next-line no-restricted-syntax -- 工具文本输出不保证是合法 JSON，解析失败按普通文本跳过
    } catch {
      /* ignore non-JSON text */
    }
  }
  if (isRecord(result.details)) absorb(result.details, true);
  return summary;
}

/**
 * Keep small tool results inline; replace large outputs, archived outputs and
 * binary payloads with lifecycle metadata (and a compact error excerpt on failure).
 */
export function summarizeToolResult(
  result: unknown,
  isError: boolean
): { result: unknown; omitted: boolean } {
  if (result === undefined || result === null) return { result, omitted: false };
  const hasArchived = Boolean(
    isRecord(result) && isRecord(result.details) && "archivedOutput" in result.details
  );
  const hasBinary = containsBinaryPart(result);
  if (!hasArchived && !hasBinary && safeJsonSize(result) <= TOOL_RESULT_INLINE_LIMIT) {
    return { result, omitted: false };
  }
  const details = collectSummaryDetails(result);
  const compact: Record<string, unknown> = {};
  if (isError) {
    const excerpt = clipErrorExcerpt(extractTextContent(result));
    if (excerpt) compact.content = [{ type: "text", text: excerpt }];
  }
  if (Object.keys(details).length) compact.details = details;
  return { result: compact, omitted: true };
}

/** Keep live streaming tool progress bounded without dropping recent output. */
export function summarizeToolPartialResult(partialResult: unknown): {
  partialResult: unknown;
  omitted: boolean;
} {
  if (partialResult === undefined || partialResult === null) return { partialResult, omitted: false };
  const hasBinary = containsBinaryPart(partialResult);
  if (!hasBinary && safeJsonSize(partialResult) <= TOOL_PARTIAL_INLINE_LIMIT) {
    return { partialResult, omitted: false };
  }
  const text = extractTextContent(partialResult).trim();
  const tail = text.length > 800 ? `…\n${text.slice(-800)}` : text;
  return {
    partialResult: tail ? { content: [{ type: "text", text: tail }] } : {},
    omitted: true
  };
}

/** Unwrap archivedOutput so on-demand L3 detail shows the full user-facing output. */
function unwrapArchivedOutput(result: unknown): unknown {
  if (!isRecord(result) || !isRecord(result.details)) return result;
  const archived = result.details.archivedOutput;
  if (!isRecord(archived)) return result;
  const { archivedOutput: _archived, ...details } = result.details;
  const { structuredContent: _structured, details: _details, ...rest } = result;
  return {
    ...rest,
    content: archived.content,
    ...(archived.structuredContent === undefined ? {} : { structuredContent: archived.structuredContent }),
    ...(Object.keys(details).length ? { details } : {})
  };
}

function sanitizeDetailValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= DETAIL_TEXT_LIMIT) return value;
    return `${value.slice(0, DETAIL_TEXT_LIMIT)}\n…（内容过长，共 ${value.length} 字符，已截断）`;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeDetailValue(item));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "data" && (value.type === "image" || value.type === "audio") && typeof entry === "string") {
      out[key] = `[${value.type === "image" ? "图片" : "音频"}二进制内容，${entry.length} 个编码字符]`;
    } else {
      out[key] = sanitizeDetailValue(entry);
    }
  }
  return out;
}

export interface ToolCallDetail {
  runId?: string;
  toolCallId: string;
  toolName?: string;
  arguments?: unknown;
  result?: unknown;
  isError: boolean;
  completed: boolean;
}

/** Reconstruct one tool call's full arguments and output from durable runtime records. */
export function extractToolCallDetail(
  records: Array<Record<string, unknown>>,
  callId: string
): ToolCallDetail | undefined {
  let found = false;
  let runId: string | undefined;
  let toolName: string | undefined;
  let args: unknown;
  let result: unknown;
  let partialResult: unknown;
  let isError = false;
  let completed = false;

  for (const record of records) {
    const payload = record.type === "runtime_event" && isRecord(record.payload) ? record.payload : record;
    const type = payload.type;
    const recordRunId = typeof record.runId === "string" ? record.runId : undefined;
    if (type === "message_end" || type === "turn_end") {
      const message = isRecord(payload.message) ? payload.message : undefined;
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (isRecord(part) && part.type === "toolCall" && part.id === callId) {
            found = true;
            if (recordRunId) runId = recordRunId;
            if (typeof part.name === "string") toolName = part.name;
            if (part.arguments !== undefined) args = part.arguments;
          }
        }
      }
      continue;
    }
    if (
      (type === "tool_execution_start" ||
        type === "tool_execution_update" ||
        type === "tool_execution_end") &&
      payload.toolCallId === callId
    ) {
      found = true;
      if (recordRunId) runId = recordRunId;
      if (typeof payload.toolName === "string") toolName = payload.toolName;
      if (payload.args !== undefined) args = payload.args;
      if (type === "tool_execution_update" && payload.partialResult !== undefined) {
        partialResult = payload.partialResult;
      }
      if (type === "tool_execution_end") {
        result = unwrapArchivedOutput(payload.result);
        isError = payload.isError === true;
        completed = true;
      }
    }
  }
  if (!found) return undefined;
  return {
    ...(runId ? { runId } : {}),
    toolCallId: callId,
    ...(toolName ? { toolName } : {}),
    ...(args !== undefined ? { arguments: sanitizeDetailValue(args) } : {}),
    ...(completed
      ? result !== undefined
        ? { result: sanitizeDetailValue(result) }
        : {}
      : partialResult !== undefined
        ? { result: sanitizeDetailValue(partialResult) }
        : {}),
    isError,
    completed
  };
}
