import type { CompactionEntryDraft, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { historyUserText } from "./session-history.js";
import { readSessionNotes, sessionNotesPath } from "./session-notes.js";
import { truncateToolText } from "./tool-output.js";
import { DurableScheduler } from "./scheduler.js";
import { workItemUnsettled } from "./subagent-work.js";
import { HumanRequestStore } from "./human.js";
import { SubagentQuestionStore } from "./subagent-questions.js";

export const CONTEXT_CAPACITY_NOTICE = "cowork-context-capacity";
export const CONTEXT_WINDOW_REQUEST = "cowork-context-window-request";
export const MAX_HANDOFF_CHARS = 30_000;
const MAX_NOTES_CHARS = 8_000;
const MAX_EMERGENCY_CHARS = 6_000;
const RECENT_FILES = 16;
const FILE_TOOLS = new Set(["read", "edit", "write", "apply_patch"]);
const CONTINUE =
  "This is a new context window. Use search_history and read_history to retrieve the original conversation. Continue the work using the records below.";

type SessionMessage = ReturnType<
  ExtensionContext["sessionManager"]["buildSessionProjection"]
>["messages"][number];

const RECENT_TOKENS = 2_000;
const RECENT_ENTRIES = 8;

export function recentContextTail(
  projection: ReturnType<ExtensionContext["sessionManager"]["buildSessionProjection"]>,
  estimateTokens: (message: SessionMessage) => number,
  window: number | undefined
): string | null {
  let firstKeptEntryId: string | null = null;
  let tokens = 0;
  let count = 0;
  const maxTokens = Math.min(RECENT_TOKENS, Math.floor((window ?? 20_000) * 0.1));
  for (const { sourceEntry, messages } of [...projection.entries].reverse()) {
    if (sourceEntry.type === "compaction") break;
    if (sourceEntry.type === "custom_message" && sourceEntry.customType === CONTEXT_CAPACITY_NOTICE) break;
    const visible = messages.filter((message) => message.role !== "system");
    if (!visible.length) continue;
    tokens += visible.reduce((total, message) => total + estimateTokens(message), 0);
    count++;
    if (tokens > maxTokens || count > RECENT_ENTRIES) break;
    // Cut only before a user or assistant. Retaining an assistant's tool call
    // also retains its result, and a tool result can never start the tail.
    if (visible.some((message) => message.role === "user" || message.role === "assistant"))
      firstKeptEntryId = sourceEntry.id;
  }
  return firstKeptEntryId;
}

export interface WindowDevelopment {
  developmentId: string;
  goal: string;
  completionCriteria: string[];
  route: string;
  tickets: { ticketId: string; title: string; state: string }[];
  next: string;
}

export interface HandoffScope {
  workspaceRoot: string;
  taskId: string;
  runId?: string;
  /** Delegated sessions see the questions for their own call. */
  callId?: string;
  readDevelopment?: (signal?: AbortSignal) => Promise<WindowDevelopment | undefined>;
}

export interface WindowDetails {
  kind: "cowork-context-window";
  reason: "manual" | "threshold" | "overflow";
  requestId?: string;
}

export function windowDetails(details: unknown): WindowDetails | undefined {
  if (!details || typeof details !== "object") return;
  const { kind, reason, requestId } = details as Partial<WindowDetails>;
  if (
    kind === "cowork-context-window" &&
    (reason === "manual" || reason === "threshold" || reason === "overflow")
  )
    return { kind, reason, ...(typeof requestId === "string" ? { requestId } : {}) };
}

export function latestWindow(entries: readonly SessionEntry[]) {
  return entries.filter((entry) => entry.type === "compaction").at(-1);
}

export function conversationWindows(entries: unknown) {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || entry.type !== "compaction" || !windowDetails(entry.details)) return [];
    const { id, summary, timestamp } = entry;
    if (typeof id !== "string" || typeof summary !== "string" || typeof timestamp !== "string") return [];
    return [{ id, summary, timestamp: Date.parse(timestamp) }];
  });
}

async function pendingWork({ callId, workspaceRoot, taskId, runId }: HandoffScope) {
  if (!runId) return [];
  const questions = await new SubagentQuestionStore(workspaceRoot).list(taskId, "pending");
  const unresolved = questions.filter(
    (question) => question.runId === runId && (!callId || question.callId === callId)
  );
  const lines = unresolved.map(
    ({ questionId, agentName, question }) =>
      `- Unanswered question ${questionId} from ${agentName}: ${question}`
  );
  if (callId) return lines;
  const queue = new DurableScheduler(join(workspaceRoot, taskId, "runs", runId, "queue.json"));
  const [items, human] = await Promise.all([
    queue.list(),
    new HumanRequestStore(workspaceRoot).list(taskId, "pending")
  ]);
  return [
    ...items.filter(workItemUnsettled).map(({ agentId, stepId, payload, createdAt, status }) => {
      const task = (payload as { task?: unknown } | undefined)?.task;
      return `- ${agentId} (${stepId}, ${status}, dispatched ${createdAt})${typeof task === "string" ? `: ${task}` : ""}`;
    }),
    ...human
      .filter((request) => request.runId === runId)
      .map(({ requestId, question }) => `- Unanswered user question ${requestId}: ${question}`),
    ...lines
  ];
}

function recentFiles(entries: readonly SessionEntry[]): string[] {
  const paths = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const call of [...entry.message.content].reverse()) {
      if (call.type !== "toolCall" || !FILE_TOOLS.has(call.name)) continue;
      const path = call.arguments.path ?? call.arguments.file_path;
      if (typeof path === "string") paths.add(path);
      if (paths.size >= RECENT_FILES) return [...paths];
    }
  }
  return [...paths];
}

function userMessages(entries: readonly SessionEntry[], budget: number): string {
  const users = entries.flatMap((entry) => {
    const text = historyUserText(entry);
    return text === undefined ? [] : [{ id: entry.id, text }];
  });
  const lines: string[] = [];
  // Leave space to list a range of older IDs if they cannot all be spelled out.
  let remaining = budget - Math.min(100, Math.floor(budget / 2));
  let preserveVerbatim = true;
  for (let i = users.length - 1; i >= 0; i--) {
    const { id, text } = users[i];
    const label = `User #${i + 1} (entry ${id})`;
    const reference = `${label}: use read_history.`;
    if (reference.length + 2 > remaining) {
      lines.push(`User messages #1–#${i + 1}: use search_history with role user to find entry IDs.`);
      break;
    }
    // Once a message is replaced by a reference, only the newer messages
    // remain verbatim. This keeps the recent sequence intact.
    const quote: boolean = preserveVerbatim && text.length + label.length + 3 <= remaining;
    preserveVerbatim = quote;
    const line = quote ? `${label}\n${text}` : reference;
    lines.push(line);
    remaining -= line.length + 2;
  }
  return truncateToolText(lines.reverse().join("\n\n"), Math.max(0, budget));
}

function section(heading: string, text: string, limit: number): string {
  const label = `\n\n## ${heading}\n`;
  if (!text || limit <= label.length) return "";
  return label + truncateToolText(text, limit - label.length);
}

export async function sessionHandoff(input: {
  session: ExtensionContext["sessionManager"];
  entries: readonly SessionEntry[];
  scope: HandoffScope;
  contextWindow?: number;
  reason: WindowDetails["reason"];
  firstKeptEntryId: string | null;
  requestId?: string;
}): Promise<CompactionEntryDraft> {
  const { session, entries, scope, reason, firstKeptEntryId, requestId } = input;
  const emergency = reason === "overflow";
  const capacity = input.contextWindow ?? MAX_HANDOFF_CHARS;
  const budget = emergency
    ? Math.max(512, Math.min(MAX_EMERGENCY_CHARS, Math.floor(capacity / 4)))
    : Math.max(512, Math.min(MAX_HANDOFF_CHARS, capacity));
  const unavailable = (label: string, error: unknown) => {
    console.warn(
      `[CoworkOS] Context handoff could not read ${label}:`,
      error instanceof Error ? error.message : String(error)
    );
  };
  const [notes, work, development] = await Promise.all([
    readSessionNotes(sessionNotesPath(session)).catch((error: unknown) => {
      unavailable("session notes", error);
      return "Session notes unavailable; use session_notes to retry.";
    }),
    pendingWork(scope).catch((error: unknown) => {
      unavailable("pending work", error);
      return ["Pending work records unavailable."];
    }),
    scope.readDevelopment?.(AbortSignal.timeout(emergency ? 500 : 3_000)).catch((error: unknown) => {
      unavailable("development", error);
      return undefined;
    })
  ]);
  const progress = development
    ? [
        `Development ${development.developmentId}`,
        `Goal: ${development.goal}`,
        `Completion criteria: ${development.completionCriteria.join("; ")}`,
        `Route: ${development.route}`,
        `Next: ${development.next}`,
        ...development.tickets.map(({ ticketId, state, title }) => `- ${ticketId} [${state}] ${title}`)
      ].join("\n")
    : "";
  const title = "# Context window handoff\n\n## User messages\n";
  const footer = `\n\n${CONTINUE}`;
  const available = budget - title.length - footer.length;
  const notesBudget = Math.min(MAX_NOTES_CHARS, Math.floor(available * 0.27));
  const notesNotice = "\nAdditional notes available in session_notes. Shorten them for the next window.";
  const previewNotes =
    notes.length > notesBudget
      ? notes.slice(0, Math.max(0, notesBudget - notesNotice.length)).replace(/[\uD800-\uDBFF]$/u, "") +
        notesNotice
      : notes;
  const sections = [
    section("Development progress", progress, Math.floor(available * 0.22)),
    section("In progress", work.join("\n"), Math.floor(available * 0.17)),
    section("Session notes", previewNotes, notesBudget + "Session notes".length + 6),
    section(
      "Recent files",
      recentFiles(entries)
        .map((path) => `- ${path}`)
        .join("\n"),
      Math.floor(available * 0.08)
    )
  ].join("");
  const summary = title + userMessages(entries, available - sections.length) + sections + footer;
  const details: WindowDetails = { kind: "cowork-context-window", reason, ...(requestId && { requestId }) };
  return { type: "compaction", summary, firstKeptEntryId, details };
}
