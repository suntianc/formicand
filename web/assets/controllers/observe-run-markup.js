import { agentAvatar, agentDisplayName } from "../agent-names.js";
import { escapeHtml as esc } from "../ui/html.js";
import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { formatStamp } from "../ui/time-format.js";
import {
  WAVE_WIDTH,
  formatSpan,
  formatStall,
  percentOf,
  sampleScore,
  visibleSlices,
  combinedSamples,
  laneSegments,
  degradedLaneSegments,
  subSegments,
  pulsePath
} from "./observe-run-activity.js";

const AGENT_STATE_LABEL = {
  queued: "排队中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  timed_out: "超时"
};

const NODE_STATUS_LABEL = {
  connecting: "连接中",
  offline: "离线",
  unauthorized: "未授权",
  failed: "不可用",
  disconnected: "已断开"
};

const WORK_ROLE_LABEL = { executor: "Executor", reviewer: "Reviewer" };

export function createObserveRunMarkup(subsShown) {
  function axisMarkup(minutes) {
    const ticks =
      minutes === 120 ? [-120, -90, -60, -30] : minutes === 30 ? [-30, -20, -10] : [-5, -4, -3, -2, -1];
    return `<div class="runs-axis" aria-hidden="true">
      <span class="runs-axis-label"></span>
      <div class="runs-axis-track">
        ${ticks.map((value) => `<span class="runs-axis-tick">${ui`${value} 分`}</span>`).join("")}
        <span class="runs-axis-tick is-now">${ui("现在")}</span>
      </div>
      <span class="runs-axis-end"></span>
    </div>`;
  }

  function stagePill(stage) {
    return `<span class="runs-pill is-${stage.key}">${esc(ui(stage.label))}</span>`;
  }

  function subline(lane) {
    const requirement = lane.requirementTitle || ui("等新需求");
    if (!lane.project?.projectName) return lane.requirementTitle ? esc(lane.requirementTitle) : "";
    return `${esc(lane.project.projectName)} · ${esc(requirement)}`;
  }

  function waveMarkup({
    segments,
    samples,
    activity,
    windowStart,
    windowEnd,
    height,
    degraded,
    stage,
    extra = ""
  }) {
    const maxScore = Math.max(0, ...samples.map((sample) => sampleScore(sample)));
    const slices = visibleSlices(activity, windowStart, windowEnd);
    if (degraded) {
      return `<div class="runs-wave is-degraded" data-degraded="true" data-slices="${slices}">
        <span class="runs-flat is-baseline"></span>
        ${segments
          .map((segment) => {
            const left = percentOf(segment.from, windowStart, windowEnd);
            const width = percentOf(segment.to, windowStart, windowEnd) - left;
            return `<span class="runs-block is-${segment.kind}" style="left:${left.toFixed(
              2
            )}%;width:${Math.max(0.6, width).toFixed(2)}%"></span>`;
          })
          .join("")}
        ${extra}
      </div>`;
    }
    return `<div class="runs-wave" data-slices="${slices}">
      <svg class="runs-spark" viewBox="0 0 ${WAVE_WIDTH} ${height}" preserveAspectRatio="none" aria-hidden="true">
        <line class="runs-baseline" x1="0" y1="${height / 2}" x2="${WAVE_WIDTH}" y2="${height / 2}" />
        ${segments
          .map(
            (segment) =>
              `<path class="runs-pulse is-${segment.kind}" vector-effect="non-scaling-stroke" d="${pulsePath({
                samples,
                activity,
                segment,
                windowStart,
                windowEnd,
                height,
                maxScore
              })}" />`
          )
          .join("")}
      </svg>
      ${stage && !["idle", "done"].includes(stage.key) ? `<span class="runs-head is-${stage.key}"></span>` : ""}
      ${extra}
    </div>`;
  }

  function laneMarkup(lane, plan) {
    const { at, windowStart } = plan;
    const windowEnd = at;
    const degraded = lane.degraded;
    const samples = combinedSamples(lane.activity);
    const segments = lane.quiet
      ? [{ kind: "idle", from: windowStart, to: windowEnd }]
      : degraded
        ? degradedLaneSegments(lane, windowStart, windowEnd)
        : laneSegments({
            activity: lane.activity,
            samples,
            stage: lane.endedAt === undefined ? lane.stage : { key: "dev", startMs: lane.endedAt },
            windowStart,
            windowEnd: lane.endedAt === undefined ? windowEnd : Math.min(windowEnd, lane.endedAt),
            degraded: false
          });
    const stallLeft = lane.stalled
      ? Math.min(percentOf(lane.lastProgress, windowStart, windowEnd), 82)
      : undefined;
    const wave = waveMarkup({
      segments,
      samples,
      activity: lane.activity,
      windowStart,
      windowEnd,
      height: 40,
      degraded,
      stage: lane.quiet ? { key: "idle" } : lane.stage,
      extra: lane.stalled
        ? `<span class="runs-stall" data-runs-stall style="left:calc(${stallLeft.toFixed(2)}% + 20px)">${esc(
            formatStall(at - lane.lastProgress)
          )}</span>`
        : ""
    });
    const finished = lane.endedAt !== undefined;
    return `<div class="runs-lane${lane.stalled ? " is-stalled" : ""}${
      finished ? " is-finished" : ""
    }" data-view-key="lane:${esc(lane.task.taskId)}" data-runs-lane="${esc(lane.task.taskId)}" data-stage="${lane.stage.key}" data-stalled="${
      lane.stalled
    }" data-degraded="${degraded}" data-finished="${finished}">
      <div class="runs-lane-label">
        <div class="runs-lane-head">
          <span class="runs-session">${esc(lane.title)}</span>
          ${stagePill(lane.stage)}
          ${subsToggle(lane)}
        </div>
        <div class="runs-lane-sub">${subline(lane)}</div>
      </div>
      ${wave}
      <div class="runs-lane-right">
        <span class="runs-duration">${esc(formatSpan(lane.duration))}</span>
      </div>
    </div>
    ${subsShown(lane) ? lane.subs.map((agent) => subLaneMarkup(lane, agent, plan)).join("") : ""}`;
  }

  function subsToggle(lane) {
    if (!lane.subs.length) return "";
    const shown = subsShown(lane);
    const label = shown ? ui`收起 ${lane.subs.length} 个子代理` : ui`展开 ${lane.subs.length} 个子代理`;
    return `<button type="button" class="runs-subs-toggle" data-runs-subs="${esc(lane.task.taskId)}" aria-expanded="${shown}" aria-label="${esc(label)}" title="${esc(label)}">${esc(ui`${lane.subs.length} 个子代理`)}${icon("chevron-right")}</button>`;
  }

  function subLaneMarkup(lane, agent, plan) {
    const { at, windowStart } = plan;
    const windowEnd = at;
    const role = WORK_ROLE_LABEL[agent.workRole] ?? "Subagent";
    const name = agent.name || agentDisplayName(agent.agentId);
    const stateLabel = AGENT_STATE_LABEL[agent.state] ?? "";
    const color = agent.workRole === "reviewer" ? "review" : "dev";
    const degraded = Boolean(agent.degraded);
    const segments = degraded ? [] : subSegments({ activity: lane.activity, agent, windowStart, windowEnd });
    const samples = agent.samples ?? [];
    const end = degraded
      ? agent.state === "running"
        ? windowEnd
        : Math.min(windowEnd, agent.endedAt ?? windowEnd)
      : segments.at(-1)?.to;
    const start = degraded
      ? Math.max(windowStart, Math.min(agent.startedAt ?? lane.startedAt ?? end, end))
      : undefined;
    const left = end === undefined ? 100 : percentOf(end, windowStart, windowEnd);
    // Only a running branch gets a mark at its end; a finished one says so in
    // its state column, and a mark there sat on top of the line.
    const head =
      agent.state === "running"
        ? `<span class="runs-head is-${degraded ? color : (segments.at(-1)?.kind ?? "dev")}" style="left:${left.toFixed(
            2
          )}%"></span>`
        : "";
    const wave = degraded
      ? `<div class="runs-wave is-sub is-degraded" data-degraded="true" data-state="${esc(agent.state)}">
          <span class="runs-flat is-baseline"></span>
          ${
            end === undefined || start === undefined || end <= windowStart
              ? ""
              : `<span class="runs-block is-${color}" style="left:${percentOf(
                  start,
                  windowStart,
                  windowEnd
                ).toFixed(2)}%;width:${Math.max(
                  0.8,
                  percentOf(end, windowStart, windowEnd) - percentOf(start, windowStart, windowEnd)
                ).toFixed(2)}%"></span>`
          }
          ${head}
        </div>`
      : `<div class="runs-wave is-sub" data-state="${esc(agent.state)}">
          <svg class="runs-spark" viewBox="0 0 ${WAVE_WIDTH} 22" preserveAspectRatio="none" aria-hidden="true">
            <line class="runs-baseline" x1="0" y1="11" x2="${WAVE_WIDTH}" y2="11" />
            ${segments
              .map(
                (segment) =>
                  `<path class="runs-pulse is-${segment.kind}" vector-effect="non-scaling-stroke" d="${pulsePath(
                    {
                      samples,
                      activity: lane.activity,
                      segment,
                      windowStart,
                      windowEnd,
                      height: 22,
                      maxScore: Math.max(0, ...samples.map((sample) => sampleScore(sample)))
                    }
                  )}" />`
              )
              .join("")}
          </svg>
          ${head}
        </div>`;
    return `<div class="runs-sublane" data-view-key="agent:${esc(lane.task.taskId)}:${esc(agent.agentId)}" data-runs-agent="${esc(agent.agentId)}" data-state="${esc(agent.state)}">
      <div class="runs-sublane-label">
        <span class="runs-branch" aria-hidden="true"></span>
        <span class="runs-role">${esc(role)}</span>
        ${agentAvatar(agent.agentId)}
        <span class="runs-agent">${esc(name)}</span>
      </div>
      ${wave}
      <div class="runs-lane-right">${
        stateLabel ? `<span class="runs-kid-state is-${esc(agent.state)}">${esc(ui(stateLabel))}</span>` : ""
      }</div>
    </div>`;
  }

  function slotMarkup(label, quota, used, tone) {
    const slots = Math.min(Math.max(quota, 1), 8);
    const filled = Math.min(used, slots);
    return `<div class="runs-slot" data-runs-slot="${tone}">
      <span class="runs-slot-label">${esc(label)}</span>
      <span class="runs-slot-bar">${Array.from(
        { length: slots },
        (_, index) => `<span class="runs-slot-seg${index < filled ? ` is-${tone}` : ""}"></span>`
      ).join("")}</span>
      <span class="runs-slot-value${tone === "continuation" ? " is-warn" : ""}">${used}/${quota}</span>
    </div>`;
  }

  function emptyLaneMarkup(label) {
    return `<div class="runs-lane is-empty" data-runs-empty="${esc(label)}">
      <div class="runs-lane-label"><span class="runs-session">${esc(label)}</span></div>
      <div class="runs-wave"><span class="runs-flat"></span></div>
      <div class="runs-lane-right"></div>
    </div>`;
  }

  function nodeMarkup(card, plan) {
    const { node, lanes, capacity } = card;
    const external = node.role === "external";
    const settings = capacity?.settings;
    const running = capacity?.running ?? [];
    const usedByKind = {
      regular: running.filter((entry) => entry.kind === "regular").length,
      continuation: running.filter((entry) => entry.kind === "continuation").length
    };
    let body = "";
    if (external && settings) {
      for (const [kind, label, tone] of [
        ["regular", ui("常驻"), "regular"],
        ["continuation", ui("接续"), "continuation"]
      ]) {
        const quota = Number(settings[kind === "regular" ? "resident" : "continuation"]) || 0;
        const kindLanes = lanes.filter((lane) => lane.kind === kind && lane.endedAt === undefined);
        // Occupancy is what the host's slots say, not what the current filter
        // happens to show: hiding a lane must not free its place.
        const used = usedByKind[kind];
        body += slotMarkup(label, quota, used, tone);
        body += kindLanes.map((lane) => laneMarkup(lane, plan)).join("");
        for (let index = used; index < quota; index += 1) body += emptyLaneMarkup(`${label} ${index + 1}`);
      }
      const rest = lanes.filter(
        (lane) => !["regular", "continuation"].includes(lane.kind) || lane.endedAt !== undefined
      );
      body += rest.map((lane) => laneMarkup(lane, plan)).join("");
    } else {
      body = lanes.map((lane) => laneMarkup(lane, plan)).join("");
    }
    return `<section class="runs-node" data-view-key="node:${esc(node.origin)}" data-runs-node="${esc(node.origin)}" data-role="${
      external ? "external" : "internal"
    }">
      <header class="runs-node-head">
        ${icon(node.local ? "laptop" : "server")}
        <span class="runs-node-name">${esc(node.name)}</span>
        <span class="runs-role-chip">${esc(ui(external ? "对外" : "对内"))}</span>
        <span class="runs-node-dot is-ok" aria-hidden="true"></span>
      </header>
      ${body}
    </section>`;
  }

  function offlineMarkup(node, at) {
    const status = ui(NODE_STATUS_LABEL[node.status] ?? "离线");
    const seen = node.lastSeen ? `${status} · ${formatStamp(node.lastSeen, "relative", at)}` : status;
    return `<section class="runs-node is-offline" data-view-key="node:${esc(node.origin)}" data-runs-node="${esc(node.origin)}">
      ${icon("server")}
      <span class="runs-node-name">${esc(node.name)}</span>
      <span class="runs-node-dot" aria-hidden="true"></span>
      <span class="runs-spacer"></span>
      <span class="runs-offline">${esc(seen)}</span>
    </section>`;
  }

  return function runsMarkup(plan, minutes, empty) {
    return `${axisMarkup(minutes)}<div class="runs-nodes">${plan.cards
      .map((card) => nodeMarkup(card, plan))
      .join("")}${plan.offline.map((node) => offlineMarkup(node, plan.at)).join("")}${
      empty ? `<p class="runs-empty">${esc(ui("没有运行中的 Main"))}</p>` : ""
    }</div>`;
  };
}
