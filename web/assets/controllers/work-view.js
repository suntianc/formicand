import { ui } from "../ui/language.js";
import { animateLayout } from "../ui/motion.js";
import { invalidateArtifactCache } from "../artifacts.js";
import { conversationTitle, truncate } from "./work-title.js";

export function createWorkView({
  $,
  state,
  computerUse,
  trustPrompt,
  humanQuestions,
  projectController,
  conversationReadState,
  conversationHistory,
  newSession,
  firstUse,
  requirementPanel,
  renderConversation,
  renderArtifactDrawer,
  updateSendButton,
  renderRunControl,
  markRendered,
  composerModel
}) {
  let lastReadSelection;

  function renderConversationList() {
    if (lastReadSelection !== state.selected) {
      if (state.selected) conversationReadState.setUnread(state.selected, false);
      lastReadSelection = state.selected;
    }
    if (state.projectsLoaded) {
      const url = new URL(location.href);
      if (state.selected) url.searchParams.set("task", state.selected);
      else url.searchParams.delete("task");
      if (url.href !== location.href) history.replaceState(null, "", url.href);
    }
    projectController.render();
    conversationHistory.visit(state.selected);
    renderRunControl();
    syncIdleComposer();
  }

  function renderAll(options) {
    computerUse.syncTask();
    void trustPrompt.check();
    const detail = state.detail || {};
    const task = detail.task || {};
    paintTopbarContext();
    updateSendButton();
    renderRunControl();
    renderConversation(detail.messages || [], task, options);
    humanQuestions.update(detail);
    renderRightPanel();
    markRendered(detail);
  }

  function renderRightPanel() {
    const artifacts = state.detail?.artifacts || [];
    const artifactPaths = new Set(artifacts.map((artifact) => artifact.relativePath));
    invalidateArtifactCache(state.artifactCache, artifacts);
    // A tab of an attachment the session no longer has closes with it.
    state.openFiles = state.openFiles.filter(
      (id) => !id.startsWith("attachment:") || artifactPaths.has(id.slice("attachment:".length))
    );
    requirementPanel.render();
    renderArtifactDrawer();
  }
  function renderEmpty() {
    markRendered(undefined);
    computerUse.syncTask();
    if (firstUse.active()) firstUse.render();
    else newSession.render();
    syncIdleComposer();
    humanQuestions.update(null);
    renderRightPanel();
    paintTopbarContext();
  }

  /**
   * Before a conversation exists the same composer belongs to either the
   * first-use guide or the new-session start, so one place decides its chrome.
   */
  function syncIdleComposer() {
    newSession.sync();
    firstUse.sync();
    // The guide's composer cannot start a session, so it offers no project picker;
    // adding a project is a step above it.
    if (firstUse.blocksSending()) $("#composer-project").hidden = true;
  }
  function paintTopbarContext() {
    composerModel.syncProject();
    const idleTitle = firstUse.active() ? ui("开始使用") : ui("新会话");
    const name = state.selected
      ? conversationTitle(state.detail?.task || state.tasks.find((task) => task.taskId === state.selected))
      : idleTitle;
    $("#topbar-task").textContent = truncate(name, 44);
    $("#topbar-task").title = name;
    const usageLabel = $("#context-usage");
    const usage = state.selected === state.detail?.task?.taskId ? state.detail?.contextUsage : null;
    usageLabel.hidden = usage?.tokens == null;
    if (usage?.tokens != null) {
      const numbers = new Intl.NumberFormat(document.documentElement.lang);
      const used = numbers.format(usage.tokens);
      const limit = numbers.format(usage.contextWindow);
      usageLabel.title = ui`上下文窗口 ${usage.window} · 已用 ${used} / ${limit} tokens`;
      usageLabel.textContent = ui`上下文 ${Math.round((100 * usage.tokens) / usage.contextWindow)}%`;
      usageLabel.setAttribute("aria-label", usageLabel.title);
    }
    // The title row names where the conversation lives and what it is working on.
    const task = state.selected
      ? state.detail?.task || state.tasks.find((entry) => entry.taskId === state.selected)
      : null;
    const projectId = task?.projectId ?? (state.selected ? null : state.selectedProjectId);
    const project = projectId ? state.projects.find((entry) => entry.projectId === projectId) : null;
    $("#topbar-project").hidden = !project;
    $("[data-topbar-project-name]").textContent = project?.projectName ?? "";
    $("#topbar-project").title = project?.projectDirectory || project?.workspaceRoot || "";
    const requirement = state.selected ? requirementPanel.records()?.requirement : null;
    const chip = $("#topbar-requirement");
    chip.hidden = !requirement || requirementPanel.records()?.taskId !== state.selected;
    if (!chip.hidden) {
      chip.textContent = ui`需求 · ${requirement.title}`;
      chip.title = ui`查看需求进度：${requirement.title}`;
    }
  }
  async function toggleOutputPane() {
    animateLayout(() => document.body.classList.toggle("output-collapsed"), { part: "pane" });
    requirementPanel.paintToggle();
    if (!document.body.classList.contains("output-collapsed")) renderRightPanel();
  }

  return {
    renderAll,
    renderEmpty,
    renderRightPanel,
    renderConversationList,
    paintTopbarContext,
    toggleOutputPane
  };
}

export function bindWorkShortcuts({
  $,
  beginNewConversation,
  openTaskSearch,
  toggleOutputPane,
  artifactDrawerOpen,
  closeArtifactDrawer
}) {
  $("#new-conversation").addEventListener("click", beginNewConversation);
  $("#titlebar-new-session").addEventListener("click", () => beginNewConversation());
  $("#topbar-requirement").addEventListener("click", () => {
    if (document.body.classList.contains("output-collapsed")) void toggleOutputPane();
    else $("#agent-pane").querySelector("button, [tabindex]")?.focus();
  });
  $("#output-pane-toggle").addEventListener("click", toggleOutputPane);
  $("[data-panel-collapse]")?.addEventListener("click", () => void toggleOutputPane());
  document.addEventListener("keydown", (event) => {
    const modifier = event.metaKey || event.ctrlKey;
    const modalOpen =
      document.querySelector('[role="dialog"]') &&
      [...document.querySelectorAll('[role="dialog"]')].some((node) => node.getClientRects().length);
    if (modifier && event.key.toLowerCase() === "p" && !event.isComposing && !modalOpen) {
      event.preventDefault();
      openTaskSearch();
    }
    if (modifier && event.key.toLowerCase() === "k" && !event.isComposing && !modalOpen) {
      event.preventDefault();
      beginNewConversation();
    }
    if (event.key === "Escape" && artifactDrawerOpen()) closeArtifactDrawer(true);
  });
}
