import { reconcileMarkup } from "../ui/reconcile.js";
import { escapeHtml as esc } from "../ui/html.js";
import { ui } from "../ui/language.js";
import { playMotion, reducedMotion, onMotionPreferenceChange } from "../ui/motion.js";
import {
  STALL_THRESHOLD_MS,
  SLICE_MS,
  STAGE_LABEL,
  LIVE_TASK_STATUSES,
  finishedAt,
  nowMsOf,
  stageViewFor,
  resolveStage,
  laneDuration
} from "./observe-run-activity.js";
import { createObserveRunMarkup } from "./observe-run-markup.js";
import { taskGoalText } from "./work-title.js";

export { formatSpan, formatStall, STALL_THRESHOLD_MS } from "./observe-run-activity.js";

/**
 * The observation entry's Runs view: one pulse lane per running Main.
 *
 * Everything on screen is a read. Lanes, Subagent branches and external
 * capacity groups come from the nodes' own snapshots; a session's title and
 * requirement are read per project, and a requirement's development stage is
 * read only when it can add a phase the activity samples cannot express. The
 * view never holds a connection and never opens a session.
 *
 * Activity samples are minute slices from `task.activity`. The current stage
 * starts at a recorded fact (`stageChangedAt`, or the requirement record); the
 * stretch before it is painted from the samples themselves, so a lane that
 * developed and then went quiet shows that shape instead of one flat colour.
 * When a node publishes no activity the same timeline is drawn as solid stage
 * blocks, and the header says the metrics are not ready.
 */

export const RUNS_WINDOWS = [5, 30, 120];
const PROGRESS_STATE = {
  queued: "queued",
  running: "running",
  succeeded: "completed",
  failed: "failed",
  timed_out: "timed_out",
  cancelled: "cancelled",
  unknown: "unknown"
};

/** How a finished Main is named on its lane; anything else just ended. */
const FINISHED_LABEL = { completed: "已完成", failed: "失败", cancelled: "已取消", timed_out: "超时" };
function sameFilter(left, right) {
  return left.nodeOrigin === right.nodeOrigin && left.projectId === right.projectId;
}

export function createObserveRuns({
  root,
  header,
  data,
  now = () => Date.now(),
  refreshMs = 10_000,
  reducedRefreshMs = 5_000,
  readIntervalMs = 10_000,
  developmentReadMs = 60_000
} = {}) {
  if (!root) return { render() {}, dispose() {} };
  const sessions = new Map();
  const developmentData = new Map();
  const capacities = new Map();
  const details = new Map();
  let minutes = 30;
  let filter = { nodeOrigin: "", projectId: "" };
  let disposed = false;
  let timer;
  let hydrating = false;
  let dirty = false;
  let motion = false;
  // Each Main's Subagent rows fold into its own lane. The person's choice per
  // session wins; otherwise they show while any of them is still at work.
  const subsChoice = new Map();
  const subsLive = (lane) => lane.subs.some((agent) => agent.state === "running" || agent.state === "queued");
  const subsShown = (lane) => subsChoice.get(lane.task.taskId) ?? subsLive(lane);

  const runsMarkup = createObserveRunMarkup(subsShown);

  const sessionsFor = (origin, projectId) => {
    const key = `${origin}|${projectId}`;
    const cached = sessions.get(key);
    if (cached?.promise) return cached.promise;
    if (cached && Date.now() - cached.at < readIntervalMs) return null;
    const entry = { at: Date.now(), value: cached?.value, promise: undefined };
    entry.promise = data
      .read(origin, `/api/projects/${encodeURIComponent(projectId)}/main-sessions`, {
        cache: "no-store"
      })
      .then((result) => {
        entry.value = Array.isArray(result?.sessions) ? result.sessions : [];
        entry.at = Date.now();
        return entry.value;
      })
      .catch((error) => {
        entry.value = entry.value ?? [];
        entry.error = error?.message || "";
        entry.at = Date.now();
        return entry.value;
      })
      .finally(() => {
        entry.promise = undefined;
      });
    sessions.set(key, entry);
    return entry.promise;
  };

  // Stage facts come from the project's read-only lists. The delivery view
  // endpoint is deliberately not used: it replays the outbox and reads diffs,
  // which would turn an observation page into periodic work on the remote host.
  const developmentDataFor = (origin, projectId) => {
    const key = `${origin}|${projectId}`;
    const cached = developmentData.get(key);
    if (cached?.promise) return cached.promise;
    if (cached && Date.now() - cached.at < developmentReadMs) return null;
    const entry = { at: Date.now(), value: cached?.value, promise: undefined };
    // One unavailable list (an older node without a route) keeps the others.
    const read = (path) =>
      data
        .read(origin, path, { cache: "no-store" })
        .then((result) => result ?? {})
        .catch((error) => {
          entry.error = error?.message || "";
          return {};
        });
    entry.promise = Promise.all([
      read(`/api/projects/${encodeURIComponent(projectId)}/developments`),
      read(`/api/projects/${encodeURIComponent(projectId)}/reviews`),
      read(`/api/projects/${encodeURIComponent(projectId)}/merges`),
      read(`/api/projects/${encodeURIComponent(projectId)}/deliveries`)
    ])
      .then(([developments, reviews, merges, deliveries]) => {
        entry.value = {
          developments: Array.isArray(developments.developments) ? developments.developments : [],
          reviews: Array.isArray(reviews.reviews) ? reviews.reviews : [],
          merges: Array.isArray(merges.merges) ? merges.merges : [],
          deliveries: Array.isArray(deliveries.deliveries) ? deliveries.deliveries : []
        };
        entry.at = Date.now();
        return entry.value;
      })
      .catch((error) => {
        entry.value = entry.value ?? undefined;
        entry.error = error?.message || "";
        entry.at = Date.now();
        return entry.value;
      })
      .finally(() => {
        entry.promise = undefined;
      });
    developmentData.set(key, entry);
    return entry.promise;
  };

  const capacityFor = (origin) => {
    const cached = capacities.get(origin);
    if (cached?.promise) return cached.promise;
    if (cached && Date.now() - cached.at < readIntervalMs) return null;
    const entry = { at: Date.now(), value: cached?.value, promise: undefined };
    entry.promise = data
      .read(origin, "/api/main-capacity", { cache: "no-store" })
      .then((view) => {
        entry.value = view;
        entry.at = Date.now();
        return view;
      })
      .catch((error) => {
        entry.value = entry.value ?? null;
        entry.error = error?.message || "";
        entry.at = Date.now();
        return entry.value;
      })
      .finally(() => {
        entry.promise = undefined;
      });
    capacities.set(origin, entry);
    return entry.promise;
  };

  // A node that publishes no activity still has durable Subagent progress;
  // the Task detail is read only for those lanes, and not on every paint.
  const detailFor = (origin, taskId) => {
    const key = `${origin}|${taskId}`;
    const cached = details.get(key);
    if (cached?.promise) return cached.promise;
    if (cached && Date.now() - cached.at < readIntervalMs * 3) return null;
    const entry = { at: Date.now(), value: cached?.value, promise: undefined };
    entry.promise = data
      .read(origin, `/api/tasks/${encodeURIComponent(taskId)}`, { cache: "no-store" })
      .then((detail) => {
        entry.value = detail;
        entry.at = Date.now();
        return detail;
      })
      .catch((error) => {
        entry.value = entry.value ?? null;
        entry.error = error?.message || "";
        entry.at = Date.now();
        return entry.value;
      })
      .finally(() => {
        entry.promise = undefined;
      });
    details.set(key, entry);
    return entry.promise;
  };

  /* -------------------------------------------------------------- timeline */

  function collectLanes(node, scopedProjects, scopedTasks, at) {
    const sessionList = [];
    for (const project of scopedProjects)
      sessionList.push(...(sessions.get(`${node.origin}|${project.projectId}`)?.value ?? []));
    const sessionByTask = new Map(sessionList.map((session) => [session.taskId, session]));
    const capacity = node.role === "external" ? capacities.get(node.origin)?.value : undefined;
    const runningByTask = new Map((capacity?.running ?? []).map((entry) => [entry.taskId, entry]));
    const windowStart = at - minutes * SLICE_MS;
    // A Main that finished inside the window keeps its lane, drawn still: its
    // waveform is history, not something that vanished with the last answer.
    const lanes = scopedTasks
      .filter((task) => {
        // An archived session left the person's view; its last status (often
        // the waiting an idle Main leaves behind) is not live work.
        if (task.archived) return false;
        if (LIVE_TASK_STATUSES.includes(task.status)) return true;
        const ended = finishedAt(task);
        return Boolean(task.activity) && ended !== undefined && ended >= windowStart;
      })
      .map((task) => {
        const endedAt = finishedAt(task);
        const session = sessionByTask.get(task.taskId);
        const project = scopedProjects.find((entry) => entry.projectId === task.projectId);
        const activity = task.activity;
        const agents = activity?.agents ?? [];
        const main = agents.find((agent) => agent.role === "main");
        const detail = activity ? undefined : details.get(`${node.origin}|${task.taskId}`)?.value;
        const progress = (detail?.progress?.agents ?? []).filter(
          (agent) => agent.role === "executor" || agent.role === "reviewer"
        );
        const subs = activity
          ? agents.filter((agent) => agent.role !== "main")
          : progress.map((agent) => ({
              agentId: agent.agentId,
              name: agent.name,
              role: "subagent",
              workRole: agent.role,
              state: PROGRESS_STATE[agent.status] ?? "unknown",
              stage: agent.status === "running" ? "working" : "completed",
              degraded: true,
              startedAt:
                nowMsOf(agent.updatedAt) !== undefined && Number.isFinite(agent.elapsedMs)
                  ? nowMsOf(agent.updatedAt) - agent.elapsedMs
                  : undefined,
              endedAt: nowMsOf(agent.updatedAt),
              samples: []
            }));
        const requirementId = session?.currentRequirementId;
        const projectData = project
          ? developmentData.get(`${node.origin}|${project.projectId}`)?.value
          : undefined;
        const view = requirementId && projectData ? stageViewFor(projectData, requirementId) : undefined;
        const stage =
          endedAt !== undefined
            ? { key: "done", label: FINISHED_LABEL[task.status] ?? STAGE_LABEL.done, startMs: endedAt }
            : resolveStage({
                activity,
                main,
                subs,
                view,
                now: at,
                windowStart,
                fallbackStart: nowMsOf(task.createdAt)
              });
        // A Reviewer writing during review is progress for the Main lane too.
        const progressTimes = agents
          .map((agent) => nowMsOf(agent.lastProgressAt))
          .filter((value) => value !== undefined);
        const lastProgress = progressTimes.length ? Math.max(...progressTimes) : undefined;
        // A Main that is not running and has been quiet past the activity window
        // publishes no samples because nothing happened: a flat quiet line, not
        // stage blocks that would claim the whole window as work.
        const quiet = !activity && task.status !== "running";
        const degraded = !activity && !quiet;
        const capacityEntry = runningByTask.get(task.taskId);
        const kind = session?.kind ?? "regular";
        return {
          task,
          session,
          project,
          requirementId,
          activity,
          degraded,
          quiet,
          main,
          subs,
          stage,
          kind,
          capacityEntry,
          endedAt,
          duration: laneDuration(task, capacityEntry, endedAt ?? at),
          // The tag always names the real silence; a moment outside the
          // selected window is anchored at the window edge instead of hidden.
          stalled:
            endedAt === undefined &&
            !degraded &&
            lastProgress !== undefined &&
            at - lastProgress > STALL_THRESHOLD_MS,
          lastProgress,
          startedAt:
            nowMsOf(capacityEntry?.startedAt) ?? nowMsOf(task.createdAt) ?? nowMsOf(activity?.from) ?? at,
          title: session?.title || task.title || taskGoalText(task.goal) || task.taskId,
          requirementTitle: session?.currentRequirementTitle ?? "",
          orderAt: nowMsOf(session?.createdAt) ?? nowMsOf(task.createdAt) ?? nowMsOf(activity?.from) ?? at
        };
      })
      .sort(
        (left, right) =>
          left.orderAt - right.orderAt || String(left.task.taskId).localeCompare(String(right.task.taskId))
      );
    return { lanes, capacity };
  }

  function collect() {
    filter = data.filter();
    const at = now();
    const nodes = data.nodes().filter((node) => !filter.nodeOrigin || node.origin === filter.nodeOrigin);
    const online = nodes.filter((node) => node.status === "online");
    const offline = nodes.filter((node) => node.status !== "online");
    const cards = online.map((node) => {
      const scoped = data.scoped({ nodeOrigin: node.origin, projectId: filter.projectId });
      return {
        node,
        ...collectLanes(node, scoped.projects ?? [], scoped.tasks ?? [], at)
      };
    });
    return { at, cards, offline, windowStart: at - minutes * SLICE_MS };
  }

  function pendingReads(plan) {
    if (!visible()) return [];
    const reads = [];
    for (const card of plan.cards) {
      const projects =
        data.scoped({
          nodeOrigin: card.node.origin,
          projectId: filter.projectId
        }).projects ?? [];
      for (const project of projects) {
        const pending = sessionsFor(card.node.origin, project.projectId);
        if (pending) reads.push(pending);
        const lanes = card.lanes.filter((lane) => lane.project?.projectId === project.projectId);
        if (lanes.some((lane) => lane.requirementId)) {
          const facts = developmentDataFor(card.node.origin, project.projectId);
          if (facts) reads.push(facts);
        }
      }
      if (card.node.role === "external") {
        const pending = capacityFor(card.node.origin);
        if (pending) reads.push(pending);
      }
      for (const lane of card.lanes) {
        if (!lane.degraded) continue;
        const pending = detailFor(card.node.origin, lane.task.taskId);
        if (pending) reads.push(pending);
      }
    }
    return reads;
  }

  /* ------------------------------------------------------------------ paint */

  function renderHeader(plan) {
    if (!header) return;
    header.hidden = false;
    const degraded = plan.cards.some((card) => card.lanes.some((lane) => lane.degraded));
    const live = header.querySelector("[data-runs-live]");
    const missing = header.querySelector("[data-runs-degraded]");
    if (live) live.hidden = degraded;
    if (missing) missing.hidden = !degraded;
    for (const button of header.querySelectorAll("[data-runs-window]"))
      button.setAttribute("aria-pressed", String(Number(button.dataset.runsWindow) === minutes));
  }

  function paint(plan) {
    renderHeader(plan);
    const empty = !plan.cards.some((card) => card.lanes.length) && plan.cards.length === 0;
    root.dataset.window = String(minutes);
    root.dataset.renderedAt = String(plan.at);
    root.dataset.motion = motion ? "reduced" : "live";
    root.dataset.refreshMs = String(motion ? reducedRefreshMs : refreshMs);
    reconcileMarkup(root, runsMarkup(plan, minutes, empty));
  }

  async function hydrate() {
    if (disposed) return;
    if (hydrating) {
      dirty = true;
      return;
    }
    hydrating = true;
    let updated = false;
    try {
      for (let round = 0; round < 5; round += 1) {
        const reads = pendingReads(collect());
        if (!reads.length) break;
        await Promise.all(reads);
        updated = true;
      }
    } finally {
      hydrating = false;
    }
    if (updated && !disposed && visible()) paint(collect());
    if (dirty) {
      dirty = false;
      void hydrate();
    }
  }

  function render() {
    if (disposed || !visible()) return;
    const plan = collect();
    paint(plan);
    void hydrate();
  }

  function visible() {
    return !root.ownerDocument.hidden && !root.closest("[hidden]");
  }

  function restartTimer() {
    clearInterval(timer);
    if (!visible()) return;
    timer = setInterval(render, motion ? reducedRefreshMs : refreshMs);
    timer?.unref?.();
  }

  function syncView() {
    restartTimer();
    render();
  }

  function buildHeader() {
    if (!header) return;
    header.innerHTML = `<span class="runs-live" data-runs-live>
        <span class="runs-live-dot" aria-hidden="true"></span>${ui("实时")}
      </span>
      <span class="runs-degraded" data-runs-degraded role="status" hidden>${ui("指标未就绪")}</span>
      <span class="runs-spacer"></span>
      <span class="runs-legend" role="group" aria-label="${esc(ui("阶段"))}">
        ${[
          ["dev", "开发", "accent"],
          ["review", "审查", "review"],
          ["merge", "合入", "ok"],
          ["wait", "等待", "warn"],
          ["idle", "空闲", "muted"]
        ]
          .map(
            ([key, label, tone]) =>
              `<span class="runs-key"><span class="runs-swatch is-${tone}"></span>${esc(ui(label))}</span>`
          )
          .join("")}
      </span>
      <span class="runs-window" role="group" aria-label="${esc(ui("时间窗口"))}">
        ${RUNS_WINDOWS.map(
          (value) =>
            `<button type="button" data-runs-window="${value}" aria-pressed="${
              value === minutes
            }">${value === 120 ? ui("2 小时") : ui`${value} 分`}</button>`
        ).join("")}
      </span>`;
  }

  const onHeaderClick = (event) => {
    const button = event.target.closest("[data-runs-window]");
    if (!button) return;
    const next = Number(button.dataset.runsWindow);
    if (!RUNS_WINDOWS.includes(next) || next === minutes) return;
    minutes = next;
    render();
  };
  header?.addEventListener("click", onHeaderClick);

  /** The Subagent rows rendered right under one Main's lane. */
  const sublanesOf = (taskId) => {
    const lane = [...root.querySelectorAll("[data-runs-lane]")].find(
      (node) => node.dataset.runsLane === taskId
    );
    const rows = [];
    for (
      let row = lane?.nextElementSibling;
      row?.classList.contains("runs-sublane");
      row = row.nextElementSibling
    )
      rows.push(row);
    return rows;
  };
  // Folding eases the rows' height instead of jumping: closing shrinks them
  // before the render drops them, opening grows the rows the render added.
  const fold = (row, open) => {
    const height = `${row.getBoundingClientRect().height}px`;
    const shut = { height: "0px", marginTop: "0px", opacity: 0 };
    const full = { height, marginTop: getComputedStyle(row).marginTop, opacity: 1 };
    row.style.overflow = "hidden";
    const animation = playMotion(row, "fold", {
      frames: open ? [shut, full] : [full, shut],
      fill: "forwards"
    });
    // A Web Animation is cancelled only by this code, so `finished` resolves.
    if (open)
      animation.finished.then(() => {
        row.style.overflow = "";
        animation.cancel();
      });
    return animation.finished;
  };
  const onRootClick = async (event) => {
    const button = event.target.closest("[data-runs-subs]");
    if (!button) return;
    const taskId = button.dataset.runsSubs;
    const open = button.getAttribute("aria-expanded") !== "true";
    subsChoice.set(taskId, open);
    if (!motion && !open) {
      button.setAttribute("aria-expanded", "false");
      await Promise.all(sublanesOf(taskId).map((row) => fold(row, false)));
    }
    render();
    if (!motion && open) for (const row of sublanesOf(taskId)) fold(row, true);
  };
  root.addEventListener("click", onRootClick);

  const unsubscribe = data.subscribe(() => {
    const next = data.filter();
    if (motion && sameFilter(next, filter)) return;
    filter = next;
    render();
  });

  // A hidden panel does no reads. The store flips the hidden attribute on the
  // pane (entry switch) and on this view (view switch), so watch both.
  const Observer = globalThis.window?.MutationObserver;
  const visibilityObserver = Observer ? new Observer(syncView) : undefined;
  for (const node of new Set([root, root.closest("[data-entry-panel]")]))
    if (node && visibilityObserver)
      visibilityObserver.observe(node, { attributes: true, attributeFilter: ["hidden"] });

  const stopPreferences = onMotionPreferenceChange((reduce) => {
    motion = reduce;
    syncView();
  });
  root.ownerDocument.addEventListener("visibilitychange", syncView);

  buildHeader();
  motion = reducedMotion();
  syncView();

  return {
    render,
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      visibilityObserver?.disconnect();
      header?.removeEventListener("click", onHeaderClick);
      root.removeEventListener("click", onRootClick);
      root.ownerDocument.removeEventListener("visibilitychange", syncView);
      stopPreferences();
      unsubscribe();
    }
  };
}
