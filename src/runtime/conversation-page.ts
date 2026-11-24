import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { conversationRunIds } from "./conversation-history.js";
import type { ConversationMessage } from "./conversation-view.js";

type HistoryEvent = Record<string, unknown>;

/** File identities invalidate idle history even for external writes without a Task revision. */
async function identity(path: string) {
  try {
    const s = await stat(path, { bigint: true });
    return [s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function historySources(
  root: string,
  taskId: string,
  runId: string | undefined,
  version: number
) {
  const task = join(root, taskId);
  const ids = (await conversationRunIds(join(task, "runs"))).sort();
  const paths = ["agents/main/context/messages.json", "sessions/main/versions.json"];
  if (runId) paths.push(join("runs", runId, "main-input.json"));
  const revisions = await Promise.all(
    ids.map(async (id) =>
      Promise.all(
        ["run.json", "run_events.jsonl", "runtime-output.log"].map((name) =>
          identity(join(task, "runs", id, name))
        )
      )
    )
  );
  const stamp = createHash("sha256")
    .update(
      JSON.stringify([
        taskId,
        version,
        ids,
        revisions,
        await Promise.all(paths.map((path) => identity(join(task, path))))
      ])
    )
    .digest("hex");
  return { ids, stamp };
}

/** Sort by the same creation key as full replay. The active Run is always included. */
export async function recentHistoryRuns(
  root: string,
  taskId: string,
  ids: string[],
  active: string | undefined,
  limit: number,
  oldest?: string
) {
  if (ids.length <= limit) return ids;
  const sorted = await Promise.all(
    ids.map(async (id) => {
      let createdAt = "";
      try {
        const data = JSON.parse(await readFile(join(root, taskId, "runs", id, "run.json"), "utf8"));
        createdAt = typeof data.createdAt === "string" ? data.createdAt : "";
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT")
          throw error;
      }
      return { id, createdAt };
    })
  );
  sorted.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const anchor = sorted.findIndex((run) => run.id === oldest);
  let start = Math.max(0, sorted.length - limit);
  // Legacy imports can share or omit creation times. Read tied Runs together;
  // the message timestamps below determine the visible boundary in that case.
  while (start > 0 && sorted[start - 1].createdAt === sorted[start].createdAt) start--;
  const recent = sorted.slice(anchor < 0 ? start : Math.min(start, anchor)).map((run) => run.id);
  if (active && ids.includes(active) && !recent.includes(active)) recent.push(active);
  return recent;
}

function eventTime(record: HistoryEvent): number | undefined {
  const payload = record.payload as { message?: { timestamp?: unknown } } | undefined;
  const time = payload?.message?.timestamp;
  if (typeof time === "number") return time;
  const text = typeof time === "string" ? time : record.occurredAt;
  if (typeof text === "string") {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** A resident Run can contain many user turns. Keep untimed activity with the turn that produced it. */
export function recentConversation(
  messages: ConversationMessage[],
  records: HistoryEvent[],
  limit: number,
  oldest?: number
) {
  let users = 0,
    start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    if (++users === limit) start = i;
  }
  if (users <= limit) return { messages, records, hasEarlier: false };
  if (oldest) {
    const anchor = messages.findIndex((m) => m.timestamp !== undefined && m.timestamp >= oldest);
    if (anchor >= 0) start = Math.min(start, anchor);
  }
  while (start > 0 && messages[start - 1].timestamp === messages[start].timestamp) start--;
  if (start === 0) return { messages, records, hasEarlier: false };
  const cutoff = messages[start].timestamp;
  if (typeof cutoff !== "number") return { messages, records, hasEarlier: false };
  // Each Run's leading events belong with its first message. Keep an undated Run intact.
  const first = new Map<unknown, number>(),
    older = new Set<unknown>();
  records.forEach((record, index) => {
    if (record.type !== "runtime_event") return;
    const time = eventTime(record);
    if (time === undefined) return;
    if (time < cutoff) older.add(record.runId);
    else if (!first.has(record.runId)) first.set(record.runId, index);
  });
  return {
    messages: messages.slice(start),
    records: records.filter((record, index) => {
      if (record.type !== "runtime_event") return (eventTime(record) ?? cutoff) >= cutoff;
      return !older.has(record.runId) || index >= (first.get(record.runId) ?? Infinity);
    }),
    hasEarlier: true
  };
}

export function historyDigest(messages: unknown[], records: unknown[]) {
  const h = createHash("sha256");
  for (const group of [messages, records]) {
    h.update(String(group.length) + ":");
    for (const item of group) h.update(JSON.stringify(item)).update("\n");
  }
  return h.digest("hex");
}

export interface HistoryWindow {
  limit: number;
  stamp?: string;
  previousLimit?: number;
  messageCount?: number;
  eventCount?: number;
  digest?: string;
  oldestRun?: string;
  oldestTime?: number;
  metadataRevision?: string;
}
