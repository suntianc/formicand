import type { CompactionEntryDraft, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { historyUserText } from "./session-history.js";
import { readSessionNotes, sessionNotesPath } from "./session-notes.js";
import { HANDOFF_INTRO } from "./session-summary.js";
import { truncateToolText } from "./tool-output.js";
import { DurableScheduler } from "./scheduler.js";
import { workItemUnsettled } from "./subagent-work.js";
import { HumanRequestStore } from "./human.js";
import { SubagentQuestionStore } from "./subagent-questions.js";

export const CONTEXT_CAPACITY_NOTICE = "formicand-context-capacity";
export const CONTEXT_WINDOW_REQUEST = "formicand-context-window-request";
export const MAX_HANDOFF_CHARS = 60_000;
const MAX_EMERGENCY_CHARS = 6_000;
/**
 * The most each recorded section may take of the page. A section shorter than
 * its share leaves the rest to the user's messages, which fill what remains.
 */
const SHARES = { summary: 0.4, development: 0.1, work: 0.1, notes: 0.2 };
const MAX_NOTES_CHARS = 8_000;

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
  kind: "formicand-context-window";
  reason: "manual" | "threshold" | "overflow";
  requestId?: string;
}

export function windowDetails(details: unknown): WindowDetails | undefined {
  if (!details || typeof details !== "object") return;
  const { kind, reason, requestId } = details as Partial<WindowDetails>;
  if (
    kind === "formicand-context-window" &&
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
    const { id, timestamp } = entry;
    if (typeof id !== "string" || typeof timestamp !== "string") return [];
    return [{ id, timestamp: Date.parse(timestamp) }];
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

/**
 * The user's messages, newest first and each whole, as many as fit. Older
 * ones are counted, not cut, so the recent sequence reads intact. A newest
 * message too long for the page is named by its entry instead.
 */
function userMessages(entries: readonly SessionEntry[], budget: number): string {
  const users = entries.flatMap((entry) => {
    const text = historyUserText(entry);
    return text === undefined ? [] : [{ id: entry.id, text }];
  });
  const lines: string[] = [];
  let remaining = budget - 60;
  let shown = 0;
  for (let i = users.length - 1; i >= 0; i--) {
    const { id, text } = users[i];
    let line = `User #${i + 1}\n${text}`;
    if (line.length + 2 > remaining && !lines.length)
      line = `User #${i + 1} (entry ${id}, ${text.length} characters) is too long to show here.`;
    if (line.length + 2 > remaining) break;
    lines.unshift(line);
    remaining -= line.length + 2;
    shown++;
  }
  const hidden = users.length - shown;
  if (hidden) lines.unshift(`${hidden} earlier user message${hidden === 1 ? " is" : "s are"} not shown.`);
  return lines.join("\n\n");
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
  /** The model's summary of the window being left; absent when none could be written. */
  summary?: string;
}): Promise<CompactionEntryDraft> {
  const { session, entries, scope, reason, firstKeptEntryId, requestId, summary } = input;
  const emergency = reason === "overflow";
  const capacity = input.contextWindow ?? MAX_HANDOFF_CHARS;
  const budget = emergency
    ? Math.max(512, Math.min(MAX_EMERGENCY_CHARS, Math.floor(capacity / 4)))
    : Math.max(512, Math.min(MAX_HANDOFF_CHARS, capacity));
  const unavailable = (label: string, error: unknown) => {
    console.warn(
      `[Formicand] Context handoff could not read ${label}:`,
      error instanceof Error ? error.message : String(error)
    );
  };
  const [notes, work, development] = await Promise.all([
    readSessionNotes(sessionNotesPath(session)).catch((error: unknown) => {
      unavailable("session notes", error);
      return "Session notes unavailable.";
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
  const title = `# Context window handoff\n\n${HANDOFF_INTRO}`;
  const available = budget - title.length;
  const share = (part: keyof typeof SHARES) => Math.floor(available * SHARES[part]);
  const summaryText = emergency
    ? ""
    : (summary ??
      "No summary could be written for this window; rely on the records below and the session history.");
  const sections = [
    section("Summary", summaryText, share("summary")),
    section("Development progress", progress, share("development")),
    section("In progress", work.join("\n"), share("work")),
    section("Session notes", notes, Math.min(MAX_NOTES_CHARS, share("notes")))
  ].join("");
  const users = section("User messages", userMessages(entries, available - sections.length), Infinity);
  const details: WindowDetails = {
    kind: "formicand-context-window",
    reason,
    ...(requestId && { requestId })
  };
  return { type: "compaction", summary: title + sections + users, firstKeptEntryId, details };
}
