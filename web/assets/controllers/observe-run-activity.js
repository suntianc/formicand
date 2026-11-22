import { ui } from "../ui/language.js";

/** A Main whose writes stopped this long ago is highlighted as stalled. */
export const STALL_THRESHOLD_MS = 10 * 60_000;
export const SLICE_MS = 60_000;
export const WAVE_WIDTH = 748;

export const STAGE_LABEL = {
  done: "已结束",
  dev: "开发",
  review: "审查",
  merge: "合入",
  wait: "等待",
  idle: "空闲"
};

const VIEW_STAGE = {
  developing: { key: "dev" },
  reviewing: { key: "review" },
  merge_pending: { key: "wait", label: "等待合入" },
  merged: { key: "merge" },
  delivered: { key: "merge" }
};

export const LIVE_TASK_STATUSES = ["running", "waiting"];

/** When a Task's run stopped, or undefined while it is still live. */
export function finishedAt(task) {
  if (LIVE_TASK_STATUSES.includes(task.status) || task.activity?.active) return undefined;
  const activity = task.activity;
  const from = nowMsOf(activity?.from);
  const published =
    from === undefined ? undefined : from + combinedSamples(activity).length * (activity.sliceMs || SLICE_MS);
  return nowMsOf(task.completedAt) ?? nowMsOf(task.updatedAt) ?? published;
}

export const nowMsOf = (value) => {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** A compact span: minutes below an hour, whole hours above it. */
export function formatSpan(ms) {
  const minutes = Math.max(1, Math.floor(Math.max(0, ms) / SLICE_MS));
  return minutes < 60 ? ui`${minutes} 分` : ui`${Math.floor(minutes / 60)} 小时`;
}

/** How long a lane has gone without a written record. */
export function formatStall(ms) {
  const minutes = Math.max(1, Math.floor(Math.max(0, ms) / SLICE_MS));
  return minutes < 60 ? ui`${minutes} 分无进展` : ui`${Math.floor(minutes / 60)} 小时无进展`;
}

export function percentOf(value, start, end) {
  if (!(end > start)) return 0;
  return Math.min(100, Math.max(0, ((value - start) / (end - start)) * 100));
}

export function sampleScore(sample) {
  if (!sample) return 0;
  const calls = Number(sample.toolCalls) || 0;
  const bytes = Number(sample.outputBytes) || 0;
  return calls * 4 + bytes / 60;
}

function sampleActive(sample) {
  return sampleScore(sample) > 0;
}

/** When an agent's first still-visible record was written. */
function firstActiveMs(agent, activity, windowStart) {
  const sliceMs = activity?.sliceMs || SLICE_MS;
  const fromMs = nowMsOf(activity?.from);
  if (fromMs === undefined) return undefined;
  const samples = agent?.samples ?? [];
  for (let index = 0; index < samples.length; index += 1) {
    if (!sampleActive(samples[index])) continue;
    const start = fromMs + index * sliceMs;
    if (start >= windowStart) return start;
  }
  return undefined;
}

/** How many minute slices of a trace fall inside the selected window. */
export function visibleSlices(activity, windowStart, windowEnd) {
  const sliceMs = activity?.sliceMs || SLICE_MS;
  const fromMs = nowMsOf(activity?.from);
  if (fromMs === undefined) return 0;
  const first = Math.max(0, Math.floor((windowStart - fromMs) / sliceMs));
  const last = Math.ceil((windowEnd - fromMs) / sliceMs);
  return Math.max(0, Math.min(activity.agents?.[0]?.samples?.length ?? last, last) - first);
}

export function combinedSamples(activity) {
  const agents = activity?.agents ?? [];
  const length = Math.max(0, ...agents.map((agent) => agent.samples?.length ?? 0));
  return Array.from({ length }, (_, index) => {
    let toolCalls = 0;
    let outputBytes = 0;
    for (const agent of agents) {
      const sample = agent.samples?.[index];
      if (!sample) continue;
      toolCalls += Number(sample.toolCalls) || 0;
      outputBytes += Number(sample.outputBytes) || 0;
    }
    return { toolCalls, outputBytes };
  });
}

function pushSegment(list, kind, from, to) {
  if (!(to > from)) return;
  const last = list.at(-1);
  if (last && last.kind === kind && Math.abs(last.to - from) < 1) last.to = to;
  else list.push({ kind, from, to });
}

/**
 * The same stage the delivery view reports, rebuilt from the read-only lists.
 *
 * `deliveryStage` in the dashboard service compares the newest delivery, any
 * merged/waiting merge, and the newest review. Reading the lists keeps that
 * rule without replaying the delivery outbox or diffing a checkout.
 */
export function stageViewFor(records, requirementId) {
  const development = records.developments.find((entry) => entry.requirementId === requirementId);
  if (!development) return undefined;
  const reviews = records.reviews.filter((entry) => entry.developmentId === development.developmentId);
  const merges = records.merges.filter((entry) => entry.developmentId === development.developmentId);
  const delivery = records.deliveries
    .filter((entry) => entry.developmentId === development.developmentId)
    .at(-1);
  const stage =
    delivery?.state === "synced"
      ? "delivered"
      : delivery?.state === "pending" || merges.some((entry) => entry.state === "merged")
        ? "merged"
        : merges.some((entry) => ["waiting", "applying"].includes(entry.state))
          ? "merge_pending"
          : reviews.at(-1)?.state === "in_review"
            ? "reviewing"
            : "developing";
  return { stage, development, reviews, merges, delivery };
}

/** The phase a Main is in, the moment it began, and whether it is stalled. */
export function resolveStage({ activity, main, subs, view, now, windowStart, fallbackStart }) {
  const stage = view?.stage;
  if (stage && VIEW_STAGE[stage]) {
    const mapped = VIEW_STAGE[stage];
    const latestReview = [...(view.reviews ?? [])].at(-1);
    const latestMerge = [...(view.merges ?? [])].at(-1);
    const start =
      mapped.key === "review"
        ? (nowMsOf(latestReview?.createdAt) ?? nowMsOf(view.development?.createdAt))
        : mapped.key === "wait"
          ? (nowMsOf(latestMerge?.createdAt) ?? nowMsOf(view.development?.updatedAt))
          : mapped.key === "merge"
            ? (nowMsOf(latestMerge?.mergedAt) ?? nowMsOf(view.delivery?.updatedAt))
            : nowMsOf(view.development?.createdAt);
    return {
      key: mapped.key,
      label: mapped.label ?? STAGE_LABEL[mapped.key],
      startMs: start ?? windowStart
    };
  }
  const lastProgress = nowMsOf(main?.lastProgressAt);
  const stalled = lastProgress !== undefined && now - lastProgress > STALL_THRESHOLD_MS;
  const reviewer = subs.find(
    (agent) => agent.workRole === "reviewer" && ["queued", "running"].includes(agent.state)
  );
  if (reviewer) {
    // A running Reviewer's stage is its active stretch, not the idle moment
    // after its last record: `stageChangedAt` would put review at the end.
    const reviewStart =
      firstActiveMs(reviewer, activity, windowStart) ??
      nowMsOf(reviewer.stageChangedAt) ??
      lastProgress ??
      windowStart;
    return { key: "review", label: STAGE_LABEL.review, startMs: reviewStart };
  }
  if (main?.stage === "waiting")
    return {
      key: "wait",
      label: STAGE_LABEL.wait,
      startMs: nowMsOf(main.stageChangedAt) ?? lastProgress ?? windowStart
    };
  if (main?.stage === "idle" || stalled) {
    if (stalled) return { key: "wait", label: STAGE_LABEL.wait, startMs: lastProgress };
    return {
      key: "idle",
      label: STAGE_LABEL.idle,
      startMs: nowMsOf(main?.stageChangedAt) ?? lastProgress ?? windowStart
    };
  }
  return {
    key: "dev",
    label: STAGE_LABEL.dev,
    // Without a single record the lane still began when its session did.
    startMs: nowMsOf(main?.stageChangedAt) ?? nowMsOf(activity?.from) ?? fallbackStart ?? windowStart
  };
}

/** Stage-coloured stretches across the visible window. */
export function laneSegments({ activity, samples, stage, windowStart, windowEnd, degraded }) {
  const segments = [];
  if (degraded || !activity) {
    const start = Math.min(Math.max(stage.startMs ?? windowStart, windowStart), windowEnd);
    pushSegment(segments, stage.key, start, windowEnd);
    return segments;
  }
  const sliceMs = activity.sliceMs || SLICE_MS;
  const fromMs = nowMsOf(activity.from) ?? windowStart;
  const activityStart = Math.min(Math.max(fromMs, windowStart), windowEnd);
  // The stage begins at a slice edge so the stretch before it is made of whole
  // slices; a record in the stage's first slice belongs to that stage.
  const stageStart = Math.min(
    Math.max(fromMs + Math.ceil((stage.startMs - fromMs) / sliceMs) * sliceMs, activityStart),
    windowEnd
  );
  let at = activityStart;
  while (at < stageStart) {
    const index = Math.floor((at - fromMs) / sliceMs);
    const sliceEnd = Math.min(stageStart, fromMs + (index + 1) * sliceMs);
    pushSegment(segments, sampleActive(samples[index]) ? "dev" : "idle", at, sliceEnd);
    at = sliceEnd;
  }
  pushSegment(segments, stage.key, stageStart, windowEnd);
  return segments;
}

/**
 * Stage blocks when the node publishes no samples.
 *
 * The durable work items still say when an Executor and a Reviewer ran, so the
 * lane keeps the development / quiet / review shape instead of one flat bar.
 */
export function degradedLaneSegments(lane, windowStart, windowEnd) {
  const segments = [];
  const start = Math.min(Math.max(lane.startedAt ?? windowStart, windowStart), windowEnd);
  const reviewer = lane.subs.find(
    (agent) => agent.workRole === "reviewer" && nowMsOf(agent.startedAt) !== undefined
  );
  const executors = lane.subs.filter(
    (agent) => agent.workRole === "executor" && nowMsOf(agent.endedAt) !== undefined
  );
  const devEnd = Math.min(
    windowEnd,
    Math.max(
      start,
      executors.length
        ? Math.max(...executors.map((agent) => agent.endedAt))
        : (nowMsOf(reviewer?.startedAt) ?? windowEnd)
    )
  );
  pushSegment(segments, "dev", start, devEnd);
  const reviewStart = nowMsOf(reviewer?.startedAt);
  if (reviewStart !== undefined && reviewStart > devEnd) {
    const boundary = Math.min(windowEnd, reviewStart);
    pushSegment(segments, "idle", devEnd, boundary);
    pushSegment(segments, "review", boundary, windowEnd);
  } else {
    const stageStart = Math.min(Math.max(lane.stage.startMs ?? devEnd, devEnd), windowEnd);
    pushSegment(segments, lane.stage.key, stageStart, windowEnd);
  }
  return segments;
}

/** A finished Subagent's branch ends where its last record did. */
export function subSegments({ activity, agent, windowStart, windowEnd }) {
  const samples = agent.samples ?? [];
  const sliceMs = activity.sliceMs || SLICE_MS;
  const fromMs = nowMsOf(activity.from) ?? windowStart;
  let first;
  let last;
  samples.forEach((sample, index) => {
    if (!sampleActive(sample)) return;
    const start = fromMs + index * sliceMs;
    if (start < windowStart) return;
    if (first === undefined) first = start;
    last = start + sliceMs;
  });
  if (first === undefined) return [];
  const color = agent.workRole === "reviewer" ? "review" : agent.workRole === "executor" ? "dev" : "dev";
  const end = agent.state === "running" ? windowEnd : Math.min(windowEnd, last);
  const segments = [];
  let at = Math.max(first, windowStart);
  while (at < end) {
    const index = Math.floor((at - fromMs) / sliceMs);
    const sliceEnd = Math.min(end, Math.max(at + 1, fromMs + (index + 1) * sliceMs));
    pushSegment(segments, sampleActive(samples[index]) ? color : "idle", at, sliceEnd);
    at = sliceEnd;
  }
  return segments;
}

/** A jagged line across one stage segment; quiet slices sit on the baseline. */
export function pulsePath({ samples, activity, segment, windowStart, windowEnd, height, maxScore }) {
  const baseline = height / 2;
  const x0 = percentOf(segment.from, windowStart, windowEnd) * (WAVE_WIDTH / 100);
  const x1 = percentOf(segment.to, windowStart, windowEnd) * (WAVE_WIDTH / 100);
  if (segment.kind === "idle" || maxScore <= 0)
    return `M${x0.toFixed(1)} ${baseline} L${x1.toFixed(1)} ${baseline}`;
  const sliceMs = activity.sliceMs || SLICE_MS;
  const fromMs = nowMsOf(activity.from) ?? windowStart;
  const amp = Math.max(4, baseline - 3);
  const points = [];
  let segmentMax = 0;
  for (let at = segment.from; at < segment.to; at += Math.min(sliceMs, Math.max(1, segment.to - at))) {
    const index = Math.floor((at - fromMs) / sliceMs);
    segmentMax = Math.max(segmentMax, sampleScore(samples[index]));
  }
  if (segmentMax <= 0) return `M${x0.toFixed(1)} ${baseline} L${x1.toFixed(1)} ${baseline}`;
  for (let at = segment.from; at < segment.to; at += Math.min(sliceMs, Math.max(1, segment.to - at))) {
    const index = Math.floor((at - fromMs) / sliceMs);
    const score = sampleScore(samples[index]);
    const rise = score <= 0 ? 0 : Math.max(2, amp * (0.45 + 0.55 * (score / segmentMax)));
    const width = (Math.min(sliceMs, segment.to - at) / (windowEnd - windowStart)) * WAVE_WIDTH;
    const next = percentOf(at, windowStart, windowEnd) * (WAVE_WIDTH / 100) + width;
    // Two points per slice keep the line jagged at a one-minute sample rate.
    const lead = percentOf(at, windowStart, windowEnd) * (WAVE_WIDTH / 100);
    points.push(`${(lead + (next - lead) * 0.3).toFixed(1)} ${(baseline - rise * 0.55).toFixed(1)}`);
    points.push(`${(lead + (next - lead) * 0.75).toFixed(1)} ${(baseline - rise).toFixed(1)}`);
  }
  const endX = percentOf(segment.to, windowStart, windowEnd) * (WAVE_WIDTH / 100);
  points.push(`${endX.toFixed(1)} ${baseline}`);
  return `M${x0.toFixed(1)} ${baseline} L${points.join(" L")}`;
}

export function laneDuration(task, capacityEntry, now) {
  const started = nowMsOf(capacityEntry?.startedAt) ?? nowMsOf(task?.createdAt);
  return started === undefined ? 0 : Math.max(0, now - started);
}
