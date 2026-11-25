import { runtimeLogWindow, type LogWindow } from "./runtime-log-window.js";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { liveRuntimeOutput, runtimeLogEvents, type PositionedEvent } from "./runtime-output.js";
import { readQueuedUserTurn } from "./queued-user-turn.js";
import type { MainInput } from "./main-continuation.js";
import { conversationMessages, type ConversationMessage } from "./conversation-view.js";
import { summarizeToolArgs, summarizeToolPartialResult, summarizeToolResult } from "./tool-event-summary.js";

export function runtimeEventRecord(
  taskId: string,
  runId: string,
  index: number,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const message = payload.message as Record<string, unknown> | undefined;
  const queued = message?.role === "user" ? readQueuedUserTurn(message.content) : undefined;
  if (queued) payload = { ...payload, message: { ...message, id: queued.messageId, content: queued.text } };
  return {
    eventId: `runtime-${runId}-${index}`,
    type: "runtime_event",
    taskId,
    runId,
    agentId: "main",
    payload
  };
}

type ParsedLog = ReturnType<typeof runtimeLogEvents> & { key: string; bytes: number };
const parsedLogs = new Map<string, ParsedLog>();
// Charge the on-disk input size. Keep both large histories and empty log metadata bounded.
const logByteBudget = 24 * 1024 * 1024;
const logCountLimit = 512;
let cachedLogBytes = 0;

function dropCachedLog(path: string, entry: ParsedLog) {
  parsedLogs.delete(path);
  cachedLogBytes -= entry.bytes;
}

function cacheLog(path: string, entry: ParsedLog) {
  const previous = parsedLogs.get(path);
  if (previous) dropCachedLog(path, previous);
  if (entry.bytes > logByteBudget) return;
  parsedLogs.set(path, entry);
  cachedLogBytes += entry.bytes;
  for (const [oldest, value] of parsedLogs) {
    if (cachedLogBytes <= logByteBudget && parsedLogs.size <= logCountLimit) break;
    dropCachedLog(oldest, value);
  }
}

/**
 * A run's runtime log with the deltas of a message still being written.
 *
 * An ended run's log no longer changes, and a running one changes only at its
 * end; a log read before and unchanged since is not parsed again.
 */
async function readRuntimeLog(path: string, window?: LogWindow): Promise<PositionedEvent[]> {
  let parsed: ParsedLog | undefined;
  try {
    const info = await stat(path);
    const key = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (window) {
      const tail = await runtimeLogWindow(path, key, info.size, window);
      if (tail) return [...tail.events, ...(liveRuntimeOutput(path)?.openDeltas(tail.next) ?? [])];
    }
    parsed = parsedLogs.get(path);
    if (parsed?.key !== key) {
      parsed = { key, bytes: info.size, ...runtimeLogEvents(await readFile(path, "utf8")) };
      cacheLog(path, parsed);
    } else {
      parsedLogs.delete(path);
      parsedLogs.set(path, parsed);
    }
  } catch (error) {
    // A run that failed to start may have no runtime-output.log.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    parsed = { key: "", bytes: 0, events: [], next: 0 };
  }
  const open = liveRuntimeOutput(path)?.openDeltas(parsed.next) ?? [];
  return open.length ? [...parsed.events, ...open] : parsed.events;
}

/** Read one Run's runtime events (including live open deltas) without scanning other Runs. */
export async function readRunRuntimeEvents(
  workspaceRoot: string,
  taskId: string,
  runId: string
): Promise<Array<Record<string, unknown>>> {
  const path = join(workspaceRoot, taskId, "runs", runId, "runtime-output.log");
  const events = await readRuntimeLog(path);
  return events.map(({ index, event }) => runtimeEventRecord(taskId, runId, index, event));
}

export async function conversationRunIds(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** A conversation outlives its active run. Replay every run in creation order,
 * using the same identities as SSE, including repeated token deltas. */
export async function readTaskRuntimeEvents(
  workspaceRoot: string,
  taskId: string,
  selectedRuns?: readonly string[],
  inputsOnly = false,
  window?: LogWindow
): Promise<Array<Record<string, unknown>>> {
  const directory = join(workspaceRoot, taskId, "runs");
  const runIds = selectedRuns ?? (await conversationRunIds(directory));
  const runs = await Promise.all(
    runIds.map(async (runId) => {
      const path = join(directory, runId);
      const [metadata, ledger] = await Promise.all([
        // eslint-disable-next-line no-restricted-syntax -- 早期 Run 从未写过 run.json，缺失时按空元数据继续，createdAt 留空并由 runId 兜底排序
        readFile(join(path, "run.json"), "utf8").catch(() => "{}"),
        // eslint-disable-next-line no-restricted-syntax -- 同上，run_events.jsonl 可能尚未创建，缺失只表示该 Run 没有账本事件
        readFile(join(path, "run_events.jsonl"), "utf8").catch(() => "")
      ]);
      let createdAt = "";
      try {
        createdAt = JSON.parse(metadata).createdAt || "";
        // eslint-disable-next-line no-restricted-syntax -- 更早版本的 run.json 没有 createdAt，解析失败只影响排序键，必须继续回放该 Run 的事件
      } catch {
        /* older runs may lack metadata */
      }
      const ledgerEvents = ledger.split(/\r?\n/).flatMap((line) => {
        try {
          const value = JSON.parse(line);
          return [
            "user.interjected",
            "user.message_promoted",
            "user.message_cancelled",
            "inbox.consumed"
          ].includes(value.type) ||
            /^main\.run_(completed|failed|waiting|cancelled|stopped)$/.test(value.type)
            ? [value]
            : [];
          // eslint-disable-next-line no-restricted-syntax -- 账本是追加写的，末行可能不完整；单行解析失败不能让整个会话历史丢失
        } catch {
          return [];
        }
      });
      // Edit discovery uses runtime records only to establish membership of a Run.
      // Any saved ledger entry already establishes that same membership.
      const output =
        inputsOnly && ledgerEvents.length
          ? []
          : await readRuntimeLog(join(path, "runtime-output.log"), window);
      return { runId, createdAt, events: output, ledgerEvents };
    })
  );
  runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId));
  return runs.flatMap((run) => {
    const records: Array<Record<string, unknown>> = run.events.map(({ index, event }) =>
      runtimeEventRecord(taskId, run.runId, index, event)
    );
    // A resident Main serves several rounds in one Run. A stop belongs to the
    // round it stopped, so it is placed after the last message written before
    // it rather than at the end of the Run, where a later round would claim it.
    const ledger = run.ledgerEvents.filter((event) => event.type !== "main.run_stopped");
    for (const stop of run.ledgerEvents.filter((event) => event.type === "main.run_stopped")) {
      const at = Date.parse(String(stop.occurredAt ?? ""));
      let before = -1;
      if (Number.isFinite(at))
        records.forEach((record, index) => {
          const time = (record.payload as { message?: { timestamp?: unknown } } | undefined)?.message
            ?.timestamp;
          if (typeof time === "number" && time <= at) before = index;
        });
      if (before < 0) ledger.push(stop);
      else records.splice(before + 1, 0, stop);
    }
    return [...records, ...ledger];
  });
}

const TIMING_BOUNDARY_TYPES = new Set([
  "main.run_spawned",
  "main.turn_delivered",
  "main.turn_started",
  "main.run_completed",
  "main.run_failed",
  "main.run_paused",
  "main.run_waiting",
  "main.run_stopped"
]);

/**
 * Slim lifecycle timing boundaries across every Run of a Task.
 *
 * The conversation view computes per-exchange durations from these ledger
 * boundaries. Reading only the active Run's last 30 lines drops earlier Runs
 * and truncates older turns in long resident Runs, turning "用时 X" into a
 * timeless fallback.
 */
export async function readTaskTimingEvents(
  workspaceRoot: string,
  taskId: string,
  selectedRuns?: readonly string[]
): Promise<Array<Record<string, unknown>>> {
  const directory = join(workspaceRoot, taskId, "runs");
  const ids = selectedRuns ?? (await conversationRunIds(directory));
  const perRun = await Promise.all(
    ids.map(async (runId) => {
      const runPath = join(directory, runId);
      const [metadata, ledger] = await Promise.all([
        // eslint-disable-next-line no-restricted-syntax -- 早期 Run 可能缺少 run.json，回退到 runId 排序
        readFile(join(runPath, "run.json"), "utf8").catch(() => "{}"),
        // eslint-disable-next-line no-restricted-syntax -- 新建 Run 可能尚未落盘 run_events.jsonl
        readFile(join(runPath, "run_events.jsonl"), "utf8").catch(() => "")
      ]);
      let createdAt = "";
      try {
        createdAt = JSON.parse(metadata).createdAt || "";
        // eslint-disable-next-line no-restricted-syntax -- 元数据解析失败只影响排序，不影响读取边界事件
      } catch {
        /* older runs may lack metadata */
      }
      const events = ledger.split(/\r?\n/).flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (typeof value.type !== "string" || !TIMING_BOUNDARY_TYPES.has(value.type)) return [];
          const payload = value.payload as { queuedWhilePaused?: unknown } | undefined;
          return [
            {
              ...(typeof value.eventId === "string" ? { eventId: value.eventId } : {}),
              runId: typeof value.runId === "string" ? value.runId : runId,
              type: value.type,
              occurredAt: value.occurredAt,
              ...(payload?.queuedWhilePaused ? { payload: { queuedWhilePaused: true } } : {})
            }
          ];
          // eslint-disable-next-line no-restricted-syntax -- 追加写日志末行可能不完整，跳过损坏行继续读取其余边界
        } catch {
          return [];
        }
      });
      return { runId: runId, createdAt, events };
    })
  );
  perRun.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId));
  return perRun.flatMap((run) => run.events);
}

/** Recover older messages from immutable run logs when an earlier version
 * replaced messages.json with a fresh Pi session on each follow-up. */
export function messagesWithRuntimeHistory(
  saved: ConversationMessage[],
  events: Array<Record<string, unknown>>
): ConversationMessage[] {
  const cancelled = new Set(
    events
      .filter((event) => event.type === "user.message_cancelled")
      .map((event) => (event.payload as { messageId?: string } | undefined)?.messageId)
  );
  const consumed = new Map<string | undefined, string>();
  for (const record of events) {
    if (record.type !== "inbox.consumed") continue;
    const messageId = (record.payload as { messageId?: string } | undefined)?.messageId;
    const occurredAt = record.occurredAt;
    if (typeof messageId !== "string" || !messageId || typeof occurredAt !== "string") continue;
    const timestamp = Date.parse(occurredAt);
    if (!Number.isFinite(timestamp)) continue;
    const previous = consumed.get(messageId);
    // A replay or receipt repair in a later Run must not move the original
    // input. Invalid receipts cannot hide a subsequent valid delivery time.
    if (!previous || timestamp < Date.parse(previous)) consumed.set(messageId, occurredAt);
  }
  const promotedIds = new Set(
    events
      .filter(
        (event) =>
          ["user.message_promoted", "inbox.consumed"].includes(String(event.type)) &&
          (event.payload as { delivery?: string } | undefined)?.delivery === "steer"
      )
      .map((event) => (event.payload as { messageId?: string }).messageId)
  );
  const history = events.flatMap((record) => {
    if (record.type === "user.interjected") {
      const payload = (record.payload ?? {}) as {
        message?: string;
        messageId?: string;
        createdAt?: string;
        delivery?: "steer" | "followUp";
      };
      if (typeof payload.message !== "string" || cancelled.has(payload.messageId)) return [];
      const promoted = payload.messageId && promotedIds.has(payload.messageId);
      const delivery = promoted ? "steer" : payload.delivery;
      return [
        {
          id: payload.messageId || String(record.eventId),
          role: "user" as const,
          content: payload.message,
          timestamp: Date.parse(
            consumed.get(payload.messageId) || payload.createdAt || String(record.occurredAt)
          ),
          interjected: delivery !== "followUp" || !consumed.has(payload.messageId),
          delivery,
          pending: delivery === "followUp" && !consumed.has(payload.messageId)
        }
      ];
    }
    const event =
      record.type === "runtime_event" ? (record.payload as Record<string, unknown> | undefined) : record;
    if (event?.type !== "message_end") return [];
    const projected = conversationMessages([event.message]);
    const incoming = event.message as { role?: string; customType?: string } | undefined;
    if (incoming?.role !== "custom" || incoming.customType !== "formicand-user-message") return projected;
    // SDK runtime custom timestamps describe queue acceptance, not delivery.
    // A saved Pi entry replaces this below with its exact context timestamp.
    return projected.map((message) => {
      const receipt = consumed.get(message.id);
      const timestamp = receipt ? Date.parse(receipt) : undefined;
      return timestamp !== undefined && Number.isFinite(timestamp) ? { ...message, timestamp } : message;
    });
  });
  const used = new Set<number>();
  for (const message of saved) {
    const index = history.findIndex(
      (entry, index) =>
        !used.has(index) &&
        entry.role === message.role &&
        ((entry.id && entry.id === message.id) ||
          (entry.timestamp !== undefined && message.timestamp !== undefined
            ? entry.timestamp === message.timestamp
            : JSON.stringify(entry.content) === JSON.stringify(message.content)))
    );
    if (index < 0) {
      used.add(history.length);
      history.push(message);
    } else {
      history[index] = message;
      used.add(index);
    }
  }
  // Delivered Pi messages and the queue ledger share one stable identity.
  // Prefer the actual context position over an earlier submission timestamp.
  const seenIds = new Set<string>();
  return history
    .filter((message) => {
      if (!message.id) return true;
      if (seenIds.has(message.id)) return false;
      seenIds.add(message.id);
      return true;
    })
    .sort((a, b) => (a.timestamp !== undefined && b.timestamp !== undefined ? a.timestamp - b.timestamp : 0));
}

function messagePlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "string"
        ? part
        : part && typeof part === "object" && "text" in part
          ? String((part as { text?: unknown }).text ?? "")
          : ""
    )
    .join("");
}

/**
 * Keep an accepted Run input visible before Pi writes its first context snapshot.
 *
 * Message edits branch `messages.json` to the prefix before the edited turn and
 * let the newly spawned Pi process append the rewritten message on startup.
 * Projecting the accepted `main-input.json` (with the exact `messageId` and
 * `submittedAt` Pi will persist) closes that gap so the conversation never
 * drops the edited message, hides the previous answer, or flashes empty.
 */
export function withPendingMainInput(
  messages: ConversationMessage[],
  input: MainInput | undefined
): ConversationMessage[] {
  if (!input || input.source === "human") return messages;
  const text = readQueuedUserTurn(input.prompt)?.text ?? input.prompt;
  if (!text.trim()) return messages;
  const alreadyPresent = messages.some(
    (message) =>
      message.role === "user" &&
      ((input.messageId && message.id === input.messageId) ||
        (Number.isFinite(message.timestamp) &&
          (message.timestamp as number) >= input.submittedAt &&
          messagePlainText(message.content) === text))
  );
  if (alreadyPresent) return messages;
  return [
    ...messages,
    {
      ...(input.messageId ? { id: input.messageId } : {}),
      role: "user",
      content: text,
      timestamp: input.submittedAt
    }
  ];
}

type Payload = Record<string, unknown> & {
  type?: unknown;
  message?: Record<string, unknown>;
  assistantMessageEvent?: Record<string, unknown>;
  toolCallId?: unknown;
};

/**
 * A saved history without what later events repeat.
 *
 * Every token delta is logged, and once a message ends its snapshot carries
 * the same content again, as do the block endings and the turn's end. A tool's
 * progress updates are likewise replaced by its final result. The page draws
 * the settled parts from the snapshot and the result, so only the events of a
 * message or tool still in progress keep their bodies, for the live view.
 * Event ids keep their log index, so a stream resumes after the last one sent.
 */
export function settledRuntimeEvents(
  records: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const dropped = new Set<number>();
  const slimmed = new Map<number, Record<string, unknown>>();
  const deltas = new Map<string, number[]>();
  const blockEnds = new Map<string, number[]>();
  const toolStarts = new Map<string, number[]>();
  const ended = new Set<string>();
  const progress = new Map<string, number[]>();
  // Keep each run's highest runtime_event index so SSE `?after=` watermarks
  // (`runtimeLogMarks`) never regress when trailing noise events are dropped.
  const lastRuntimeByRun = new Map<string, number>();
  records.forEach((record, index) => {
    if (record.type === "runtime_event") lastRuntimeByRun.set(String(record.runId), index);
  });
  const remember = (lookup: Map<string, number[]>, key: string, index: number) => {
    const open = lookup.get(key);
    if (open) open.push(index);
    else lookup.set(key, [index]);
  };
  const slimToolCallUpdate = (index: number) => {
    const record = records[index];
    const payload = record.payload as Payload;
    const { content: _content, partial: _partial, toolCall, ...update } = payload.assistantMessageEvent ?? {};
    const call = toolCall as Record<string, unknown> | undefined;
    const { message: _message, usage: _usage, ...restPayload } = payload;
    slimmed.set(index, {
      ...record,
      payload: {
        ...restPayload,
        assistantMessageEvent: call
          ? { ...update, toolCall: { type: call.type, id: call.id, name: call.name } }
          : update
      }
    });
  };
  const settle = (stream: string) => {
    for (const index of deltas.get(stream) ?? []) dropped.add(index);
    for (const index of blockEnds.get(stream) ?? []) slimToolCallUpdate(index);
    for (const index of toolStarts.get(stream) ?? []) {
      const payload = records[index].payload as Payload;
      const call = payload.assistantMessageEvent?.toolCall as Record<string, unknown> | undefined;
      if (call && "arguments" in call) slimToolCallUpdate(index);
    }
    deltas.delete(stream);
    blockEnds.delete(stream);
    toolStarts.delete(stream);
  };
  records.forEach((record, index) => {
    if (record.type !== "runtime_event") return;
    const runId = String(record.runId);
    const isRunWatermark = lastRuntimeByRun.get(runId) === index;
    const stream = `${runId}:${String(record.agentId)}`;
    const payload = (record.payload ?? {}) as Payload;
    // The conversation view renders neither extension prompts nor start-only
    // system/toolResult envelopes (tool results come from tool_execution_end).
    if (
      !isRunWatermark &&
      (payload.type === "extension_ui_request" ||
        (payload.type === "message_start" &&
          (payload.message?.role === "toolResult" || payload.message?.role === "system")))
    ) {
      dropped.add(index);
      return;
    }
    const update = payload.assistantMessageEvent?.type;
    if (payload.type === "message_update" && typeof update === "string") {
      if (update.endsWith("_delta")) remember(deltas, stream, index);
      else if (update.endsWith("_end")) remember(blockEnds, stream, index);
      else if (update === "toolcall_start") remember(toolStarts, stream, index);
      return;
    }
    if (payload.type === "tool_execution_update" || payload.type === "tool_execution_end") {
      const call = `${stream}:${String(payload.toolCallId)}`;
      if (payload.type === "tool_execution_update") remember(progress, call, index);
      else {
        for (const update of progress.get(call) ?? []) dropped.add(update);
        progress.delete(call);
      }
      return;
    }
    if (payload.type === "turn_start") ended.delete(stream);
    if (payload.type === "message_end") {
      settle(stream);
      if (payload.message?.role === "assistant") ended.add(stream);
    }
    if (payload.type !== "turn_end") return;
    settle(stream);
    // The turn's message is the one that just ended, and its tool results were
    // each logged as their own message; keep only what tells the turn apart.
    if (ended.has(stream) && payload.message) {
      const { role, id, timestamp, stopReason } = payload.message;
      const { toolResults: _results, ...rest } = payload;
      slimmed.set(index, { ...record, payload: { ...rest, message: { role, id, timestamp, stopReason } } });
    }
    ended.delete(stream);
  });
  if (!dropped.size && !slimmed.size) return records;
  return records.flatMap((record, index) => (dropped.has(index) ? [] : [slimmed.get(index) ?? record]));
}

const ASSISTANT_START_KEYS = new Set(["role", "id", "timestamp", "stopReason", "errorMessage"]);
const ASSISTANT_META_KEYS = ["usage", "api", "provider", "model", "responseId", "cost"] as const;

/**
 * Strip provider signatures and bulky toolCall arguments from conversation
 * messages returned to the browser; full tool arguments are fetched on demand.
 */
export function viewConversationMessage(message: ConversationMessage): ConversationMessage {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
  let changed = false;
  const nextContent: unknown[] = [];
  for (const raw of message.content) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      nextContent.push(raw);
      continue;
    }
    let part = raw as Record<string, unknown>;
    if ("thinkingSignature" in part || "textSignature" in part) {
      const { thinkingSignature: _thinking, textSignature: _text, ...stripped } = part;
      part = stripped;
      changed = true;
    }
    if (part.type === "toolCall" && part.arguments !== undefined) {
      const summarized = summarizeToolArgs(part.arguments);
      if (summarized.omitted) {
        part = { ...part, arguments: summarized.args, detailOmitted: true };
        changed = true;
      }
    }
    nextContent.push(part);
  }
  return changed ? { ...message, content: nextContent } : message;
}

/**
 * A runtime event as the conversation view needs it.
 *
 * Every Run records Pi's full system prompt (start and end) and an
 * `agent_end` carrying the whole message list again; together they are most of
 * a long conversation's history and the page reads none of it. Tool results,
 * callback starts, assistant start envelopes, provider metadata and each
 * update's running snapshot/token count repeat what other events carry, and
 * reasoning signatures are only for the provider. The events stay, so
 * identities and order are unchanged; only those bodies are dropped.
 */
export function viewRuntimeEvent(record: Record<string, unknown>): Record<string, unknown> {
  if (record.type !== "runtime_event") return record;
  const payload = record.payload as Record<string, unknown> | undefined;
  if (payload?.type === "agent_end" && "messages" in payload) {
    const { messages: _messages, ...rest } = payload;
    return { ...record, payload: rest };
  }
  // Each streamed update repeats the message's running token count, message
  // snapshot and partial block state; the page draws updates from
  // assistantMessageEvent's own delta/content and reads stats separately.
  if (payload?.type === "message_update") {
    const update = payload.assistantMessageEvent as Record<string, unknown> | undefined;
    const hasPartial = Boolean(update && "partial" in update);
    if (!("usage" in payload) && !("message" in payload) && !hasPartial) return record;
    const { usage: _usage, message: _message, ...rest } = payload;
    if (hasPartial && update) {
      const { partial: _partial, ...restUpdate } = update;
      return { ...record, payload: { ...rest, assistantMessageEvent: restUpdate } };
    }
    return { ...record, payload: rest };
  }
  // Tool calls keep small args/results inline and replace bulky bodies with
  // summaries; the UI fetches full arguments and outputs on demand at L3.
  if (payload?.type === "tool_execution_start") {
    const summarized = summarizeToolArgs(payload.args);
    if (!summarized.omitted) return record;
    return { ...record, payload: { ...payload, args: summarized.args, detailOmitted: true } };
  }
  if (payload?.type === "tool_execution_update") {
    const summarized = summarizeToolPartialResult(payload.partialResult);
    if (!summarized.omitted) return record;
    return {
      ...record,
      payload: { ...payload, partialResult: summarized.partialResult, detailOmitted: true }
    };
  }
  if (payload?.type === "tool_execution_end") {
    const summarizedArgs = "args" in payload ? summarizeToolArgs(payload.args) : undefined;
    const summarizedResult = summarizeToolResult(payload.result, payload.isError === true);
    if (!summarizedArgs?.omitted && !summarizedResult.omitted) return record;
    return {
      ...record,
      payload: {
        ...payload,
        ...(summarizedArgs?.omitted ? { args: summarizedArgs.args } : {}),
        ...(summarizedResult.omitted ? { result: summarizedResult.result } : {}),
        detailOmitted: true
      }
    };
  }
  const message = payload?.message as Record<string, unknown> | undefined;
  // Assistant message_start only marks the message boundary (role/id/timestamp).
  // Pi logs provider/model/usage and sometimes content here, all repeated later.
  if (payload?.type === "message_start" && message?.role === "assistant") {
    if (Object.keys(message).every((key) => ASSISTANT_START_KEYS.has(key))) return record;
    const slim: Record<string, unknown> = { role: "assistant" };
    if ("id" in message) slim.id = message.id;
    if ("timestamp" in message) slim.timestamp = message.timestamp;
    if ("stopReason" in message) slim.stopReason = message.stopReason;
    if ("errorMessage" in message) slim.errorMessage = message.errorMessage;
    return { ...record, payload: { ...payload, message: slim } };
  }
  // The provider's signatures let a later request resume the reasoning, and
  // usage/provider metadata belong to run statistics; bulky toolCall arguments
  // are summarized here too and fetched on demand when L3 expands.
  if (message?.role === "assistant") {
    const content = Array.isArray(message.content)
      ? (message.content as Array<Record<string, unknown>>)
      : undefined;
    let contentChanged = false;
    let nextContent: Array<Record<string, unknown>> | undefined;
    if (content) {
      nextContent = [];
      for (const part of content) {
        let current = part;
        if ("thinkingSignature" in current || "textSignature" in current) {
          const { thinkingSignature: _thinking, textSignature: _text, ...stripped } = current;
          current = stripped;
          contentChanged = true;
        }
        if (current.type === "toolCall" && current.arguments !== undefined) {
          const summarized = summarizeToolArgs(current.arguments);
          if (summarized.omitted) {
            current = { ...current, arguments: summarized.args, detailOmitted: true };
            contentChanged = true;
          }
        }
        nextContent.push(current);
      }
    }
    const hasMeta = ASSISTANT_META_KEYS.some((key) => key in message);
    if (!contentChanged && !hasMeta) return record;
    const nextMessage: Record<string, unknown> = { ...message };
    if (hasMeta) for (const key of ASSISTANT_META_KEYS) delete nextMessage[key];
    if (contentChanged && nextContent) nextMessage.content = nextContent;
    return { ...record, payload: { ...payload, message: nextMessage } };
  }
  if (payload?.type !== "message_start" && payload?.type !== "message_end") return record;
  if (message?.role === "system")
    return { ...record, payload: { ...payload, message: { role: "system", timestamp: message.timestamp } } };
  // A tool result is drawn from its tool_execution_end, which carries it too.
  if (message?.role === "toolResult") {
    const { role, toolCallId, toolName, isError, timestamp } = message;
    return {
      ...record,
      payload: { ...payload, message: { role, toolCallId, toolName, isError, timestamp } }
    };
  }
  // A callback is read from its message_end, the start repeats the report.
  if (payload.type === "message_start" && message?.customType === "formicand-callback") {
    const details = message.details as Record<string, unknown> | undefined;
    const { role, customType, timestamp } = message;
    return {
      ...record,
      payload: {
        ...payload,
        message: {
          role,
          customType,
          timestamp,
          details: { callId: details?.callId, status: details?.status }
        }
      }
    };
  }
  return record;
}
