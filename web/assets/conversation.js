import { outstandingWork } from "./tool-lifecycle.js";

const messageText = (message) =>
  typeof message?.content === "string"
    ? message.content
    : (message?.content || []).map((part) => part?.text || "").join("");

/**
 * The turn a supervisor wakes Main with, mirrored from the runtime.
 *
 * Pi needs a turn to start running, so a relaunch has to say something. It is
 * machinery, not a person talking, and showing it made the transcript read as
 * though the user had typed "Resume this task from its durable state…" right
 * after answering a question.
 *
 * `src/runtime/main-supervisor.ts` holds the runtime's copy and must match.
 */
export const SUPERVISOR_WAKE_TURN =
  "Resume this task from its durable state: consume the pending Inbox messages and continue.";

/**
 * Whether a turn is the harness talking to itself rather than to the person.
 *
 * These reach the model as ordinary user turns because that is the only way to
 * start one, but the transcript is a record of the conversation, and nobody
 * said this.
 */
export function isMachineTurn(message) {
  return message?.role === "user" && messageText(message).trim() === SUPERVISOR_WAKE_TURN;
}

/** The control message Pi records when Main continues a saved turn instead of a new message. */
const isContinuation = (message) =>
  message?.role === "custom" && message.customType === "atria-main-continuation";

export function finalAnswerIndex(messages, detail, isCurrent = true) {
  const task = detail?.task || {};
  const coordination = detail?.coordination || {};
  if (
    isCurrent &&
    (detail?.runtime?.active ||
      task.status !== "completed" ||
      coordination.pending?.length ||
      coordination.callbackPending?.length ||
      Object.values(outstandingWork(detail)).some((count) => count > 0))
  )
    return -1;
  const index = messages.findLastIndex((message) => message.role === "assistant");
  const last = messages[index];
  return last &&
    !["toolUse", "error", "aborted", "length"].includes(last.stopReason) &&
    messageText(last).trim()
    ? index
    : -1;
}

/** Each request keeps its own terminal state, even after the task is resumed. */
export function exchangeExecutionState(events = []) {
  let terminal, retry, stopped;
  for (const record of events) {
    const event = record?.type === "runtime_event" ? record.payload : record;
    // The person stopped this round; whatever settles after it, it stays stopped.
    if (event?.type === "main.run_stopped" && event.payload?.reason === "ui_stop")
      stopped = { subagents: Number(event.payload.subagents) || 0 };
    if (event?.type === "auto_retry_start") retry = event;
    if (event?.type === "auto_retry_end") retry = undefined;
    if (/^main\.run_(completed|failed|paused|waiting|cancelled)$/.test(event?.type || "")) {
      terminal = event.type.slice("main.run_".length);
      retry = undefined;
    }
  }
  return { terminal, retry, stopped };
}

// Split activity at user input's actual context position, including steering
// within a run. Earlier thinking/tools stay above the instruction they preceded.
export function buildConversationExchanges(messages, events) {
  const exchanges = [];
  // A supervisor wake-up is not a request, so it must not open an exchange:
  // doing so split CoworkOS's reply away from the message it was answering and
  // printed the harness's own instruction above it.
  for (const message of (messages || []).filter(
    (entry) => !isMachineTurn(entry) && !(entry.delivery === "followUp" && entry.pending)
  )) {
    if (message.role === "user" || !exchanges.length)
      exchanges.push({ user: message.role === "user" ? message : null, messages: [], events: [] });
    exchanges.at(-1).messages.push(message);
  }
  // Preserve first-unmatched fallback semantics without scanning every exchange.
  const index = (keyOf) => {
    const entries = new Map();
    for (const exchange of exchanges) {
      const key = keyOf(exchange);
      if (key === undefined || key === null) continue;
      const bucket = entries.get(key) || { entries: [], cursor: 0 };
      bucket.entries.push(exchange);
      entries.set(key, bucket);
    }
    return entries;
  };
  const byId = index((entry) => entry.user?.id);
  const byTimestamp = index((entry) => entry.user?.timestamp);
  let byText;
  const groupedIds = new Set();
  const groupedTimestamps = new Set();
  const groups = [];
  let group;
  let prelude = [];
  let pendingRun = null;
  const followingExchange = (user) => {
    const index = exchanges.findIndex(
      (exchange) =>
        exchange.user &&
        (user.id && exchange.user.id
          ? exchange.user.id === user.id
          : exchange.user.timestamp === user.timestamp)
    );
    return index < 0 ? undefined : exchanges.slice(index + 1).find((exchange) => exchange.user);
  };
  const flushPendingRun = () => {
    if (!pendingRun) return;
    if (group) group.events.push(...pendingRun.events);
    else prelude.push(...pendingRun.events);
    pendingRun = null;
  };
  for (const record of events || []) {
    const event = record?.type === "runtime_event" ? record.payload : record;
    const incoming = event?.message;
    const userMessage =
      incoming?.role === "custom" && incoming.customType === "cowork-user-message"
        ? {
            role: "user",
            id: incoming.details?._coworkInbox?.messageId,
            content: incoming.details?.message,
            timestamp: incoming.timestamp
          }
        : incoming;
    // A message edit relaunches Main on a session that already holds the
    // edited message, so its Run starts with a continuation instead of that
    // message. The Run answers the request after the one in progress, not the
    // one above it.
    if (event?.type === "message_start" && isContinuation(incoming) && group) {
      const next = followingExchange(group.user);
      const grouped =
        next &&
        (next.user.id !== undefined
          ? groupedIds.has(next.user.id)
          : groupedTimestamps.has(next.user.timestamp));
      if (next && !grouped) {
        if (pendingRun && pendingRun.runId !== record?.runId) flushPendingRun();
        group = { user: next.user, runId: record?.runId, events: pendingRun ? pendingRun.events : [] };
        pendingRun = null;
        groups.push(group);
        groupedIds.add(next.user.id);
        groupedTimestamps.add(next.user.timestamp);
      }
    }
    if (userMessage?.role === "user" && ["message_start", "message_end"].includes(event.type)) {
      // A supervisor wake-up opens no exchange, so its activity belongs to the
      // exchange already in progress rather than to a group with no request.
      if (isMachineTurn(userMessage)) {
        flushPendingRun();
        if (group) {
          if (record?.runId) group.runId = record.runId;
          group.events.push(record);
        } else prelude.push(record);
        continue;
      }
      // Pi emits both start and end for the same user message.
      const sameUser =
        group?.user &&
        (userMessage.id && group.user.id
          ? group.user.id === userMessage.id
          : userMessage.timestamp !== undefined
            ? group.user.timestamp === userMessage.timestamp
            : messageText(group.user) === messageText(userMessage));
      if (event.type === "message_start" || !sameUser) {
        const leading = pendingRun ? [...prelude, ...pendingRun.events] : prelude;
        group = { user: userMessage, runId: record?.runId, events: leading };
        prelude = [];
        pendingRun = null;
        groups.push(group);
        groupedIds.add(userMessage.id);
        groupedTimestamps.add(userMessage.timestamp);
      }
    }
    if (group) {
      if (record?.runId && group.runId && record.runId !== group.runId) {
        // A new Run starts with startup events (agent_start, turn_start, system)
        // before its first user turn. Hold them until we see whether the new Run
        // opens a fresh user exchange or continues the current one (retry/wake),
        // so the previous Run's exchange never inherits the next Run's runId.
        const continuesCurrent =
          (incoming?.role === "assistant" && ["message_start", "message_end"].includes(event?.type)) ||
          event?.type === "message_update" ||
          event?.type === "tool_execution_start" ||
          event?.type === "tool_execution_end";
        if (continuesCurrent) {
          flushPendingRun();
          group.runId = record.runId;
          group.events.push(record);
        } else {
          if (pendingRun && pendingRun.runId !== record.runId) flushPendingRun();
          pendingRun ??= { runId: record.runId, events: [] };
          pendingRun.events.push(record);
        }
      } else {
        if (pendingRun) flushPendingRun();
        if (record?.runId && !group.runId) group.runId = record.runId;
        group.events.push(record);
      }
    } else prelude.push(record);
  }
  flushPendingRun();
  const matched = new Set();
  const take = (lookup, key) => {
    const bucket = lookup.get(key);
    if (!bucket) return;
    while (bucket.cursor < bucket.entries.length && matched.has(bucket.entries[bucket.cursor]))
      bucket.cursor++;
    return bucket.entries[bucket.cursor];
  };
  for (const current of groups) {
    let exchange = current.user.id ? take(byId, current.user.id) : undefined;
    exchange ||= current.user.timestamp !== undefined ? take(byTimestamp, current.user.timestamp) : undefined;
    if (!exchange) {
      byText ||= index((entry) => (entry.user ? messageText(entry.user) : undefined));
      exchange = take(byText, messageText(current.user));
    }
    if (exchange) {
      exchange.events.push(...current.events);
      matched.add(exchange);
    }
  }
  // Older fixtures/logs may not include user message events. Assign those
  // events to the most recent persisted request, never a new optimistic one.
  if (!groups.length && prelude.length) {
    const exchange = exchanges.findLast((entry) => !entry.user?.taskId);
    if (exchange) exchange.events = prelude;
  }
  const awaitingDelivery = (exchange) =>
    Boolean(exchange?.user?.interjected) &&
    !matched.has(exchange) &&
    !exchange.messages.some((message) => message.role === "assistant");
  return exchanges.map((exchange, index) => ({
    ...exchange,
    awaitingDelivery: awaitingDelivery(exchange),
    continued:
      Boolean(exchanges[index + 1]?.user?.interjected) &&
      !awaitingDelivery(exchanges[index + 1]) &&
      !exchangeExecutionState(exchange.events).terminal,
    key: String(
      (exchange.user?.interjected ? exchange.user.id : undefined) ??
        exchange.user?.timestamp ??
        exchange.user?.id ??
        `position:${index}`
    ),
    events: exchange.events.length
      ? exchange.events
      : exchange.messages
          .filter((message) => message.role === "assistant")
          .flatMap((message) => [
            { type: "turn_start" },
            { type: "message_start", message },
            { type: "message_end", message },
            { type: "turn_end", message }
          ])
  }));
}

/**
 * Group exchanges that belong to one continuous work round: when a user steers
 * or follows up before the previous exchange settles into a final answer (and
 * the previous exchange was not stopped, cancelled or failed), they share one
 * round so L0 collapses the entire round under a single summary while keeping
 * every user bubble visible and interleaved in chronological order when opened.
 */
export function groupConversationRounds(exchanges, detail, currentExchangeIndex, windowDividers) {
  const rounds = [];
  for (let index = 0; index < exchanges.length; index += 1) {
    const exchange = exchanges[index];
    const current = rounds.at(-1);
    const hasLeadingDivider =
      windowDividers &&
      exchange.messages.some((message) => message.role === "user" && windowDividers.has(message));
    if (current && !hasLeadingDivider) {
      const prev = current.exchanges.at(-1);
      const prevExec = exchangeExecutionState(prev.events);
      const prevStopped = prevExec.stopped ?? (prevExec.terminal === "cancelled" ? {} : undefined);
      const prevBlocked =
        prev.awaitingDelivery || Boolean(prevStopped) || ["cancelled", "failed"].includes(prevExec.terminal);
      const prevFinal = prevBlocked || prev.continued ? -1 : finalAnswerIndex(prev.messages, detail, false);
      if (!prevBlocked && prevFinal < 0) {
        current.exchanges.push(exchange);
        current.indices.push(index);
        current.endIndex = index;
        continue;
      }
    }
    rounds.push({
      key: exchange.key,
      startIndex: index,
      endIndex: index,
      indices: [index],
      exchanges: [exchange]
    });
  }
  return rounds.map((round) => {
    const tail = round.exchanges.at(-1);
    const isCurrent = round.indices.includes(currentExchangeIndex);
    const events =
      round.exchanges.length === 1 ? tail.events : round.exchanges.flatMap((entry) => entry.events);
    return { ...round, lead: round.exchanges[0], tail, isCurrent, events };
  });
}

/** The position of a runtime event in its run's log, from its event id. */
export function runtimeLogIndex(record) {
  if (record?.type !== "runtime_event" || typeof record.eventId !== "string") return undefined;
  const prefix = `runtime-${record.runId}-`;
  if (!record.eventId.startsWith(prefix)) return undefined;
  const index = Number(record.eventId.slice(prefix.length));
  return Number.isSafeInteger(index) ? index : undefined;
}

/** The last log position each run's saved history covers. */
export function runtimeLogMarks(records = []) {
  const marks = new Map();
  for (const record of records) {
    const index = runtimeLogIndex(record);
    if (index !== undefined && index > (marks.get(record.runId) ?? -1)) marks.set(record.runId, index);
  }
  return marks;
}

/** Apply a live park or wake to the detail snapshot, including SSE that raced its read. */
export function applyMainParkEvent(detail, record) {
  if (record.type !== "runtime_event" || record.runId !== detail.task.activeRunId) return false;
  const event = record.payload;
  if (
    event.type === "tool_execution_end" &&
    event.toolName === "sleep_until" &&
    !event.isError &&
    event.result?.details?.parked === true
  ) {
    const { wakeAt, reason } = event.result.details;
    detail.parked = { wakeAt, reason };
    return true;
  }
  if (detail.parked && event.type === "turn_start") {
    delete detail.parked;
    return true;
  }
  return false;
}

export function streamRecordKey(record) {
  if (!record || typeof record !== "object") return "";
  if (record.eventId) return `${record.runId || ""}:${record.eventId}`;
  if (record.type === "runtime_event" && record.payload && typeof record.payload === "object")
    return `runtime:${JSON.stringify(record.payload)}`;
  return `runtime:${JSON.stringify(record)}`;
}

/**
 * The ledger events a saved history carries (`readTaskRuntimeEvents`). The
 * stream also sends the others, such as a pause and its resume, while they
 * happen; a saved history never has them, so they are not news it missed.
 */
const SAVED_LEDGER =
  /^(?:user\.(?:interjected|message_promoted|message_cancelled)|inbox\.consumed|main\.run_(?:completed|failed|waiting|cancelled|stopped))$/;
const savedKind = (record) => record?.type === "runtime_event" || SAVED_LEDGER.test(record?.type || "");

// SSE and detail polling can complete in either order. Preserve events that
// arrived after the detail request started, while accepting its saved history.
// A streamed event of a kind the history never saves is left out: appended
// after that history it would land after everything since, so a pause the
// round was resumed from read as the round's last word and the finished
// round stayed unfolded until the conversation was reopened.
export function mergeRuntimeEvents(saved = [], streamed = []) {
  const keys = new Set(saved.map(streamRecordKey));
  const covered = runtimeLogMarks(saved);
  return [
    ...saved,
    ...streamed.filter((record) => {
      if (!savedKind(record)) return false;
      // A saved history leaves out the deltas of messages that have ended; a
      // streamed delta it no longer lists is covered, not missing.
      const index = runtimeLogIndex(record);
      if (index !== undefined && index <= (covered.get(record.runId) ?? -1)) return false;
      const key = streamRecordKey(record);
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    })
  ];
}
