import { ui } from "./ui/language.js";
// A Run starts with its process, and a resident Main starts each later turn
// when a message is delivered to it.
const STARTS = new Set(["main.run_spawned", "main.turn_delivered"]);
const STOPS = new Set(["main.run_completed", "main.run_failed", "main.run_paused", "main.run_waiting"]);

function ledgerTime(value) {
  // Ledger timestamps carry a timezone. Do not let Date.parse turn a budget,
  // numeric string or local calendar date into an apparent execution time.
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** When the runtime stamped an event of this exchange, if it did. */
function eventTime(record) {
  const event = record?.type === "runtime_event" ? record.payload : record;
  const time = event?.message?.timestamp ?? event?.timestamp;
  return typeof time === "number" && Number.isFinite(time) ? time : undefined;
}

/**
 * Sum the closed execution intervals of the runs present in an exchange.
 *
 * A resident Main runs several exchanges in one Run, one interval each, so an
 * exchange counts only the intervals its own events fall in; the length still
 * comes from the ledger boundaries, never from those event times. Events
 * without times (older logs) count every interval of their runs. Missing or
 * ambiguous ledger boundaries mean unknown, never an estimated time.
 */
export function executionElapsedMs(runtimeEvents, lifecycleEvents) {
  if (!Array.isArray(runtimeEvents) || !Array.isArray(lifecycleEvents)) return null;
  const runs = new Map();
  for (const record of runtimeEvents) {
    if (typeof record?.runId !== "string" || !record.runId.trim()) continue;
    const run = runs.get(record.runId) ?? { boundaries: [], times: [] };
    runs.set(record.runId, run);
    const time = eventTime(record);
    if (time !== undefined) run.times.push(time);
  }
  if (!runs.size) return null;

  for (const event of lifecycleEvents) {
    const start = STARTS.has(event?.type);
    if (!runs.has(event?.runId) || (!start && !STOPS.has(event.type))) continue;
    // A message queued while paused starts nothing until the Run resumes.
    if (event.payload?.queuedWhilePaused) continue;
    const time = ledgerTime(event.occurredAt);
    if (time === null) return null;
    runs.get(event.runId).boundaries.push({ time, start });
  }

  let elapsed = 0;
  for (const { boundaries, times } of runs.values()) {
    if (!boundaries.length) return null;
    // Polling and SSE replay may repeat a boundary or return ledger files in a
    // different order. A repeated finalizer does not open another interval.
    boundaries.sort((a, b) => a.time - b.time || Number(b.start) - Number(a.start));
    const seen = new Set();
    const intervals = [];
    let started = null;
    for (const boundary of boundaries) {
      const key = `${boundary.start}:${boundary.time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (boundary.start) {
        if (started !== null) return null;
        started = boundary.time;
      } else if (started !== null) {
        intervals.push([started, boundary.time]);
        started = null;
      } else if (!intervals.length) {
        return null;
      }
    }
    if (started !== null || !intervals.length) return null;
    const own = times.length
      ? intervals.filter(([from, to]) => times.some((time) => time >= from && time <= to))
      : intervals;
    if (!own.length) return null;
    for (const [from, to] of own) elapsed += to - from;
  }
  return Number.isFinite(elapsed) ? elapsed : null;
}

/** Whole seconds, without implying precision the display does not provide. */
export function formatExecutionDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours) parts.push(ui`${hours} 小时`);
  if (minutes) parts.push(ui`${minutes} 分钟`);
  if (seconds || !parts.length) parts.push(ui`${seconds} 秒`);
  return parts.join(" ");
}
