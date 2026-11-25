import { ui } from "../ui/language.js";
import { icon } from "../ui/icons.js";
import { createModal } from "../ui/modal.js";
import { animate, motionDuration, reducedMotion } from "../ui/motion.js";
import { createMenu } from "../ui/menu.js";
import { escapeHtml as esc } from "../ui/html.js";
import { agentAvatar } from "../agent-names.js";
import { formatRunDuration } from "../run-overview.js";

/** Project navigation, directory settings and creation do not mutate conversation drafts. */
export function createProjectController({
  state,
  $,
  api,
  storage,
  showToast,
  beginConversation,
  selectConversation,
  conversationTitle,
  openTaskMenu,
  quickTaskAction = () => {},
  onRendered = () => {},
  getNavigationIdentity,
  onSelectionChanged = () => {},
  isTaskVisible = () => true,
  isUnread = () => false,
  openAddProject,
  onUpdated = () => {}
}) {
  /** Change commands carry an operation id; the fallback keeps partial handlers working. */
  const command = (path, options) => (api.command ? api.command(path, options) : api(path, options));
  let dialog,
    dialogEpoch = 0,
    saving = false;
  const localProjects = new Map(),
    localTasks = new Map(),
    projectLimits = new Map();
  const PROJECT_PAGE_SIZE = 5;
  const selectedKey = "formicand.selected-project.v1";
  const collapsedKey = "formicand.collapsed-projects.v1";
  const pinnedCollapsedKey = "formicand.collapsed-pinned.v1";
  let pinnedCollapsed = false;
  try {
    state.selectedProjectId ||= storage?.getItem(selectedKey) || null;
    const remembered = JSON.parse(storage?.getItem(collapsedKey) || "null");
    if (Array.isArray(remembered))
      for (const id of remembered) if (typeof id === "string") state.collapsedProjects.add(id);
    pinnedCollapsed = storage?.getItem(pinnedCollapsedKey) === "1";
    // eslint-disable-next-line no-restricted-syntax -- the remembered selection and folds are optional; blocked storage just leaves the defaults
  } catch {
    /* optional persistence */
  }
  function rememberCollapsed() {
    try {
      storage?.setItem(collapsedKey, JSON.stringify([...state.collapsedProjects]));
      // eslint-disable-next-line no-restricted-syntax -- a full or blocked storage keeps the fold for this session only
    } catch {
      /* optional persistence */
    }
  }
  function rememberPinnedCollapsed() {
    try {
      storage?.setItem(pinnedCollapsedKey, pinnedCollapsed ? "1" : "0");
      // eslint-disable-next-line no-restricted-syntax -- a full or blocked storage keeps the fold for this session only
    } catch {
      /* optional persistence */
    }
  }
  // Below this width the sidebar is an icon rail, where every project shows
  // its tree only while open, so the project icon answers for its questions.
  const railWindow = window.matchMedia?.("(max-width: 1023px)") ?? { matches: false };
  // In the 640–1023 icon rail there is no text column for a standalone Pinned
  // section, so each project's hover tree keeps its pinned sessions reachable.
  const iconRail = window.matchMedia?.("(min-width: 640px) and (max-width: 1023px)") ?? { matches: false };
  const projects = () => state.projects || [];
  // Only Subagents still at work hang under their session. Finished ones stay
  // in the conversation and the progress panel; keeping them here made every
  // round add rows to the tree that never went away.
  const subagentsOf = (task) =>
    (task.activity?.agents || []).filter(
      (agent) => agent.role === "subagent" && ["running", "waiting", "queued"].includes(agent.state)
    );
  // A paused conversation holds its Subagents too, and a queued one has not
  // started: both say so instead of counting.
  // The time is filled in by the clock after each render, so the markup stays
  // the same between polls.
  const subagentRow = (agent, paused) => {
    const since = Date.parse(agent.startedAt);
    const time = paused
      ? `<span class="subagent-time">${esc(ui("已暂停"))}</span>`
      : agent.state === "queued"
        ? `<span class="subagent-time">${esc(ui("排队中"))}</span>`
        : Number.isFinite(since)
          ? `<span class="subagent-time" data-live-since="${since}"></span>`
          : "";
    return `<div class="subagent-row" data-agent="${esc(agent.agentId)}" data-state="${esc(paused ? "paused" : agent.state)}"><span class="subagent-guide" aria-hidden="true"></span>${agentAvatar(agent.agentId)}<span class="subagent-name">${esc(agent.name || agent.agentId)}</span>${time}</div>`;
  };
  const taskLabel = (task) =>
    `${task.status === "running" ? `<span class="conversation-activity" data-state="running" role="img" aria-label="${esc(ui("运行中"))}"></span>` : ""}<span class="conversation-item-title">${task.pendingQuestion ? `<span class="conversation-question" role="img" aria-label="${esc(ui("有待回答的问题"))}"></span>` : ""}<span class="conversation-title-text">${esc(conversationTitle(task))}</span>${isUnread(task.taskId) ? ui('<span class="conversation-unread" role="img" aria-label="未读"></span>') : ""}</span>`;
  const taskRow = (task) => {
    const id = esc(task.taskId),
      agents = subagentsOf(task),
      expanded = agents.length > 0 && !state.collapsedSessions?.has(task.taskId);
    const disclosure = agents.length
      ? `<button class="conversation-toggle" type="button" data-session-toggle="${id}" aria-expanded="${expanded}" aria-label="${esc(expanded ? ui("收起子 Agent") : ui("展开子 Agent"))}">${icon(expanded ? "chevron-down" : "chevron-right")}</button>`
      : '<span class="conversation-indent" aria-hidden="true"></span>';
    const subagents =
      expanded && agents.length
        ? `<div class="subagent-list" aria-label="${esc(ui`${conversationTitle(task)}的子 Agent`)}">${agents.map((agent) => subagentRow(agent, task.status === "paused")).join("")}</div>`
        : "";
    return ui`<div class="conversation-row${task.archived ? " is-archived" : ""}">${disclosure}<button class="conversation-item ${task.taskId === state.selected ? "active" : ""} ${isUnread(task.taskId) ? "is-unread" : ""}" data-task="${id}" data-status="${esc(task.status || "created")}" title="${esc(conversationTitle(task))}" aria-haspopup="menu" aria-keyshortcuts="Shift+F10" ${task.taskId === state.selected ? 'aria-current="page"' : ""}>${taskLabel(task)}</button>${task.pinned ? `<span class="conversation-pin" role="img" aria-label="${esc(ui("已置顶"))}">${icon("pin")}</span>` : ""}<span class="conversation-quick"><button type="button" data-quick-action="pin" data-quick-task="${id}" aria-label="${esc(task.pinned ? ui("取消置顶") : ui("置顶"))}" title="${esc(task.pinned ? ui("取消置顶") : ui("置顶"))}">${icon("pin")}</button><button type="button" data-quick-action="archive" data-quick-task="${id}" aria-label="${esc(ui("归档"))}" title="${esc(ui("归档"))}">${icon("archive")}</button></span></div>${subagents}`;
  };
  // An archived conversation stays listed while it is open, so its row menu
  // can restore it; it leaves the list once another conversation is selected.
  const visibleTask = (task) => (!task.archived || task.taskId === state.selected) && isTaskVisible(task);
  const find = (id) => projects().find((project) => project.projectId === id);
  const projectForTask = (task) =>
    find(task?.projectId) ||
    projects().find((project) => project.tasks?.some((entry) => entry.taskId === task?.taskId));
  const current = () =>
    state.tasks.find((task) => task.taskId === state.selected)?.temporaryWorkspaceRoot ||
    (state.selectedProjectId === null && state.composingNew)
      ? undefined
      : find(state.selectedProjectId) ||
        projectForTask(state.tasks.find((task) => task.taskId === state.selected)) ||
        projects()[0];
  function select(id, { automatic = false } = {}) {
    const project = find(id);
    if (!project) return;
    state.selectedProjectId = project.projectId;
    try {
      storage?.setItem(selectedKey, project.projectId);
      // eslint-disable-next-line no-restricted-syntax -- remembering the selection is optional; blocked or full storage must not fail the selection itself
    } catch {
      /* navigation still works */
    }
    if (automatic) onSelectionChanged(project);
    return project;
  }
  /** The conversation rows on screen, by Task id. */
  const rowsById = (root) =>
    new Map(
      [...root.querySelectorAll(".conversation-row")]
        .map((row) => [row.querySelector(".conversation-item[data-task]")?.dataset.task, row])
        .filter(([id]) => id)
    );

  const ROW_MS = 200;
  const ROW_EASE = "cubic-bezier(0.2, 0, 0, 1)";
  const foldAnimations = new Map();
  /** Captures a collapsible list's live height and opacity before a re-render. */
  function captureFold(key, element) {
    if (typeof element?.animate !== "function" || reducedMotion() || iconRail.matches) return null;
    const active = foldAnimations.get(key);
    const height = element.getBoundingClientRect().height;
    const opacity = height > 0 ? Number.parseFloat(window.getComputedStyle?.(element)?.opacity ?? "1") : 0;
    if (active) {
      foldAnimations.delete(key);
      active.cancel();
    }
    return {
      key,
      fromHeight: height,
      fromOpacity: Number.isFinite(opacity) ? opacity : height > 0 ? 1 : 0
    };
  }
  /** Eases a project or pinned list between its previous height and its new state. */
  function playFold({ key, fromHeight, fromOpacity, collapsed, findTarget }) {
    if (reducedMotion() || iconRail.matches) return;
    const target = findTarget?.();
    if (!target) return;
    let toHeight = 0;
    let toOpacity = 0;
    if (collapsed) {
      if (fromHeight <= 0) return;
      target.style.display = "flex";
      target.style.overflow = "hidden";
      target.style.pointerEvents = "none";
    } else {
      toHeight = target.scrollHeight || target.getBoundingClientRect().height;
      toOpacity = 1;
      if (toHeight <= 0 || Math.abs(toHeight - fromHeight) < 1) return;
      target.style.overflow = "hidden";
    }
    const animation = animate(
      target,
      [
        { height: `${fromHeight}px`, opacity: fromOpacity },
        { height: `${toHeight}px`, opacity: toOpacity }
      ],
      { duration: motionDuration("--motion-base", ROW_MS), easing: ROW_EASE }
    );
    foldAnimations.set(key, animation);
    const clear = () => {
      if (foldAnimations.get(key) === animation) foldAnimations.delete(key);
      target.style.removeProperty("display");
      target.style.removeProperty("overflow");
      target.style.removeProperty("pointer-events");
    };
    animation.finished.then(clear, clear);
  }
  /**
   * A conversation that joins the list grows into place and one that leaves
   * (archived, deleted) shrinks away, as a still copy of its row, instead of
   * the rows below jumping. Only a change of one or two rows moves: switching
   * projects or filters swaps many rows at once and stays instant.
   */
  function animateRowChanges(root, before) {
    // The first rendering lays the list out; nothing joins or leaves it.
    if (!before || reducedMotion()) return;
    const after = rowsById(root);
    const added = [...after.keys()].filter((id) => !before.has(id));
    const removed = [...before.keys()].filter((id) => !after.has(id));
    if (!added.length && !removed.length) return;
    if (added.length + removed.length > 2) return;
    const resize = (row, open) => {
      const height = `${row.getBoundingClientRect().height}px`;
      row.style.overflow = "hidden";
      const frames = [
        { height: "0px", opacity: 0 },
        { height, opacity: 1 }
      ];
      const animation = animate(row, open ? frames : frames.reverse(), {
        duration: ROW_MS,
        easing: ROW_EASE
      });
      return animation.finished.then(() => row.style.removeProperty("overflow"));
    };
    for (const id of added) resize(after.get(id), true);
    for (const id of removed) {
      const old = before.get(id);
      const previousId = old.previousElementSibling?.querySelector(".conversation-item[data-task]")?.dataset
        .task;
      const anchor = previousId ? after.get(previousId) : undefined;
      const list = anchor
        ? undefined
        : root.querySelector(
            `[data-project="${CSS.escape(old.closest("[data-project]")?.dataset.project ?? "")}"] .project-rail-head`
          );
      if (!anchor && !list) continue;
      // The copy is inert and carries no Task id, so nothing can select it.
      const ghost = old.cloneNode(true);
      ghost.setAttribute("aria-hidden", "true");
      ghost.inert = true;
      ghost.classList.add("is-leaving");
      for (const node of ghost.querySelectorAll("[data-task], .active")) {
        node.removeAttribute("data-task");
        node.classList.remove("active");
      }
      (anchor ?? list).after(ghost);
      resize(ghost, false).then(() => ghost.remove());
    }
  }

  const byRecent = (a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "");

  // Running Subagents count their own time between renders.
  let clockTimer;
  function syncClocks(roots) {
    const tick = () => {
      const clocks = roots.flatMap((scope) =>
        scope ? [...scope.querySelectorAll("[data-live-since]")] : []
      );
      for (const clock of clocks)
        clock.textContent = formatRunDuration(Date.now() - Number(clock.dataset.liveSince));
      if (!clocks.length) {
        clearInterval(clockTimer);
        clockTimer = undefined;
      }
      return clocks.length > 0;
    };
    if (tick()) clockTimer ??= setInterval(tick, 1000);
  }

  function render({ fold } = {}) {
    const root = $("#project-list");
    const pinnedRoot = $("#pinned-section");
    const scrollHost = $("[data-sidebar-scroll]") || root;
    const focused = scrollHost.contains(document.activeElement) ? document.activeElement : null;
    const focusTask = focused?.dataset.task,
      focusQuick = focused?.dataset.quickTask
        ? [focused.dataset.quickTask, focused.dataset.quickAction]
        : null,
      focusToggle = focused?.dataset.sessionToggle,
      focusMore = focused?.dataset.projectMore,
      focusPinnedToggle = focused?.hasAttribute?.("data-pinned-toggle") ?? false;
    const focusProject = focused?.closest?.("[data-project]")?.dataset.project;
    const focusAction = focused?.hasAttribute?.("data-project-create")
      ? "[data-project-create]"
      : focused?.hasAttribute?.("data-project-settings")
        ? "[data-project-settings]"
        : ".project-row";
    const scrollTop = scrollHost.scrollTop;
    $("#conversation-count").textContent = state.tasks.filter(visibleTask).length;
    const selected = current();
    if (selected && !find(state.selectedProjectId)) select(selected.projectId, { automatic: true });

    const separatePinned = !iconRail.matches;
    const pinned = separatePinned
      ? state.tasks.filter((task) => task.pinned && visibleTask(task)).sort(byRecent)
      : [];
    const pinnedMarkup = pinned.length
      ? `<button class="pinned-heading" type="button" data-pinned-toggle aria-expanded="${!pinnedCollapsed}"><span>${esc(ui("置顶"))}</span><span class="pinned-chevron" aria-hidden="true">${icon(pinnedCollapsed ? "chevron-right" : "chevron-down")}</span></button><div class="pinned-list">${pinned.map(taskRow).join("")}</div>`
      : "";

    const temporary = state.tasks
      .filter((task) => task.temporaryWorkspaceRoot && (!separatePinned || !task.pinned) && visibleTask(task))
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || byRecent(a, b));
    const temporaryMarkup = temporary.length
      ? ui`<section class="temporary-conversations"><div class="editor-empty-label">临时会话</div>${temporary.map(taskRow).join("")}</section>`
      : "";
    const markup =
      temporaryMarkup +
      (projects()
        .map((project) => {
          const id = project.projectId,
            allVisible = (project.tasks || []).filter(visibleTask),
            projectTasks = (
              separatePinned ? allVisible.filter((task) => !task.pinned) : [...allVisible]
            ).sort(
              (a, b) =>
                (separatePinned ? 0 : Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))) || byRecent(a, b)
            ),
            collapsed = state.collapsedProjects.has(id);
          let limit = projectLimits.get(id) ?? PROJECT_PAGE_SIZE;
          const selectedIndex = state.selected
            ? projectTasks.findIndex((task) => task.taskId === state.selected)
            : -1;
          if (selectedIndex >= limit) {
            limit = Math.ceil((selectedIndex + 1) / PROJECT_PAGE_SIZE) * PROJECT_PAGE_SIZE;
            projectLimits.set(id, limit);
          }
          const shown = projectTasks.slice(0, limit);
          const remaining = projectTasks.length - shown.length;
          const moreButton =
            remaining > 0
              ? `<button class="project-more" type="button" data-project-more="${esc(id)}" aria-label="${esc(ui("展开剩余会话"))}" title="${esc(ui`还有 ${remaining} 个会话`)}">${esc(ui("展开剩余"))}</button>`
              : "";
          const listBody =
            shown.map(taskRow).join("") + moreButton ||
            (allVisible.length ? "" : ui('<div class="project-empty" data-project-empty>还没有对话</div>'));
          const question =
            (collapsed || railWindow.matches) && projectTasks.some((task) => task.pendingQuestion);
          return ui`<section class="project-group ${collapsed ? "collapsed" : ""} ${state.selectedProjectId === id ? "is-selected" : ""}" data-project="${esc(id)}">
        <div class="project-heading"><button class="project-row" type="button" data-project-id="${esc(id)}" aria-expanded="${!collapsed}" title="${esc(project.projectDirectory || project.workspaceRoot || "")}"><span class="project-disclosure" aria-hidden="true"><span class="project-folder">${icon(collapsed ? "folder" : "folder-open")}</span></span><span class="project-name">${esc(project.projectName)}</span>${question ? `<span class="project-question" role="img" aria-label="${esc(ui("有待回答的问题"))}"></span>` : ""}${collapsed && projectTasks.length ? `<span class="project-count">${projectTasks.length}</span>` : ""}</button><button class="project-settings" type="button" data-project-settings="${esc(id)}" aria-haspopup="menu" aria-expanded="false" aria-label="项目操作：${esc(project.projectName)}" title="项目操作">${icon("more")}</button><button class="project-create" type="button" data-project-create="${esc(id)}" aria-label="在 ${esc(project.projectName)} 中新建会话" title="在此项目新建会话">${icon("plus")}</button></div>
        <div class="conversation-list" aria-label="${esc(project.projectName)}中的对话"><div class="project-rail-head"><span class="project-rail-name">${esc(project.projectName)}</span><button class="project-rail-action" type="button" data-rail-settings="${esc(id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(ui("项目操作"))}" title="${esc(ui("项目操作"))}">${icon("more")}</button><button class="project-rail-action" type="button" data-rail-create="${esc(id)}" aria-label="${esc(ui("新建会话"))}" title="${esc(ui("在此项目新建会话"))}">${icon("plus")}</button></div>${listBody}</div></section>`;
        })
        .join("") || (temporary.length ? "" : ui('<div class="sidebar-empty-state">还没有项目</div>')));

    const rootChanged = root.conversationMarkup !== markup;
    const pinnedChanged = Boolean(pinnedRoot && pinnedRoot.pinnedMarkup !== pinnedMarkup);
    if (!rootChanged && !pinnedChanged) return;
    const rowsBefore = root.conversationMarkup === undefined ? undefined : rowsById(scrollHost);
    if (pinnedChanged) {
      pinnedRoot.pinnedMarkup = pinnedMarkup;
      pinnedRoot.hidden = !pinned.length;
      pinnedRoot.classList.toggle("collapsed", pinnedCollapsed);
      pinnedRoot.innerHTML = pinnedMarkup;
    }
    if (rootChanged) {
      root.conversationMarkup = markup;
      root.innerHTML = markup;
    }
    if (fold) playFold(fold);
    syncClocks([root, pinnedRoot]);
    scrollHost.scrollTop = scrollTop;
    if (!fold) animateRowChanges(scrollHost, rowsBefore);

    const bindRows = (scope) => {
      scope.querySelectorAll("[data-session-toggle]").forEach((node) =>
        node.addEventListener("click", () => {
          const id = node.dataset.sessionToggle;
          if (state.collapsedSessions?.has(id)) state.collapsedSessions.delete(id);
          else state.collapsedSessions?.add(id);
          render();
        })
      );
      scope.querySelectorAll("[data-task]").forEach((node) =>
        node.addEventListener("click", () => {
          const task = state.tasks.find((entry) => entry.taskId === node.dataset.task);
          const project = projectForTask(task);
          if (project) select(project.projectId);
          selectConversation(node.dataset.task);
        })
      );
      // The context menu opens from the row itself: right click at the pointer,
      // Shift+F10 or the Menu key beside the row.
      scope.querySelectorAll(".conversation-item[data-task]").forEach((node) => {
        node.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          openTaskMenu(node, node.dataset.task, { at: { x: event.clientX, y: event.clientY } });
        });
        node.addEventListener("keydown", (event) => {
          if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
            event.preventDefault();
            openTaskMenu(node, node.dataset.task);
          }
        });
      });
      scope.querySelectorAll("[data-quick-action]").forEach((node) =>
        node.addEventListener("click", (event) => {
          event.stopPropagation();
          quickTaskAction(node.dataset.quickAction, node.dataset.quickTask);
        })
      );
    };
    if (pinnedChanged) {
      bindRows(pinnedRoot);
      pinnedRoot.querySelector("[data-pinned-toggle]")?.addEventListener("click", () => {
        const snapshot = captureFold("pinned", pinnedRoot.querySelector(".pinned-list"));
        pinnedCollapsed = !pinnedCollapsed;
        rememberPinnedCollapsed();
        render({
          fold: snapshot && {
            ...snapshot,
            collapsed: pinnedCollapsed,
            findTarget: () => pinnedRoot.querySelector(".pinned-list")
          }
        });
      });
    }
    if (rootChanged) {
      bindRows(root);
      root.querySelectorAll("[data-project-more]").forEach((node) =>
        node.addEventListener("click", () => {
          const id = node.dataset.projectMore;
          const findTarget = () =>
            root.querySelector(`[data-project="${CSS.escape(id)}"] > .conversation-list`);
          const snapshot = captureFold(`project:${id}`, findTarget());
          const currentLimit = projectLimits.get(id) ?? PROJECT_PAGE_SIZE;
          projectLimits.set(id, currentLimit + PROJECT_PAGE_SIZE);
          render({
            fold: snapshot && {
              ...snapshot,
              collapsed: false,
              findTarget
            }
          });
        })
      );
      root
        .querySelectorAll("[data-project-create]")
        .forEach((node) =>
          node.addEventListener("click", () => beginConversation(node.dataset.projectCreate))
        );
      root
        .querySelectorAll("[data-project-settings]")
        .forEach((node) =>
          node.addEventListener("click", () => openProjectMenu(node, node.dataset.projectSettings))
        );
      // The icon rail repeats the same two project commands inside its hover tree.
      root
        .querySelectorAll("[data-rail-create]")
        .forEach((node) => node.addEventListener("click", () => beginConversation(node.dataset.railCreate)));
      root
        .querySelectorAll("[data-rail-settings]")
        .forEach((node) =>
          node.addEventListener("click", () => openProjectMenu(node, node.dataset.railSettings))
        );
      root.querySelectorAll("[data-project-id]").forEach((node) =>
        node.addEventListener("click", () => {
          const id = node.dataset.projectId;
          select(id);
          if (!state.selected) beginConversation(id);
          const findTarget = () =>
            root.querySelector(`[data-project="${CSS.escape(id)}"] > .conversation-list`);
          const snapshot = captureFold(`project:${id}`, findTarget());
          if (state.collapsedProjects.has(id)) state.collapsedProjects.delete(id);
          else state.collapsedProjects.add(id);
          rememberCollapsed();
          render({
            fold: snapshot && {
              ...snapshot,
              collapsed: state.collapsedProjects.has(id),
              findTarget
            }
          });
        })
      );
    }
    // The icon rail's hover tree is a fixed panel, so it follows the icon it
    // belongs to. Delegated, because every render replaces the rows.
    if (!root.dataset.railPinned) {
      root.dataset.railPinned = "1";
      const pin = (event) => {
        const group = event.target.closest?.(".project-group");
        const heading = group?.querySelector(".project-heading");
        if (heading)
          group.style.setProperty(
            "--rail-flyout-top",
            `${Math.round(heading.getBoundingClientRect().top)}px`
          );
      };
      root.addEventListener("pointerover", pin);
      root.addEventListener("focusin", pin);
      // A question dot belongs to the folded project in the rail and to the
      // session in a wide tree, so crossing the breakpoint re-renders the rows.
      railWindow.addEventListener?.("change", () => render());
      iconRail.addEventListener?.("change", () => render());
    }
    onRendered();
    const focusSelector = focusPinnedToggle
      ? "[data-pinned-toggle]"
      : focusMore
        ? `[data-project-more="${CSS.escape(focusMore)}"]`
        : focusQuick
          ? `[data-quick-task="${CSS.escape(focusQuick[0])}"][data-quick-action="${focusQuick[1]}"]`
          : focusToggle
            ? `[data-session-toggle="${CSS.escape(focusToggle)}"]`
            : focusTask
              ? `[data-task="${CSS.escape(focusTask)}"]`
              : focusProject
                ? `[data-project="${CSS.escape(focusProject)}"] ${focusAction}`
                : null;
    if (focusSelector) scrollHost.querySelector(focusSelector)?.focus({ preventScroll: true });
  }
  function upsert(project) {
    const previous = find(project.projectId);
    const merged = { ...previous, ...project, tasks: previous?.tasks || [] };
    if (previous)
      state.projects = projects().map((entry) => (entry.projectId === project.projectId ? merged : entry));
    else state.projects = [...projects(), merged];
    localProjects.set(project.projectId, project);
  }
  function openSettings(id) {
    if (saving) return;
    const project = find(id);
    let panel = $("#project-modal");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "project-modal";
      panel.className = "modal-backdrop app-dialog-backdrop";
      panel.hidden = true;
      panel.innerHTML = ui`<section class="modal-card app-dialog project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title"><h2 id="project-dialog-title"></h2><form id="project-form"><div class="project-dialog-fields"><label for="project-name">项目名称</label><input id="project-name" required maxlength="120" autocomplete="off"><label for="project-directory">工作文件夹</label><div class="project-directory-field"><input id="project-directory" required placeholder="选择已有文件夹或输入绝对路径" autocomplete="off"><button class="app-button is-secondary" id="project-directory-choose" type="button" aria-label="选择文件夹">${icon("folder")}</button></div></div><p class="dialog-error project-dialog-error" id="project-error" role="alert" hidden></p><div class="modal-actions dialog-actions"><button class="app-button is-secondary" id="project-cancel" type="button">取消</button><button class="app-button is-primary" id="project-submit" type="submit"></button></div></form></section>`;
      document.body.appendChild(panel);
      dialog = createModal(panel, $("#project-cancel"), {
        onClose: () => {
          dialogEpoch++;
        }
      });
    }
    const epoch = ++dialogEpoch,
      identity = getNavigationIdentity();
    for (const node of panel.querySelectorAll("input,button")) node.disabled = false;
    $("#project-dialog-title").textContent = project ? ui("项目设置") : ui("新建项目");
    $("#project-name").value = project?.projectName || "";
    $("#project-directory").value = project?.projectDirectory || project?.workspaceRoot || "";
    $("#project-submit").textContent = project ? ui("保存") : ui("创建");
    $("#project-error").hidden = true;
    const error = (message) => {
      $("#project-error").textContent = message;
      $("#project-error").hidden = false;
    };
    $("#project-directory-choose").onclick = async () => {
      const button = $("#project-directory-choose");
      button.disabled = true;
      try {
        const selected = window.formicandDesktop
          ? await window.formicandDesktop.chooseProject()
          : (await api("/api/projects/choose-directory", { method: "POST" })).projectDirectory;
        if (epoch !== dialogEpoch || panel.hidden || !selected) return;
        $("#project-directory").value = selected;
      } catch (failure) {
        if (epoch === dialogEpoch) error(failure.message);
      } finally {
        if (epoch === dialogEpoch) button.disabled = false;
      }
    };
    $("#project-form").onsubmit = async (event) => {
      event.preventDefault();
      if (saving) return;
      const projectName = $("#project-name").value.trim(),
        projectDirectory = $("#project-directory").value.trim();
      if (!projectName || !projectDirectory) {
        error(ui("请填写项目名称并选择工作文件夹"));
        return;
      }
      saving = true;
      for (const node of panel.querySelectorAll("input,button")) node.disabled = true;
      try {
        const result = await command(
          project ? `/api/projects/${encodeURIComponent(project.projectId)}` : "/api/projects",
          {
            method: project ? "PATCH" : "POST",
            body: { projectName, projectDirectory }
          }
        );
        upsert(result.project);
        const foreground = epoch === dialogEpoch && getNavigationIdentity() === identity;
        if (epoch === dialogEpoch) dialog.close();
        if (foreground && !project) {
          select(result.project.projectId);
          state.collapsedProjects.delete(result.project.projectId);
          beginConversation(result.project.projectId);
        }
        render();
        onUpdated(result.project);
      } catch (failure) {
        if (epoch === dialogEpoch) error(failure.message);
        else showToast(failure.message);
      } finally {
        saving = false;
        for (const node of panel.querySelectorAll("input,button")) node.disabled = false;
      }
    };
    dialog.open();
    $("#project-name").focus();
  }
  /**
   * The project row's ⋯ menu (#33): rename, and remove from the list. Folder
   * changes have no entry here any more.
   */
  let projectMenu, menuPanel, menuProjectId;
  function openProjectMenu(trigger, id) {
    if (!menuPanel) {
      menuPanel = document.createElement("div");
      menuPanel.className = "session-menu conversation-context-menu project-menu";
      menuPanel.setAttribute("role", "menu");
      menuPanel.hidden = true;
      menuPanel.innerHTML = ui`<div class="session-menu-main"><button type="button" role="menuitem" data-project-action="rename">${icon("pencil")}<span data-menu-label>重命名项目</span></button><button type="button" role="menuitem" data-project-action="remove" class="is-danger">${icon("trash")}<span data-menu-label>移除项目</span></button></div>`;
      document.body.append(menuPanel);
      projectMenu = createMenu(trigger, menuPanel, { toggleOnClick: false });
      menuPanel.addEventListener("click", (event) => {
        const action = event.target.closest("[data-project-action]")?.dataset.projectAction;
        const project = find(menuProjectId);
        if (!action || !project) return;
        if (action === "rename") renameProject(project);
        else confirmRemove(project);
      });
    }
    if (!menuPanel.hidden && menuProjectId === id) return projectMenu.close(true);
    projectMenu.close();
    menuProjectId = id;
    menuPanel.setAttribute("aria-label", ui`项目操作：${find(id)?.projectName || ""}`);
    projectMenu.setTrigger(trigger);
    projectMenu.open();
    const anchor = trigger.getBoundingClientRect(),
      { width, height } = menuPanel.getBoundingClientRect();
    menuPanel.style.left = `${Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))}px`;
    menuPanel.style.top = `${Math.max(8, Math.min(anchor.bottom + 4, innerHeight - height - 8))}px`;
  }

  /** A small dialog: title, body, then a cancel and a primary action. */
  function projectDialog({ title, body, action, danger = false, submit }) {
    const panel = document.createElement("div");
    panel.className = "modal-backdrop app-dialog-backdrop";
    panel.hidden = true;
    panel.innerHTML = `<section class="modal-card app-dialog" role="dialog" aria-modal="true" aria-labelledby="project-action-title"><h2 id="project-action-title">${esc(title)}</h2><form novalidate>${body}<p class="dialog-error" role="alert" hidden></p><div class="dialog-actions"><button class="app-button is-secondary" type="button" data-close>${esc(ui("取消"))}</button><button class="app-button ${danger ? "is-danger" : "is-primary"}" type="submit">${esc(action)}</button></div></form></section>`;
    document.body.append(panel);
    const modal = createModal(panel, panel.querySelector("[data-close]"), { onClose: () => panel.remove() });
    const error = panel.querySelector("[role=alert]");
    panel.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = panel.querySelector("[type=submit]");
      error.hidden = true;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      try {
        await submit(panel);
        modal.close();
      } catch (failure) {
        error.textContent = failure.message;
        error.hidden = false;
      } finally {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    });
    modal.open();
    return panel;
  }

  function renameProject(project) {
    const panel = projectDialog({
      title: ui("重命名项目"),
      body: `<label class="dialog-field">${esc(ui("项目名称"))}<input name="projectName" maxlength="120" required autocomplete="off" value="${esc(project.projectName)}"></label>`,
      action: ui("保存"),
      async submit(dialogPanel) {
        const projectName = dialogPanel.querySelector("input").value.trim();
        if (!projectName) throw new Error(ui("请填写项目名称"));
        if (projectName === project.projectName) return;
        const result = await command(`/api/projects/${encodeURIComponent(project.projectId)}`, {
          method: "PATCH",
          body: { projectName }
        });
        upsert(result.project);
        render();
        onUpdated(result.project);
      }
    });
    panel.querySelector("input").select();
  }

  function confirmRemove(project) {
    projectDialog({
      title: ui("移除项目"),
      body: `<p class="dialog-description">${esc(ui`将「${project.projectName}」和它的会话从列表移除。工作文件夹里的文件不会被删除，会话记录保留在本机；以后重新添加同一个文件夹，项目和会话会一起回来。`)}</p>`,
      action: ui("移除项目"),
      danger: true,
      async submit() {
        await command(`/api/projects/${encodeURIComponent(project.projectId)}`, { method: "DELETE" });
        const removedTasks = new Set((project.tasks || []).map((task) => task.taskId));
        state.projects = projects().filter((entry) => entry.projectId !== project.projectId);
        localProjects.delete(project.projectId);
        projectLimits.delete(project.projectId);
        state.collapsedProjects.delete(project.projectId);
        if (state.selectedProjectId === project.projectId) state.selectedProjectId = null;
        const current = state.selected;
        render();
        if (current && removedTasks.has(current)) beginConversation();
        showToast(ui("项目已从列表移除"));
        onUpdated();
      }
    });
  }

  const openCreateDialog = () => (openAddProject ? openAddProject() : openSettings());
  $("#new-project").addEventListener("click", () => openCreateDialog());
  return {
    render,
    /** The projects the tree actually shows; the work entry follows the same list. */
    visibleProjects: projects,
    currentProject: current,
    async ensureProject(projectDirectory, projectName) {
      const existing = projects().find((project) => project.projectDirectory === projectDirectory);
      if (existing) return existing;
      try {
        const { project } = await command("/api/projects", {
          method: "POST",
          body: { projectName, projectDirectory }
        });
        upsert(project);
        return project;
      } catch (error) {
        if (error.status !== 409) throw error;
        const { projects: latest } = await api("/api/tasks");
        const project = latest?.find((entry) => entry.projectDirectory === projectDirectory);
        if (!project) throw error;
        upsert(project);
        return project;
      }
    },
    /** Backend switching drops this backend's optimistic rows and project selection. */
    reset() {
      localProjects.clear();
      localTasks.clear();
      projectLimits.clear();
      state.selectedProjectId = null;
      try {
        storage?.removeItem(selectedKey);
        // eslint-disable-next-line no-restricted-syntax -- clearing the remembered project is optional; a storage that refuses the removal must not fail the backend reset
      } catch {
        /* optional persistence */
      }
    },
    projectForWorkspace(root) {
      if (!root) return current();
      const selected = current();
      if (selected?.tasks?.some((task) => task.storageRoot === root)) return selected;
      return projects().find(
        (project) =>
          project.workspaceRoot === root ||
          project.projectDirectory === root ||
          project.tasks?.some((task) => task.storageRoot === root)
      );
    },
    select,
    selectTask(task) {
      const project = projectForTask(task);
      if (project) select(project.projectId);
      else if (task?.temporaryWorkspaceRoot) state.selectedProjectId = null;
    },
    accept(data) {
      const incoming = data.projects || [];
      for (const project of incoming) {
        const local = localProjects.get(project.projectId);
        if (local && (!local.updatedAt || project.updatedAt >= local.updatedAt))
          localProjects.delete(project.projectId);
      }
      state.tasks = data.tasks || [];
      for (const task of state.tasks) localTasks.delete(task.taskId);
      state.tasks = [...state.tasks, ...localTasks.values()];
      state.projects = incoming.map((project) => ({
        ...project,
        ...localProjects.get(project.projectId),
        tasks: state.tasks.filter(
          (task) =>
            task.projectId === project.projectId ||
            project.tasks?.some((entry) => entry.taskId === task.taskId)
        )
      }));
      for (const project of localProjects.values())
        if (!state.projects.some((entry) => entry.projectId === project.projectId))
          state.projects.push({
            ...project,
            tasks: state.tasks.filter((task) => task.projectId === project.projectId)
          });
      state.projectsLoaded = true;
      $("#new-conversation").disabled = false;
      $("#titlebar-new-session").disabled = false;
    },
    openCreate: () => openCreateDialog(),
    addTask(task) {
      localTasks.set(task.taskId, task);
      let project = projectForTask(task);
      if (!project && task.projectId) {
        upsert({
          projectId: task.projectId,
          projectName: task.projectName || ui("项目"),
          projectDirectory: task.projectDirectory || task.workspaceRoot
        });
        project = find(task.projectId);
      }
      if (project && !project.tasks.some((entry) => entry.taskId === task.taskId))
        project.tasks.unshift(task);
    }
  };
}
