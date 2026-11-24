import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { RuntimeLogPositions, runtimeLogEvents } from "./runtime-output.js";
import { conversationMessages } from "./conversation-view.js";

interface Boundary {
  offset: number;
  index: number;
  time: number;
}
interface Index {
  key: string;
  boundaries: Boundary[];
}
const indexes = new Map<string, Index>();
const MAX_BOUNDARIES = 1024;

/** Absolute byte offsets and event ordinals let a suffix keep the same SSE identities as full replay. */
async function indexTurns(handle: FileHandle, size: number): Promise<Boundary[]> {
  const positions = new RuntimeLogPositions();
  const boundaries: Boundary[] = [];
  let offset = 0;
  let fragments: Buffer[] = [];
  let lastTime = -Infinity;
  function line(bytes: Buffer) {
    const index = positions.next;
    const entries = positions.read(bytes.toString("utf8"));
    for (const { event } of entries) {
      if (event.type !== "message_start" && event.type !== "message_end") continue;
      const message = event.message as { role?: string } | undefined;
      if (message?.role !== "user" && message?.role !== "custom") continue;
      const user = conversationMessages([message]).at(0);
      if (user?.role !== "user") continue;
      const time = user.timestamp;
      if (typeof time !== "number" || !Number.isFinite(time) || time < lastTime) {
        // An out-of-order legacy log cannot be trimmed by time.
        lastTime = Infinity;
        boundaries.length = 0;
        continue;
      }
      if (lastTime === time) continue;
      lastTime = time;
      boundaries.push({ offset, index, time });
      if (boundaries.length === 2 * MAX_BOUNDARIES) boundaries.splice(0, MAX_BOUNDARIES);
    }
    offset += bytes.length + 1;
  }
  for await (const chunk of handle.createReadStream({ start: 0, end: size - 1, autoClose: false })) {
    const bytes = chunk as Buffer;
    let from = 0;
    for (let nl = bytes.indexOf(10); nl >= 0; nl = bytes.indexOf(10, from)) {
      const part = bytes.subarray(from, nl);
      if (fragments.length) {
        fragments.push(part);
        line(Buffer.concat(fragments));
        fragments = [];
      } else {
        line(part);
      }
      from = nl + 1;
    }
    if (from < bytes.length) fragments.push(bytes.subarray(from));
  }
  if (fragments.length) line(Buffer.concat(fragments));
  return boundaries.slice(-MAX_BOUNDARIES);
}

export interface LogWindow {
  limit: number;
  oldestTime?: number;
}

/** Large resident logs are indexed once for an unchanged file. The index contains no message contents. */
export async function runtimeLogWindow(path: string, key: string, size: number, window: LogWindow) {
  // Small logs already share the bounded parsed-log cache. Older imports without
  // timed user turns use its full reader as well.
  if (size < 1024 * 1024 || window.limit + 1 >= MAX_BOUNDARIES) return;
  const handle = await open(path, "r");
  try {
    let index = indexes.get(path);
    if (index?.key !== key) {
      index = { key, boundaries: await indexTurns(handle, size) };
      indexes.delete(path);
      indexes.set(path, index);
      if (indexes.size > 32) indexes.delete(indexes.keys().next().value!);
    }
    const bounds = index.boundaries;
    let from = bounds.length - window.limit - 1;
    if (window.oldestTime) {
      const anchor = bounds.findIndex((b) => b.time >= window.oldestTime!);
      if (anchor >= 0) from = Math.min(from, anchor - 1);
    }
    if (from <= 0) return;
    const boundary = bounds[from];
    const chunks: Buffer[] = [];
    for await (const chunk of handle.createReadStream({
      start: boundary.offset,
      end: size - 1,
      autoClose: false
    }))
      chunks.push(chunk as Buffer);
    return runtimeLogEvents(Buffer.concat(chunks).toString("utf8"), boundary.index);
  } finally {
    await handle.close();
  }
}
