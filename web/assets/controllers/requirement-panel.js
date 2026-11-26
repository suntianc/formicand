import { agentDisplayName } from "../agent-names.js";
import { artifactRequestUrls, artifactVersion } from "../artifacts.js";
import { requirementProgress, requirementTickets } from "../requirement-stages.js";
import { fileIcon } from "../ui/file-icons.js";
import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { animate, motionDuration } from "../ui/motion.js";
import { escapeHtml as esc } from "../ui/html.js";

const SOURCE_LABELS = { internal: "内部", external: "外部", legacy: "遗留" };
const ROUTE_LABELS = { quick: "快速", direct: "直接", full: "Full" };
const REFRESH_MS = 4_000;

const enc = encodeURIComponent;

function compactTokens(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const tokens = Number(value);
  // The panel reads out in the design's units: millions once a value is large.
  if (tokens >= 100_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

// A list longer than this shows its first few rows and folds the rest.
const FLAT_LIMIT = 5;
const FOLDED_ROWS = 3;

const shortCommit = (commit) => (typeof commit === "string" ? commit.slice(0, 8) : "");
const baseName = (path) =>
  String(path || "")
    .split("/")
    .filter(Boolean)
    .at(-1) || String(path || "");

/**
 * The requirement panel: one conversation's requirement, its phase, criteria,
 * change, attachments and usage.
 *
 * The panel reads the records the backend keeps — the Main session's
 * requirement, the ledger requirement, the delivery view and the published
 * artifacts — and renders the phase through the shared mapping, so it never
 * invents progress the records do not show. Reads are keyed to the selected
 * Task and dropped when the selection moves; a refresh keeps the previous
 * records on screen until new ones arrive.
 */
export function createRequirementPanel({
  state,
  $,
  api,
  onCollapse,
  openArtifact,
  openPreview,
  onRendered = () => {}
}) {
  let loaded = null;
  let loading = null;
  let epoch = 0;
  let expanded = false;
  let bodySignature;
  let usageSignature;
  let stage = "";
  // What the reader unfolded in this conversation's lists.
  let unfolded = new Set();
  // Below this width the panel is a drawer over the conversation, so the title
  // row control has room for the panel's name and phase.
  const narrowWindow = window.matchMedia?.("(max-width: 1279px)") ?? { matches: false };

  /**
   * The title-row control that opens and closes this panel.
   *
   * Its name carries the phase the panel is showing wherever the panel floats
   * over the conversation; its expanded state and the panel it controls stay
   * programmatic at every width.
   */
  function paintToggle() {
    const toggle = $("#output-pane-toggle");
    if (!toggle) return;
    const name = ui("需求进度");
    const text = stage ? `${name} · ${ui(stage)}` : name;
    const label = narrowWindow.matches ? text : ui("切换任务面板");
    const value = toggle.querySelector("[data-panel-toggle-label]");
    if (value && value.textContent !== text) value.textContent = text;
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    toggle.setAttribute("aria-controls", "agent-pane");
    toggle.setAttribute("aria-expanded", String(!document.body.classList.contains("output-collapsed")));
  }
  narrowWindow.addEventListener?.("change", paintToggle);

  const selectedProjectId = () => {
    const detail = state.detail;
    return detail?.projectId ?? detail?.task?.projectId ?? null;
  };

  /** The records behind the selected conversation, or what is missing to show. */
  async function readRecords(taskId, projectId) {
    let sessions;
    try {
      sessions = await api(`/api/projects/${enc(projectId)}/main-sessions`, { cache: "no-store" });
    } catch (error) {
      // A directory that is not a shared project has no requirement records;
      // the conversation's attachments and usage still apply.
      if (error?.status === 404) return {};
      throw error;
    }
    const session = (sessions.sessions || []).find((entry) => entry.taskId === taskId);
    let requirementId = session?.currentRequirementId;
    if (!requirementId) {
      // A conversation that predates sessions still records its development.
      // The Task-scoped list is a project read, so the Task itself decides.
      const developments = await api(`/api/tasks/${enc(taskId)}/developments`, { cache: "no-store" });
      requirementId = (developments.developments || []).find(
        (entry) => entry.taskId === taskId
      )?.requirementId;
    }
    if (!requirementId) return { session };
    const requirement = (
      await api(`/api/projects/${enc(projectId)}/ledger/${enc(requirementId)}`, { cache: "no-store" })
    ).requirement;
    let view;
    try {
      view = (
        await api(`/api/projects/${enc(projectId)}/deliveries`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "view", requirementId })
        })
      ).view;
    } catch (error) {
      // 没有开发记录是正常状态；其它读取失败交由外层显示重试，不能当成“还没有开发”。
      if (error?.status !== 404) throw error;
    }
    return { session, requirement, view };
  }

  function start(taskId) {
    const projectId = selectedProjectId();
    const current = ++epoch;
    loading = (async () => {
      try {
        const records = await readRecords(taskId, projectId);
        if (current !== epoch) return;
        loaded = { taskId, projectId, at: Date.now(), ...records };
      } catch (error) {
        if (current !== epoch) return;
        loaded = { taskId, projectId, at: Date.now(), error: error.message };
      } finally {
        if (current === epoch) {
          loading = null;
          render();
        }
      }
    })();
  }

  function ensure(taskId) {
    if (loaded?.taskId !== taskId) {
      loaded = null;
      bodySignature = undefined;
      usageSignature = undefined;
      unfolded = new Set();
      start(taskId);
      return;
    }
    // Same Task, project now known or changed: reload, keeping the last records on screen.
    if (loaded.projectId !== selectedProjectId()) {
      if (!loading) start(taskId);
      return;
    }
    if (loading || Date.now() - loaded.at < REFRESH_MS) return;
    const current = ++epoch;
    loading = (async () => {
      try {
        const records = await readRecords(taskId, selectedProjectId());
        if (current !== epoch || state.selected !== taskId) return;
        loaded = { taskId, projectId: selectedProjectId(), at: Date.now(), ...records };
        render();
        // eslint-disable-next-line no-restricted-syntax -- 一次刷新失败保留上一次记录，面板不因轮询失败清空
      } catch {
        /* keep the last records */
      } finally {
        if (current === epoch) loading = null;
      }
    })();
  }

  /** Forget the records; `keepTaskId` keeps them when the reset is for the Task already shown. */
  function reset(keepTaskId) {
    if (keepTaskId && loaded?.taskId === keepTaskId) return;
    epoch += 1;
    loading = null;
    loaded = null;
    bodySignature = undefined;
    usageSignature = undefined;
    expanded = false;
    unfolded = new Set();
  }

  function progressOf() {
    const view = loaded?.view;
    return requirementProgress({
      requirement: loaded?.requirement,
      board: view?.board,
      development: view?.development,
      plan: view?.plan,
      reviews: view?.reviews,
      merges: view?.merges,
      delivery: view?.delivery,
      roles: view?.roles,
      agents: state.detail?.progress?.agents,
      tickets: view?.tickets,
      waitingForReply: (state.detail?.humanRequests || []).some((request) => request.status === "pending")
    });
  }

  // ---- rendering -------------------------------------------------------------

  function tagValues(requirement, view, session) {
    const values = [];
    const source = requirement.source?.kind;
    if (source) values.push(ui(SOURCE_LABELS[source] ?? source));
    const route = view?.development?.route;
    if (route) values.push(ui(ROUTE_LABELS[route] ?? route));
    const owner = view?.board?.assignment;
    if (owner?.kind === "user") values.push(ui("归属 我"));
    else if (owner?.actorId) values.push(ui`归属 ${agentDisplayName(owner.actorId)}`);
    if (!owner && session?.kind === "continuation") values.push(ui("接续"));
    return values;
  }

  /** A step's ring cut into one arc per ticket; finished tickets' arcs are green. */
  function segmentRing({ done, total }) {
    const radius = 8.25;
    const circumference = 2 * Math.PI * radius;
    const gap = total > 8 ? 1.2 : 2.4;
    const length = circumference / total - gap;
    const arcs = Array.from(
      { length: total },
      (_, index) =>
        `<circle class="rp-arc${index < done ? " is-done" : ""}" cx="9" cy="9" r="${radius}" stroke-dasharray="${length.toFixed(
          2
        )} ${(circumference - length).toFixed(2)}" stroke-dashoffset="${(-(index * circumference) / total - gap / 2).toFixed(2)}"/>`
    ).join("");
    return `<svg class="rp-ring" viewBox="0 0 18 18" aria-hidden="true">${arcs}</svg>`;
  }

  /** The phase in words over a row of dots, one per step. */
  function renderStepper(progress) {
    const current = progress.steps.find((step) => step.state === "current" || step.state === "blocked");
    const tone = progress.paused ? "paused" : progress.waiting ? "waiting" : (current?.state ?? "settled");
    const meta = current?.meta ?? "";
    const status = `<div class="rp-status" data-tone="${esc(tone)}"><span class="rp-status-dot" aria-hidden="true"></span><span class="rp-status-label">${esc(
      ui(progress.label)
    )}</span>${meta ? `<span class="rp-status-meta" title="${esc(meta)}">${esc(meta)}</span>` : ""}</div>`;
    return `<div class="rp-phase">${status}<ol class="rp-stepper" data-stage="${esc(progress.stage)}"${
      progress.paused ? ' data-paused="true"' : ""
    } aria-label="${ui("需求阶段")}">${progress.steps
      .map((step) => {
        const ring = step.segments && step.state !== "done" ? segmentRing(step.segments) : "";
        const node =
          step.state === "done"
            ? `<span class="rp-node">${icon("check")}</span>`
            : step.state === "pending"
              ? `<span class="rp-node is-pending${ring ? " is-segmented" : ""}">${ring}</span>`
              : `<span class="rp-node is-current${ring ? " is-segmented" : ""}">${ring}<span class="rp-pulse"></span></span>`;
        const active = step.state === "current" || step.state === "blocked";
        const label = ui(step.label);
        return `<li class="rp-step" data-step="${esc(step.id)}" data-state="${esc(step.state)}"${
          active ? ' aria-current="step"' : ""
        } title="${esc(
          [label, step.segments ? ui`票 ${step.segments.done}/${step.segments.total}` : "", step.meta]
            .filter(Boolean)
            .join(" · ")
        )}">${node}<span class="rp-step-label">${esc(
          label
        )}</span><span class="rp-step-meta">${esc(step.meta)}</span></li>`;
      })
      .join("")}</ol></div>`;
  }

  /** The row that unfolds the rest of a list. */
  const foldRow = (key, label, hidden) => {
    const open = unfolded.has(key);
    return `<button type="button" class="rp-fold" data-unfold="${esc(key)}" aria-expanded="${open}">${icon(
      open ? "chevron-up" : "chevron-down"
    )}<span>${esc(open ? ui("收起") : label.replace("{count}", String(hidden)))}</span></button>`;
  };

  function renderCriteria(criteria) {
    if (!criteria.length) return "";
    const met = criteria.filter((entry) => entry.checked).length;
    const long = criteria.length > FLAT_LIMIT;
    const shown = long && !unfolded.has("criteria") ? criteria.slice(0, FLAT_LIMIT) : criteria;
    return `<section class="rp-section"><div class="rp-section-head"><h3 class="rp-label">${ui(
      "完成标准"
    )}</h3><span class="rp-count is-end${met === criteria.length ? " is-done" : ""}">${met} / ${
      criteria.length
    }</span></div><ul class="rp-checks">${shown
      .map(
        (entry) =>
          `<li class="rp-check" data-checked="${entry.checked}" title="${esc(entry.text)}">${icon(
            "circle-check"
          )}<span>${esc(entry.text)}</span></li>`
      )
      .join(
        ""
      )}</ul>${long ? foldRow("criteria", ui("其余 {count} 条"), criteria.length - FLAT_LIMIT) : ""}</section>`;
  }

  function renderTickets(view) {
    const { rows, merged } = requirementTickets(view?.tickets);
    if (!rows.length) return "";
    return `<section class="rp-section"><h3 class="rp-label">${ui`票 ${merged}/${rows.length} 已并入`}</h3><ul class="rp-tickets">${rows
      .map(
        (ticket) =>
          `<li class="rp-ticket" data-ticket-state="${esc(ticket.state)}"><span class="rp-ticket-id">${esc(
            ticket.ticketId
          )}</span><span class="rp-ticket-title" title="${esc(ticket.title)}">${esc(
            ticket.title
          )}</span><span class="rp-spacer"></span><span class="rp-ticket-state">${esc(ui(ticket.label))}</span></li>`
      )
      .join("")}</ul></section>`;
  }

  function renderChanges(view) {
    const diff = view?.diff;
    const merge = [...(view?.merges || [])].reverse().find((entry) => entry.state === "merged");
    if (!diff && !merge) return "";
    const commit = shortCommit(diff?.candidateCommit ?? merge?.candidate?.commit);
    const files = diff?.files || [];
    // A long change leads with the files that changed most.
    const long = files.length > FLAT_LIMIT;
    const folded = long && !unfolded.has("diff");
    const shown = folded
      ? [...files]
          .sort(
            (a, b) => Number(b.additions) + Number(b.deletions) - (Number(a.additions) + Number(a.deletions))
          )
          .slice(0, FOLDED_ROWS)
      : files;
    return `<section class="rp-section"><div class="rp-section-head"><h3 class="rp-label">${ui("改动")}</h3>${
      files.length ? `<span class="rp-count">${files.length}</span>` : ""
    }</div><div class="rp-diff-card">${
      commit
        ? `<div class="rp-diff-commit">${icon("git-commit")}<span>${ui`候选 ${commit}`}</span><span class="rp-spacer"></span>${
            files.length
              ? `<button type="button" class="rp-link" data-open-diff>${ui("查看 diff")}</button>`
              : ""
          }</div>`
        : ""
    }${shown
      .map(
        (file) =>
          `<button type="button" class="rp-diff-file" data-open-file="${esc(file.path)}" title="${esc(
            file.path
          )}"><span class="rp-file">${fileIcon(file.path)}<span class="rp-file-name">${esc(
            file.path
          )}</span></span><span class="rp-spacer"></span><span class="rp-add">+${Number(
            file.additions
          )}</span><span class="rp-del">−${Number(file.deletions)}</span></button>`
      )
      .join(
        ""
      )}${long ? foldRow("diff", ui("其余 {count} 个"), files.length - FOLDED_ROWS) : ""}</div></section>`;
  }

  function attachmentRow(artifact, label, nested = false) {
    const path = artifact.relativePath;
    const name = artifact.displayName || baseName(path);
    const href = artifactRequestUrls(state.selected, path, artifactVersion(artifact)).downloadUrl;
    return `<span class="rp-attachment${nested ? " is-nested" : ""}" role="button" tabindex="0" data-artifact="${esc(
      path
    )}" title="${esc(path || name)}">${fileIcon(path || name)}<span class="rp-attachment-name">${esc(
      label ?? name
    )}</span><span class="rp-spacer"></span><a class="rp-download" href="${esc(href)}" download="${esc(
      name
    )}" aria-label="${ui`下载 ${name}`}" title="${ui`下载 ${name}`}">${icon("download")}</a></span>`;
  }

  /**
   * A few files are listed as they are. A longer list groups files under their
   * top-level folder, each folder folded, and shows only the first loose files.
   */
  function attachmentRows(artifacts) {
    if (artifacts.length <= FLAT_LIMIT) return artifacts.map((artifact) => attachmentRow(artifact));
    const loose = [];
    const folders = new Map();
    for (const artifact of artifacts) {
      const parts = String(artifact.relativePath || "")
        .split("/")
        .filter(Boolean);
      if (parts.length < 2) {
        loose.push(artifact);
        continue;
      }
      const folder = parts[0];
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder).push({ artifact, rest: parts.slice(1).join("/") });
    }
    const rows = [];
    const long = loose.length > FLAT_LIMIT;
    const looseShown = long && !unfolded.has("attachments") ? loose.slice(0, FOLDED_ROWS) : loose;
    rows.push(...looseShown.map((artifact) => attachmentRow(artifact)));
    if (long) rows.push(foldRow("attachments", ui("其余 {count} 个"), loose.length - FOLDED_ROWS));
    for (const [folder, entries] of folders) {
      const open = unfolded.has(`folder:${folder}`);
      rows.push(
        `<button type="button" class="rp-folder" data-unfold="${esc(`folder:${folder}`)}" aria-expanded="${open}">${icon(
          open ? "chevron-down" : "chevron-right"
        )}${icon(open ? "folder-open" : "folder")}<span class="rp-attachment-name">${esc(
          folder
        )}</span><span class="rp-spacer"></span><span class="rp-folder-count">${entries.length}</span></button>`
      );
      if (open) rows.push(...entries.map(({ artifact, rest }) => attachmentRow(artifact, rest, true)));
    }
    return rows;
  }

  function renderAttachments() {
    const artifacts = state.detail?.artifacts || [];
    if (!artifacts.length) return "";
    return `<section class="rp-section"><div class="rp-section-head"><h3 class="rp-label">${ui(
      "附件"
    )}</h3><span class="rp-count">${artifacts.length}</span></div><div class="rp-attachments" id="output-list">${attachmentRows(
      artifacts
    ).join("")}</div></section>`;
  }

  const noRequirementNote = () =>
    `<p class="rp-empty">${ui("这个会话没有关联需求。开发类任务开始后，这里会显示阶段、完成标准和改动。")}</p>`;

  function bodyMarkup(progress) {
    if (!state.selected) return "";
    // Files published by the conversation are its own records, so they stay
    // reachable even when no requirement is linked to it.
    const attachments = renderAttachments();
    if (!loaded) return attachments;
    if (loaded.error)
      return `<p class="rp-error" role="alert">${esc(loaded.error)}<button type="button" class="rp-link" data-retry>${ui("重试")}</button></p>${attachments}`;
    if (!loaded.requirement) return noRequirementNote() + attachments;
    const values = tagValues(loaded.requirement, loaded.view, loaded.session);
    return `<div class="rp-identity"><h3 class="rp-title" title="${esc(loaded.requirement.title)}">${esc(
      loaded.requirement.title
    )}</h3>${
      values.length
        ? `<div class="rp-tags">${values.map((value) => `<span class="rp-tag">${esc(value)}</span>`).join("")}</div>`
        : ""
    }</div>${renderStepper(progress)}${renderCriteria(progress.criteria)}${renderTickets(loaded.view)}${renderChanges(loaded.view)}${attachments}`;
  }

  function modelName() {
    // The model this session's Main ran on. `runtime.model` names the model the
    // next run would use once the session is idle, so it is only a fallback.
    const model = state.detail?.task?.model || state.detail?.runtime?.model;
    return model ? String(model).split("/").pop() : "";
  }

  function usageModel() {
    const statistics = state.detail?.statistics;
    const view = loaded?.view;
    const agents = statistics?.agents || [];
    const roleAgent = (role) => {
      const entry = (view?.roles || []).find((candidate) => candidate.role === role);
      return { entry, agent: entry ? agents.find((agent) => agent.agentId === entry.agentId) : undefined };
    };
    const main = agents.find((agent) => agent.agentId === "main");
    const executor = roleAgent("executor");
    const reviewer = roleAgent("reviewer");
    const roles = [
      { id: "main", name: ui("Main"), agent: modelName(), usage: main?.usage?.totalTokens ?? null },
      {
        id: "executor",
        name: ui("Executor"),
        agent: executor.entry ? agentDisplayName(executor.entry.agentId) : "",
        usage: executor.agent?.usage?.totalTokens ?? null
      },
      {
        id: "reviewer",
        name: ui("Reviewer"),
        agent: reviewer.entry ? agentDisplayName(reviewer.entry.agentId) : "",
        usage: reviewer.agent?.usage?.totalTokens ?? null
      }
    ].filter((role) => role.id === "main" || role.agent);
    const largest = Math.max(1, ...roles.map((role) => Number(role.usage) || 0));
    const activityAgents = state.detail?.task?.activity?.agents || [];
    const toolCalls = activityAgents.reduce(
      (sum, agent) =>
        sum + (agent.samples || []).reduce((count, sample) => count + (sample.toolCalls || 0), 0),
      0
    );
    const subagents = agents.filter((agent) => agent.agentId !== "main").length;
    const reworks = (view?.reviews || []).reduce((count, review) => count + (review.reworks?.length || 0), 0);
    const usage = statistics?.usage;
    // Cache writes are input the provider billed while filling its cache.
    const split =
      usage && usage.totalTokens
        ? [
            { id: "cache", label: ui("缓存命中"), value: Number(usage.cacheRead) || 0 },
            {
              id: "input",
              label: ui("输入"),
              value: (Number(usage.input) || 0) + (Number(usage.cacheWrite) || 0)
            },
            { id: "output", label: ui("输出"), value: Number(usage.output) || 0 }
          ]
        : [];
    return {
      available: Boolean(statistics),
      total: usage?.totalTokens ?? null,
      split,
      roles,
      largest,
      facts: [
        toolCalls ? ui("{count} 次工具调用").replace("{count}", String(toolCalls)) : "",
        subagents ? ui("{count} 个子 Agent").replace("{count}", String(subagents)) : "",
        reworks ? ui("{count} 次返修").replace("{count}", String(reworks)) : ""
      ].filter(Boolean)
    };
  }

  function usageText(model) {
    // Elapsed time belongs to the run bar, which counts it live.
    return model.total === null ? ui("Token 未知") : `${compactTokens(model.total)} tokens`;
  }

  /** The usage row; opened, a card above it splits the tokens by kind and by role. */
  function renderUsage(model) {
    if (!model.available) return "";
    const head = `<button type="button" class="rp-usage-head" data-usage-toggle aria-expanded="${expanded}" aria-controls="requirement-usage-detail">${icon(
      "gauge"
    )}<span class="rp-usage-label">${ui("用量")}</span><span class="rp-spacer"></span><span class="rp-usage-value">${esc(
      usageText(model)
    )}</span>${icon(expanded ? "chevron-up" : "chevron-right")}</button>`;
    if (!expanded) return `<div class="rp-usage" data-expanded="false">${head}</div>`;
    const sum = model.split.reduce((total, part) => total + part.value, 0) || 1;
    const split = model.split.length
      ? `<div class="rp-split-bar" aria-hidden="true">${model.split
          .map(
            (part) =>
              `<span class="rp-split-part" data-part="${part.id}" style="flex-grow:${part.value / sum}"></span>`
          )
          .join("")}</div><div class="rp-split">${model.split
          .map(
            (part) =>
              `<div class="rp-split-item" data-part="${part.id}"><span class="rp-split-label">${esc(
                part.label
              )}</span><span class="rp-split-value">${esc(compactTokens(part.value))}</span></div>`
          )
          .join("")}</div>`
      : "";
    const roles = model.roles
      .map(
        (role) =>
          `<div class="rp-role" data-role="${esc(role.id)}"><div class="rp-role-top"><span class="rp-role-name">${esc(
            role.name
          )}</span><span class="rp-role-agent">${esc(role.agent)}</span><span class="rp-spacer"></span><span class="rp-role-value">${esc(
            compactTokens(role.usage)
          )}</span></div><div class="rp-role-track"><div class="rp-role-fill" style="transform:scaleX(${(
            (Number(role.usage) || 0) / model.largest
          ).toFixed(4)})"></div></div></div>`
      )
      .join("");
    const facts = model.facts.length
      ? `<div class="rp-divider"></div><p class="rp-facts">${model.facts.map(esc).join(" · ")}</p>`
      : "";
    return `<div class="rp-usage" data-expanded="true"><div class="rp-usage-card" id="requirement-usage-detail" role="group" aria-label="${ui(
      "用量"
    )}"><div class="rp-usage-total"><strong>${esc(compactTokens(model.total))}</strong><span>tokens</span></div>${split}<div class="rp-divider"></div><div class="rp-roles">${roles}</div>${facts}</div>${head}</div>`;
  }

  function bindBody() {
    const body = $("[data-requirement-body]");
    if (!body) return;
    body.querySelector("[data-retry]")?.addEventListener("click", () => {
      loaded = null;
      bodySignature = undefined;
      epoch += 1;
      render();
    });
    body.querySelector("[data-open-diff]")?.addEventListener("click", () => openPreview({ tab: "diff" }));
    for (const node of body.querySelectorAll("[data-open-file]"))
      node.addEventListener("click", () => openPreview({ tab: "file", path: node.dataset.openFile }));
    const activate = (node, run) => {
      const open = (event) => {
        if (event.target.closest(".rp-download")) return;
        run();
      };
      node.addEventListener("click", open);
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open(event);
        }
      });
    };
    for (const node of body.querySelectorAll("[data-artifact]"))
      activate(node, () => openArtifact(node.dataset.artifact));
    for (const node of body.querySelectorAll("[data-unfold]"))
      node.addEventListener("click", () => {
        const key = node.dataset.unfold;
        if (unfolded.has(key)) unfolded.delete(key);
        else unfolded.add(key);
        bodySignature = undefined;
        render();
        body.querySelector(`[data-unfold="${CSS.escape(key)}"]`)?.focus();
      });
  }

  function setUsageOpen(value, { focus = true } = {}) {
    if (expanded === value) return;
    expanded = value;
    usageSignature = undefined;
    render();
    if (focus) $("[data-requirement-usage] [data-usage-toggle]")?.focus();
    const card = $("[data-requirement-usage] .rp-usage-card");
    if (card)
      animate(
        card,
        [
          { opacity: 0, transform: "translateY(6px) scale(0.98)" },
          { opacity: 1, transform: "none" }
        ],
        {
          duration: motionDuration("--motion-base", 200),
          easing:
            getComputedStyle(document.documentElement).getPropertyValue("--ease-standard").trim() ||
            "ease-out"
        }
      );
  }

  // The open card closes on Escape or a press anywhere outside it.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && expanded && $("[data-requirement-usage] .rp-usage-card"))
      setUsageOpen(false);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!expanded) return;
    const usage = $("[data-requirement-usage]");
    if (usage && !usage.contains(event.target)) setUsageOpen(false, { focus: false });
  });

  function bindUsage() {
    const toggle = $("[data-requirement-usage] [data-usage-toggle]");
    toggle?.addEventListener("click", () => setUsageOpen(!expanded));
  }

  /** What kind of content the body shows and which phases and criteria are done. */
  function bodyMarks(body) {
    return {
      kind: `${state.selected}|${loaded?.requirement?.requirementId ?? (loaded ? "work" : "none")}`,
      done: new Set(
        [...body.querySelectorAll('.rp-step[data-state="done"]')].map((step) => step.dataset.step)
      ),
      checked: [...body.querySelectorAll(".rp-check")].map((check) => check.dataset.checked === "true")
    };
  }

  /**
   * New content fades in; on the same requirement, a phase that just finished
   * pops its check and newly met criteria light up one after another.
   */
  function animateBody(body, before) {
    const after = bodyMarks(body);
    if (after.kind !== before.kind) {
      animate(body, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
      return;
    }
    const pop = (node, delay = 0) =>
      node &&
      animate(
        node,
        [
          { transform: "scale(0.5)", opacity: 0.3 },
          { transform: "scale(1.15)", opacity: 1, offset: 0.6 },
          { transform: "scale(1)" }
        ],
        { duration: 260, delay, easing: "ease-out", fill: "backwards" }
      );
    for (const step of body.querySelectorAll('.rp-step[data-state="done"]'))
      if (!before.done.has(step.dataset.step)) pop(step.querySelector(".rp-node"));
    let order = 0;
    body.querySelectorAll(".rp-check").forEach((check, index) => {
      if (check.dataset.checked === "true" && before.checked[index] === false)
        pop(check.querySelector(".ui-icon"), 70 * order++);
    });
  }

  function render() {
    if (!$("[data-requirement-panel]")) return;
    // The selected requirement's phase also labels the run bar, so the records
    // are read even while the panel itself is collapsed. The panel keeps its
    // last rendering for the moment it reopens.
    // A temporary workspace belongs to no project, so it has no requirement
    // records to read; the conversation's own usage still applies.
    if (state.selected && selectedProjectId()) ensure(state.selected);
    const progress = loaded?.requirement ? progressOf() : undefined;
    stage = progress?.label ?? "";
    onRendered(stage);
    paintToggle();
    if (document.body.classList.contains("output-collapsed")) return;
    const body = $("[data-requirement-body]");
    const usage = $("[data-requirement-usage]");
    if (!body || !usage) return;
    const model = usageModel();
    const signature = JSON.stringify([
      state.selected,
      progress?.steps,
      progress?.label,
      progress?.paused,
      loaded?.error ?? null,
      loaded?.session ?? null,
      loaded?.requirement ?? null,
      loaded?.view
        ? [
            loaded.view.stage,
            loaded.view.diff,
            loaded.view.reviews,
            loaded.view.merges,
            loaded.view.roles,
            loaded.view.tickets,
            loaded.view.development?.route,
            loaded.view.development?.status,
            loaded.view.development?.reason,
            loaded.view.board?.assignment
          ]
        : null,
      (state.detail?.artifacts ?? []).map((row) => [row.relativePath, artifactVersion(row)])
    ]);
    if (signature !== bodySignature) {
      bodySignature = signature;
      const before = bodyMarks(body);
      const scrollTop = body.scrollTop;
      body.innerHTML = bodyMarkup(progress);
      body.scrollTop = scrollTop;
      bindBody();
      animateBody(body, before);
    }
    const nextUsage = JSON.stringify([model.available, expanded, model.roles, model.split, model.facts]);
    if (nextUsage !== usageSignature) {
      usageSignature = nextUsage;
      usage.innerHTML = renderUsage(model);
      bindUsage();
    }
    const value = usage.querySelector(".rp-usage-value");
    if (value) value.textContent = usageText(model);
  }

  return {
    render,
    reset,
    // Ticket assignments can change on another backend without a local Task event.
    refreshVisibleDevelopment() {
      if (
        loaded?.taskId === state.selected &&
        ["active", "paused"].includes(loaded?.view?.development?.status) &&
        $("[data-requirement-panel]")?.getClientRects().length &&
        !document.body.classList.contains("output-collapsed")
      )
        ensure(state.selected);
    },
    /** Repaint the title-row control after its panel opened or closed. */
    paintToggle,
    /** The records the panel already read, for the caller that opens the preview drawer. */
    records: () => loaded,
    progress: () => (loaded?.requirement ? progressOf() : null),
    /** Re-read after the conversation's records changed outside polling. */
    reload() {
      if (!state.selected) return;
      loaded = null;
      bodySignature = undefined;
      epoch += 1;
      render();
    },
    setExpanded(value) {
      expanded = Boolean(value);
      usageSignature = undefined;
      render();
    },
    collapse: () => onCollapse()
  };
}
