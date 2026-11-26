import { agentDisplayName } from "../agent-names.js";
import {
  REQUIREMENT_TABS,
  requirementProgress,
  requirementTab,
  requirementTabCounts
} from "../requirement-stages.js";
import { ui } from "../ui/language.js";
import { createModal } from "../ui/modal.js";
import { formatStamp } from "../ui/time-format.js";
import { createVisiblePoll } from "../ui/visible-poll.js";
import { escapeHtml as esc } from "../ui/html.js";
import {
  requirementDetailMarkup,
  requirementDetailShell,
  shortCommit
} from "./observe-requirement-detail.js";

/**
 * The observation requirement view: every connected node's requirements in one
 * list, with one requirement's recorded facts in the detail beside it.
 *
 * The view is read-only and reads only through the observation data port, so a
 * node's session and token never leave that node and a node that stops
 * answering only empties its own rows. The phase comes from the shared mapping
 * the work panel uses, so both surfaces name the same phase the same way.
 *
 * Reads per project, not per requirement: its Main sessions, its board and
 * every requirement's phase records in one call each. Only the opened
 * requirement reads its full delivery view (diff, review report), the record
 * set the work panel renders. A requirement without a development has no
 * phase and keeps the one its ledger and board records describe.
 */

const enc = encodeURIComponent;
const SOURCE_LABELS = { internal: "内部", external: "看板", legacy: "历史" };
const PROJECT_READ_MS = 15_000;
const VIEW_READ_MS = 15_000;
/** Rows drawn at first and added each time the list is scrolled to its end. */
const PAGE_ROWS = 50;

const projectPath = (projectId, suffix = "") => `/api/projects/${enc(projectId)}${suffix}`;
const readError = (error) => error?.message || ui("读取失败");

/**
 * @param {object} options
 * @param {HTMLElement} options.pane       the observation panel
 * @param {HTMLElement} options.detail     the detail column beside it
 * @param {HTMLElement} options.layout     the shell, which sizes the detail column
 * @param {object} options.data            the read-only observation port
 * @param {(message: string) => void} [options.showToast]
 * @param {() => Date} [options.now]
 */
export function createObserveRequirements({
  pane,
  detail,
  layout,
  data,
  showToast = () => {},
  now = () => new Date()
}) {
  const body = pane?.querySelector("[data-observe-requirements-list]");
  if (!body || !detail) return { render() {}, applyEntry() {}, refresh() {}, dispose() {} };
  const $ = (selector) => pane.querySelector(selector);
  const actions = $("[data-observe-requirements-actions]");
  const tabsNode = $("[data-observe-requirements-tabs]");
  const search = $("[data-observe-search]");
  const publishButton = $("[data-observe-publish]");

  /** projectId → { origin, sessions, board, at } */
  const projects = new Map();
  /** origin|projectId → { phases, at }: every requirement's phase records, read per project. */
  const phases = new Map();
  /** origin|projectId|requirementId → { view, at } — the full view of the opened requirement. */
  const details = new Map();
  /** origin|projectId|requirementId → { context, stamp, failed } — the ledger detail of an opened requirement. */
  const contexts = new Map();
  const pending = new Set();
  const publishRequests = new Map();
  let tab = "all";
  let query = "";
  let selected = null;
  // The lists the reader unfolded in the open detail, and the body last drawn.
  let unfolded = new Set();
  let drawnDetail = "";
  let drawnKey = null;
  let shown = PAGE_ROWS;
  let refreshTimer;

  const viewKey = (row) => `${row.origin}|${row.projectId}|${row.requirementId}`;
  const phaseKey = (row) => `${row.origin}|${row.projectId}`;
  /**
   * The opened requirement's full view once read, else its phase records. A
   * closed one always takes the latest phases: its full view stops refreshing
   * once the detail closes.
   */
  const viewOf = (row) =>
    (viewKey(row) === selected ? details.get(viewKey(row))?.view : undefined) ??
    phases.get(phaseKey(row))?.phases?.[row.requirementId];
  // Only the visible view reads: the entry switch hides the pane and the view
  // switch hides this section, and a hidden list must not keep reading the
  // nodes it was showing.
  const active = () => !pane.hidden && !body.hidden;

  /* ------------------------------------------------------------------ reads */

  function scopeProjects() {
    return data.scoped({ ...data.filter(), projectId: "" }).projects;
  }

  function projectEntry(projectId, origin) {
    const cached = projects.get(projectId);
    if (cached?.origin === origin) return cached;
    const entry = { origin, sessions: [], board: [], at: 0 };
    projects.set(projectId, entry);
    return entry;
  }

  async function loadProject(project, force) {
    const origin = project.origins?.[0] ?? project.origin;
    const entry = projectEntry(project.projectId, origin);
    if (!force && entry.at && now().valueOf() - entry.at < PROJECT_READ_MS) return;
    const [sessions, board] = await Promise.all([
      data
        .read(origin, projectPath(project.projectId, "/main-sessions"))
        .then((result) => (Array.isArray(result?.sessions) ? result.sessions : []))
        // A node that cannot list its sessions still names the project's board
        // and requirements; only the handling session column stays empty.
        // eslint-disable-next-line no-restricted-syntax -- 读不到会话列表只少一列，项目的其余记录仍然要显示
        .catch(() => []),
      data
        .read(origin, projectPath(project.projectId, "/board"))
        .then((result) => (Array.isArray(result?.entries) ? result.entries : []))
        // eslint-disable-next-line no-restricted-syntax -- 读不到看板只影响归属与看板阶段，台账需求仍然要显示
        .catch(() => [])
    ]);
    entry.sessions = sessions;
    entry.board = board;
    entry.at = now().valueOf();
  }

  async function loadPhases(projectId, origin, force) {
    const key = `${origin}|${projectId}`;
    const cached = phases.get(key);
    if (pending.has(key)) return;
    if (!force && cached && now().valueOf() - cached.at < VIEW_READ_MS) return;
    pending.add(key);
    try {
      const result = await data.read(origin, projectPath(projectId, "/deliveries"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "phases" })
      });
      phases.set(key, { phases: result?.phases ?? {}, at: now().valueOf() });
      // eslint-disable-next-line no-restricted-syntax -- 一个节点读不到阶段时，该项目的需求保留上次读到的阶段，其余项目照常显示
    } catch {
      phases.set(key, { phases: cached?.phases ?? {}, at: cached?.at ?? 0 });
    } finally {
      pending.delete(key);
    }
  }

  async function loadDetail(row, force) {
    const key = `detail|${viewKey(row)}`;
    const cached = details.get(viewKey(row));
    if (pending.has(key)) return;
    if (!force && cached && now().valueOf() - cached.at < VIEW_READ_MS) return;
    pending.add(key);
    try {
      const result = await data.read(row.origin, projectPath(row.projectId, "/deliveries"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "view", requirementId: row.requirementId })
      });
      details.set(viewKey(row), { view: result?.view, at: now().valueOf() });
      // eslint-disable-next-line no-restricted-syntax -- 404 是“还没有开发”；其他失败时详情先用阶段记录，下次刷新再读
    } catch {
      details.set(viewKey(row), { view: cached?.view, at: now().valueOf() });
    } finally {
      pending.delete(key);
    }
    // A reply that arrives after the view was left or another row was opened
    // only fills the cache.
    if (active() && selected === viewKey(row)) render();
  }

  /** What the ledger detail was read at: a merge bumps the revision; a new, paused or withdrawn development does not. */
  const contextStamp = (row) =>
    `${row.revision}|${row.view?.development?.developmentId ?? ""}|${row.view?.development?.revision ?? ""}`;

  /** The opened requirement's ledger: one context read per revision and development. */
  async function loadContext(row) {
    const key = `context|${viewKey(row)}`;
    if (pending.has(key)) return;
    pending.add(key);
    try {
      const result = await data.read(row.origin, projectPath(row.projectId, "/ledger"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "context", requirementId: row.requirementId })
      });
      contexts.set(viewKey(row), { context: result?.context, stamp: contextStamp(row) });
    } catch (error) {
      contexts.set(viewKey(row), { stamp: contextStamp(row), failed: readError(error) });
    } finally {
      pending.delete(key);
    }
    if (selected === row.key) render();
  }

  async function refresh({ force = false } = {}) {
    const rows = data.scoped(data.filter()).requirements;
    const targets = new Map();
    for (const row of rows) {
      const project = targets.get(row.projectId);
      if (!project) targets.set(row.projectId, { projectId: row.projectId, origins: [row.origin] });
      else if (!project.origins.includes(row.origin)) project.origins.push(row.origin);
    }
    await Promise.all(
      [...targets.values()].flatMap((project) => [
        loadProject(project, force),
        ...project.origins.map((origin) => loadPhases(project.projectId, origin, force))
      ])
    );
    const opened = selected && rows.find((row) => viewKey(row) === selected);
    if (opened) await loadDetail(opened, force);
    render();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (active()) void refresh();
    }, 300);
  }

  /* ------------------------------------------------------------------- rows */

  function indexBy(list, key) {
    const index = new Map();
    for (const item of list) if (item?.[key]) index.set(item[key], item);
    return index;
  }

  function sessionFor(row, project) {
    const sessions = project?.sessions ?? [];
    return (
      sessions.find((session) => session.currentRequirementId === row.requirementId) ??
      sessions.find((session) => session.taskId === viewOf(row)?.development?.taskId)
    );
  }

  function mergeFor(view, board, delivery) {
    const merged = [...(view?.merges ?? [])].reverse().find((entry) => entry?.state === "merged");
    if (merged)
      return { branch: merged.targetBranch, commit: merged.mergeCommit ?? merged.candidate?.commit };
    if (delivery) return { branch: delivery.targetBranch, commit: delivery.mergedCommit };
    if (board?.delivery) return { branch: "", commit: board.delivery.mergedCommit };
    return undefined;
  }

  /**
   * Who owns the requirement.
   *
   * A board need names its own assignee, and an unclaimed one has none. A need
   * recorded inside a project belongs to the person working this machine, so it
   * reads 我 instead of an empty cell.
   */
  function ownerFor(board, requirement) {
    const assignment = board?.assignment;
    if (!assignment) return requirement?.source?.kind === "internal" ? ui("我") : "";
    if (assignment.kind !== "main") return ui("我");
    const actor = assignment.actorId ?? "";
    return actor && !actor.startsWith("session:") ? agentDisplayName(actor) : ui("Main");
  }

  function rows() {
    const scope = data.filter();
    const tasks = indexBy(data.scoped(scope).tasks, "taskId");
    const projectNames = indexBy(data.scoped({ ...scope, projectId: "" }).projects, "projectId");
    return data
      .scoped(scope)
      .requirements.map((requirement) => {
        const project = projects.get(requirement.projectId);
        const board = (project?.board ?? []).find(
          (entry) => entry.requirementId === requirement.requirementId
        );
        const view = viewOf(requirement);
        const session = sessionFor(requirement, project);
        const facts = {
          requirement,
          board,
          development: view?.development,
          plan: view?.plan,
          reviews: view?.reviews,
          merges: view?.merges,
          delivery: view?.delivery,
          roles: view?.roles,
          tickets: view?.tickets,
          waitingForReply: Boolean(session?.taskId && tasks.get(session.taskId)?.pendingQuestion)
        };
        const progress = requirementProgress(facts);
        return {
          ...requirement,
          key: viewKey(requirement),
          projectName: projectNames.get(requirement.projectId)?.projectName ?? "",
          facts,
          progress,
          tab: requirementTab(facts),
          source: SOURCE_LABELS[requirement.source?.kind] ?? requirement.source?.kind ?? "",
          session: session?.title ?? "",
          owner: ownerFor(board, requirement),
          merge: mergeFor(view, board, view?.delivery),
          view,
          at: requirement.updatedAt
        };
      })
      .sort((left, right) => String(right.at ?? "").localeCompare(String(left.at ?? "")));
  }

  function matching(list) {
    const text = query.trim().toLowerCase();
    if (!text) return list;
    return list.filter((row) =>
      [row.title, row.summary, row.projectName].some((value) =>
        String(value ?? "")
          .toLowerCase()
          .includes(text)
      )
    );
  }

  /* ----------------------------------------------------------------- markup */

  function stamp(value) {
    return formatStamp(value, window.formicandPreferences?.format() ?? "relative", now().valueOf());
  }

  function tabMarkup(counts, current) {
    return REQUIREMENT_TABS.map(
      (entry) =>
        `<button type="button" role="tab" class="or-tab" data-observe-tab="${entry.id}" aria-selected="${
          entry.id === current
        }" tabindex="${entry.id === current ? 0 : -1}"><span class="or-tab-label">${esc(
          ui(entry.label)
        )}</span><span class="or-tab-count">${counts[entry.id] ?? 0}</span></button>`
    ).join("");
  }

  function rowMarkup(row, current) {
    const dash = (value) => (value ? esc(value) : "—");
    return `<div class="or-row${row.key === current ? " is-current" : ""}" role="row" data-observe-requirement="${esc(
      row.key
    )}" tabindex="0"${row.key === current ? ' aria-current="true"' : ""}>
      <span class="or-cell or-cell-title" role="cell"><span class="or-title">${esc(row.title)}</span>${
        row.source ? `<span class="or-source">${esc(ui(row.source))}</span>` : ""
      }</span>
      <span class="or-cell or-col-stage" role="cell"><span class="or-pill" data-stage="${esc(
        row.progress.stage
      )}"${row.progress.waiting ? ' data-waiting="true"' : ""}${
        row.progress.paused ? ' data-paused="true"' : ""
      }>${esc(ui(row.progress.label))}</span></span>
      <span class="or-cell or-col-session" role="cell" title="${esc(row.session)}">${dash(row.session)}</span>
      <span class="or-cell or-col-owner" role="cell">${dash(row.owner)}</span>
      <span class="or-cell or-col-commit" role="cell">${dash(row.merge?.commit ? shortCommit(row.merge.commit) : "")}</span>
      <span class="or-cell or-col-updated" role="cell">${esc(stamp(row.at))}</span>
    </div>`;
  }

  function setTitle() {
    const scope = data.filter();
    const project = scope.projectId
      ? data.scoped(scope).projects.find((entry) => entry.projectId === scope.projectId)
      : undefined;
    const title = pane.querySelector("#observe-title");
    if (title)
      title.textContent = project?.projectName ? ui`${ui("需求")} · ${project.projectName}` : ui("需求");
  }

  function focusedKey() {
    const focused = document.activeElement;
    return focused && body.contains(focused)
      ? focused.closest("[data-observe-requirement]")?.dataset.observeRequirement
      : undefined;
  }

  function render() {
    const all = matching(rows());
    const counts = requirementTabCounts(all.map((row) => row.facts));
    if (selected && !all.some((row) => row.key === selected)) selected = null;
    if (!pane.hidden) setTitle();
    if (tabsNode) tabsNode.innerHTML = tabMarkup(counts, tab);
    if (publishButton) publishButton.disabled = !scopeProjects().length;
    const visible = tab === "all" ? all : all.filter((row) => row.tab === tab);
    const drawn = visible.slice(0, shown);
    const restore = focusedKey();
    body.innerHTML = `<div class="or-table" role="table" aria-label="${esc(ui("需求"))}">
      <div class="or-row or-head" role="row">
        <span class="or-cell or-cell-title" role="columnheader">${esc(ui("需求"))}</span>
        <span class="or-cell or-col-stage" role="columnheader">${esc(ui("阶段"))}</span>
        <span class="or-cell or-col-session" role="columnheader">${esc(ui("处理会话"))}</span>
        <span class="or-cell or-col-owner" role="columnheader">${esc(ui("归属"))}</span>
        <span class="or-cell or-col-commit" role="columnheader">${esc(ui("合入"))}</span>
        <span class="or-cell or-col-updated" role="columnheader">${esc(ui("更新"))}</span>
      </div>${
        visible.length
          ? drawn.map((row) => rowMarkup(row, selected)).join("") +
            (drawn.length < visible.length
              ? `<div class="or-more" data-observe-more aria-hidden="true"></div>`
              : "")
          : `<div class="or-empty" role="row"><span class="or-cell" role="cell">${esc(
              ui(query.trim() ? "没有匹配的需求" : "没有需求")
            )}</span></div>`
      }</div>`;
    watchMore();
    renderDetail(all.find((row) => row.key === selected) ?? null);
    if (restore) body.querySelector(`[data-observe-requirement="${CSS.escape(restore)}"]`)?.focus();
  }

  /** Draw the next rows once the end of the drawn ones scrolls into view. */
  const more =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          shown += PAGE_ROWS;
          render();
        })
      : undefined;

  function watchMore() {
    more?.disconnect();
    const sentinel = body.querySelector("[data-observe-more]");
    if (sentinel) more?.observe(sentinel);
  }

  /* ----------------------------------------------------------------- detail */

  function renderDetail(row) {
    if (layout) layout.dataset.observeDetail = row ? "open" : "closed";
    detail.hidden = !row;
    if (!row) {
      detail.replaceChildren();
      drawnDetail = "";
      drawnKey = null;
      return;
    }
    if (!details.has(row.key)) void loadDetail(row);
    if (contexts.get(row.key)?.stamp !== contextStamp(row)) void loadContext(row);
    // The header stays and only the body is redrawn, and only when it changed,
    // so a refresh keeps the reader's scroll position.
    let content = detail.querySelector(".or-detail-body");
    if (!content) {
      detail.innerHTML = requirementDetailShell();
      content = detail.querySelector(".or-detail-body");
      drawnDetail = "";
    }
    const markup = requirementDetailMarkup(row, contexts.get(row.key), unfolded);
    if (markup === drawnDetail) return;
    drawnDetail = markup;
    content.innerHTML = markup;
    // Another requirement starts at its top.
    if (drawnKey !== row.key) content.scrollTop = 0;
    drawnKey = row.key;
  }

  /* ---------------------------------------------------------------- actions */

  function select(key) {
    if (key !== selected) unfolded = new Set();
    selected = key;
    render();
    body.querySelector(`[data-observe-requirement="${CSS.escape(key)}"]`)?.focus();
  }

  function chooseTab(id) {
    if (!REQUIREMENT_TABS.some((entry) => entry.id === id)) return;
    tab = id;
    shown = PAGE_ROWS;
    render();
    tabsNode?.querySelector(`[data-observe-tab="${id}"]`)?.focus();
  }

  function openPublish() {
    const projects = scopeProjects();
    if (!projects.length) return;
    const scope = data.filter();
    const preferred = projects.find((project) => project.projectId === scope.projectId) ?? projects[0];
    const panel = document.createElement("div");
    panel.className = "modal-backdrop app-dialog-backdrop";
    panel.hidden = true;
    panel.innerHTML = `<section class="modal-card app-dialog or-publish" role="dialog" aria-modal="true" aria-labelledby="or-publish-title">
      <h2 id="or-publish-title">${esc(ui("发布到看板"))}</h2>
      <form novalidate>
        ${
          projects.length > 1
            ? `<label class="dialog-field">${esc(ui("项目"))}<select name="projectId">${projects
                .map(
                  (project) =>
                    `<option value="${esc(project.projectId)}"${
                      project.projectId === preferred.projectId ? " selected" : ""
                    }>${esc(project.projectName)}</option>`
                )
                .join("")}</select></label>`
            : ""
        }
        <label class="dialog-field">${esc(ui("标题"))}<input name="title" maxlength="200" required autocomplete="off"></label>
        <label class="dialog-field">${esc(
          ui("需求")
        )}<textarea name="content" rows="4" maxlength="20000" required></textarea></label>
        <p class="dialog-error" role="alert" data-error hidden></p>
        <div class="dialog-actions"><button class="app-button is-secondary" type="button" data-close>${esc(
          ui("取消")
        )}</button><button class="app-button is-primary" type="submit">${esc(ui("发布"))}</button></div>
      </form>
    </section>`;
    document.body.append(panel);
    const modal = createModal(panel, panel.querySelector("[data-close]"), { onClose: () => panel.remove() });
    const error = panel.querySelector("[data-error]");
    panel.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      void publish(panel, modal, error);
    });
    modal.open();
  }

  async function publish(panel, modal, error) {
    const form = panel.querySelector("form");
    const title = form.querySelector('[name="title"]').value.trim();
    const content = form.querySelector('[name="content"]').value.trim();
    const projects = scopeProjects();
    const wanted = form.querySelector('[name="projectId"]')?.value ?? data.filter().projectId;
    const project = projects.find((entry) => entry.projectId === wanted) ?? projects[0];
    if (!project || !title || !content) {
      error.textContent = ui("标题与需求内容不能为空");
      error.hidden = false;
      return;
    }
    // One publish is one board entry even if the click is repeated, so the
    // request id is kept per project until the call is answered.
    if (!publishRequests.has(project.projectId))
      publishRequests.set(
        project.projectId,
        globalThis.crypto?.randomUUID?.() ?? `publish-${now().valueOf()}-${project.projectId}`
      );
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    const origin = project.origins?.[0] ?? project.origin;
    try {
      await data.read(origin, projectPath(project.projectId, "/board"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "publish",
          requestId: publishRequests.get(project.projectId),
          title,
          content,
          source: { kind: "external" }
        })
      });
      publishRequests.delete(project.projectId);
      modal.close();
      showToast(ui("需求已发布"));
      await data.refreshRequirements(origin);
      await refresh({ force: true });
    } catch (failure) {
      submit.disabled = false;
      error.textContent = readError(failure);
      error.hidden = false;
    }
  }

  /* ----------------------------------------------------------------- events */

  const onClick = (event) => {
    if (event.target.closest("[data-observe-publish]")) {
      openPublish();
      return;
    }
    const tabButton = event.target.closest("[data-observe-tab]");
    if (tabButton) {
      chooseTab(tabButton.dataset.observeTab);
      return;
    }
    const row = event.target.closest("[data-observe-requirement]");
    if (row) select(row.dataset.observeRequirement);
  };
  pane.addEventListener("click", onClick);

  // A row is a focusable cell group, so Enter and Space open it like a button.
  const onKeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("[data-observe-requirement]");
    if (!row || event.target.closest("button")) return;
    event.preventDefault();
    select(row.dataset.observeRequirement);
  };
  pane.addEventListener("keydown", onKeydown);

  const onTabsKeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const index = REQUIREMENT_TABS.findIndex((entry) => entry.id === tab);
    if (index < 0) return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : REQUIREMENT_TABS.length - 1;
    chooseTab(REQUIREMENT_TABS[(index + step) % REQUIREMENT_TABS.length].id);
  };
  tabsNode?.addEventListener("keydown", onTabsKeydown);

  search?.addEventListener("input", () => {
    query = search.value;
    shown = PAGE_ROWS;
    render();
  });

  const onDetailClick = (event) => {
    if (event.target.closest("[data-observe-detail-close]")) {
      selected = null;
      render();
      return;
    }
    const fold = event.target.closest("[data-unfold]");
    if (!fold) return;
    const key = fold.dataset.unfold;
    if (unfolded.has(key)) unfolded.delete(key);
    else unfolded.add(key);
    render();
    detail.querySelector(`[data-unfold="${CSS.escape(key)}"]`)?.focus();
  };
  detail.addEventListener("click", onDetailClick);

  const unsubscribe = data.subscribe(() => {
    if (!active()) return;
    render();
    scheduleRefresh();
  });

  const poll = createVisiblePoll({
    run: () => refresh({ force: true }),
    intervalMs: VIEW_READ_MS,
    active: false
  });

  render();

  return {
    /** The entry or view changed: read only while the requirements view is shown. */
    applyEntry({ mode, observeView } = {}) {
      const shown = mode === "observe" && observeView === "requirements";
      // The panel's chrome and the second column belong to this view, so the
      // view decides when they are shown instead of the entry controller
      // hiding everything but one layer.
      if (actions) actions.hidden = !shown;
      if (tabsNode) tabsNode.hidden = !shown;
      poll.setActive(Boolean(shown) && active());
      if (!shown) {
        // Another observation view took the panel: its own content needs the
        // width, and the selection comes back when this view does.
        if (layout) layout.dataset.observeDetail = "closed";
        detail.hidden = true;
        return;
      }
      render();
      void refresh();
    },
    render,
    refresh,
    dispose() {
      clearTimeout(refreshTimer);
      more?.disconnect();
      poll.dispose();
      unsubscribe?.();
      pane.removeEventListener("click", onClick);
      pane.removeEventListener("keydown", onKeydown);
      tabsNode?.removeEventListener("keydown", onTabsKeydown);
      detail.removeEventListener("click", onDetailClick);
    }
  };
}
