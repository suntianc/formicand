import { join } from "node:path";
import type { TaskRecord } from "../domain/types.js";
import { readMessageVersions, versionRuntimeEvents } from "../runtime/main-message-edit.js";
import { conversationWindows } from "../runtime/session-handoff.js";
import {
  messagesWithRuntimeHistory,
  readTaskRuntimeEvents,
  readTaskTimingEvents,
  settledRuntimeEvents,
  viewConversationMessage,
  viewRuntimeEvent,
  withPendingMainInput
} from "../runtime/conversation-history.js";
import { mainInputPath, readMainInput } from "../runtime/main-continuation.js";
import { conversationMessages } from "../runtime/conversation-view.js";
import { readJsonFile } from "./event-stream.js";
import {
  historySources,
  recentHistoryRuns,
  recentConversation,
  historyDigest,
  type HistoryWindow
} from "../runtime/conversation-page.js";

async function conversationLifecycle(
  taskWorkspace: string,
  taskId: string,
  currentRunEvents: Record<string, unknown>[],
  selectedRuns?: string[]
) {
  const timingEvents = await readTaskTimingEvents(taskWorkspace, taskId, selectedRuns);
  const recentById = new Map<string, Record<string, unknown>>();
  for (const item of currentRunEvents) {
    if (typeof item.eventId === "string") recentById.set(item.eventId, item);
  }
  const seenIds = new Set<string>();
  const events: Array<Record<string, unknown>> = [];
  for (const item of timingEvents) {
    const id = typeof item.eventId === "string" ? item.eventId : undefined;
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      events.push(recentById.get(id) ?? item);
    } else {
      events.push(item);
    }
  }
  for (const item of currentRunEvents) {
    const id = typeof item.eventId === "string" ? item.eventId : undefined;
    if (id && seenIds.has(id)) continue;
    events.push(item);
  }
  return events;
}

export async function readConversationWindow(
  taskWorkspace: string,
  taskId: string,
  task: TaskRecord,
  messageVersions: Awaited<ReturnType<typeof readMessageVersions>>,
  activeAtStart: boolean,
  currentRunEvents: Record<string, unknown>[],
  window?: HistoryWindow
) {
  const runId = task.activeRunId;
  const sources = window && (await historySources(taskWorkspace, taskId, runId, task.version));
  if (
    window &&
    sources &&
    !activeAtStart &&
    window.stamp === sources.stamp &&
    window.limit === window.previousLimit
  )
    return { historyPage: { mode: "unchanged", stamp: sources.stamp, limit: window.limit } };
  const eligible = sources?.ids.filter((id) => !messageVersions?.excludedRuns.includes(id));
  let selectedRuns: string[] | undefined;
  let records: Record<string, unknown>[];
  if (window && eligible && eligible.length > window.limit) {
    let count = window.limit;
    for (;;) {
      selectedRuns = await recentHistoryRuns(taskWorkspace, taskId, eligible, runId, count, window.oldestRun);
      records = await readTaskRuntimeEvents(taskWorkspace, taskId, selectedRuns, false, window);
      if (selectedRuns.length === eligible.length) break;
      // Maintenance and recovery Runs can end without a user turn. Include older
      // Runs until the window covers the requested number of delivered inputs.
      const inputs = records.filter((record) => {
        if (record.type !== "runtime_event") return true;
        const event = record.payload as { type: string; message?: { role?: string } };
        return event.type === "message_end" && ["user", "custom"].includes(event.message?.role ?? "");
      });
      if (messagesWithRuntimeHistory([], inputs).filter((m) => m.role === "user").length >= window.limit)
        break;
      count = Math.min(eligible.length, count * 2);
    }
  } else {
    selectedRuns = eligible;
    records = await readTaskRuntimeEvents(taskWorkspace, taskId, selectedRuns, false, window);
  }
  const lifecycle = await conversationLifecycle(taskWorkspace, taskId, currentRunEvents, selectedRuns);
  const runtimeEvents = versionRuntimeEvents(records, messageVersions);
  const sessionEntries = await readJsonFile(
    join(taskWorkspace, taskId, "agents", "main", "context", "messages.json"),
    []
  );
  const pendingInput =
    runId && !messageVersions?.excludedRuns.includes(runId)
      ? // eslint-disable-next-line no-restricted-syntax -- 主输入记录可能尚未创建或已损坏，缺失时只按会话历史展示
        await readMainInput(mainInputPath(taskWorkspace, taskId, runId)).catch(() => undefined)
      : undefined;
  const messages = withPendingMainInput(
    messagesWithRuntimeHistory(conversationMessages(sessionEntries), runtimeEvents),
    pendingInput
  );
  const page = window
    ? recentConversation(messages, runtimeEvents, window.limit, window.oldestTime)
    : { messages, records: runtimeEvents, hasEarlier: false };
  const projected = page.messages.map(viewConversationMessage);
  const events = settledRuntimeEvents(page.records).map(viewRuntimeEvent);
  const windows = conversationWindows(sessionEntries);
  if (!window || !sources)
    return { events: lifecycle, messages: projected, runtimeEvents: events, contextWindows: windows };
  const oldestTime = page.messages[0]?.timestamp;
  const hasMore = page.hasEarlier || selectedRuns!.length < eligible!.length;
  const visibleWindows =
    hasMore && oldestTime !== undefined ? windows.filter((entry) => entry.timestamp >= oldestTime) : windows;
  const digest = historyDigest(projected, events);
  const historyPage = {
    oldestTime,
    oldestRun: selectedRuns!.length < eligible!.length ? selectedRuns![0] : undefined,
    stamp: activeAtStart ? undefined : sources.stamp,
    limit: window.limit,
    digest,
    messageCount: projected.length,
    eventCount: events.length,
    hasMore,
    mode: "replace"
  };
  const m = window.messageCount,
    e = window.eventCount;
  if (window.digest && m !== undefined && e !== undefined && m <= projected.length && e <= events.length) {
    const prepend = window.previousLimit !== undefined && window.limit > window.previousLimit;
    const oldMessages = prepend ? projected.slice(projected.length - m) : projected.slice(0, m);
    const oldEvents = prepend ? events.slice(events.length - e) : events.slice(0, e);
    if (historyDigest(oldMessages, oldEvents) === window.digest) {
      return {
        events: lifecycle,
        historyPage: { ...historyPage, mode: prepend ? "prepend" : "append" },
        contextWindows: visibleWindows,
        messages: prepend ? projected.slice(0, projected.length - m) : projected.slice(m),
        runtimeEvents: prepend ? events.slice(0, events.length - e) : events.slice(e)
      };
    }
  }
  return {
    events: lifecycle,
    historyPage,
    messages: projected,
    runtimeEvents: events,
    contextWindows: visibleWindows
  };
}
