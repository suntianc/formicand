import { ui } from "../ui/language.js";
import { mergeRuntimeEvents, streamRecordKey } from "../conversation.js";
import { createCoalescedRead } from "./coalesced-read.js";
import { conversationTitle } from "./work-title.js";

export const workspaceDisplayName = (value) => {
  const raw = String(value || "");
  if (/^\/+\s*$/.test(raw)) return "/";
  if (/^[A-Za-z]:[\\/]+$/.test(raw)) return raw.slice(0, 2) + "\\";
  const normalized = raw.replace(/[\\/]+$/, "");
  if (!normalized) return ui("选择文件夹");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || normalized;
};

export function createSessionCatalog({
  state,
  api,
  composerSession,
  composerModel,
  projectController,
  connection,
  taskNotifications,
  initialConversationTaskId,
  connectedBackend,
  resetBackendFiles,
  resetRequirements,
  onOnline,
  onBackendChanged,
  onCatalogChanged,
  composerHasUnsentContent,
  renderConversationList,
  renderAll,
  renderEmpty,
  updateSendButton,
  showToast
}) {
  let detailRequestSequence = 0;
  let listRequestSequence = 0;
  let latestListRead;
  const catalogReads = createCoalescedRead((_key, options) => refreshState(options));
  const detailReads = createCoalescedRead(readDetail);
  let renderedDetailSignature;

  function readProjectCatalog(requestSequence = ++listRequestSequence, isCurrent = () => true) {
    const request = api("/api/tasks").then((data) => {
      // All list readers share one ordering, including independent documents.
      // A superseded caller waits for the latest catalog instead of proceeding
      // with an old project identity while a newer request is still in flight.
      if (requestSequence !== listRequestSequence) return latestListRead;
      if (isCurrent()) projectController.accept(data);
      return data;
    });
    latestListRead = request;
    return request;
  }

  function refresh(options) {
    return catalogReads("catalog", options);
  }

  /**
   * The connection is one state with one transition notice.
   *
   * Repeated polling failures must not stack identical warnings; the reconnect
   * notice is the same state turning back on, and the catalog read that follows
   * it refreshes every conversation from the backend rather than from memory.
   */
  function setOnlineState(online) {
    const changed = state.online !== online;
    state.online = online;
    onOnline(online);
    if (!changed) return;
    if (online) showToast(ui("本机节点已重新连接"), { tone: "success" });
    else showToast(ui("本机节点连接中断，正在重连…"), { tone: "danger" });
  }

  /**
   * A Main question in another conversation is a notification, not a reason to
   * switch: the selected conversation keeps its place and the sidebar carries
   * the dot. The first catalog seeds the set so opening the page is quiet.
   */
  let catalogQuestionsSeen = false;
  const pendingQuestionIds = new Set();
  function announcePendingQuestions() {
    const current = new Set();
    for (const task of state.tasks) {
      if (!task.pendingQuestion) continue;
      current.add(task.taskId);
      if (catalogQuestionsSeen && task.taskId !== state.selected && !pendingQuestionIds.has(task.taskId))
        showToast(ui("Main 有问题等你回答"), {
          detail: conversationTitle(task),
          tone: "warn"
        });
    }
    pendingQuestionIds.clear();
    for (const taskId of current) pendingQuestionIds.add(taskId);
    catalogQuestionsSeen = true;
  }

  /**
   * Adopt one authoritative catalog, whether it came from `/api/tasks` or from a
   * snapshot the event client took. Replacing the lists here is what makes a
   * reconnect consistent: the sequence and revisions move in the same step.
   */
  async function applyCatalog(data, { poll = false } = {}) {
    if (!data || typeof data !== "object") return;
    announcePendingQuestions();
    if (typeof data.workspaceRoot === "string" && data.workspaceRoot.trim()) {
      state.workspaceRoot = data.currentWorkspaceRoot || data.workspaceRoot;
      if (!state.workspacePath) state.workspacePath = state.workspaceRoot;
      state.workspaceLabel = workspaceDisplayName(state.workspacePath);
    }
    composerModel.acceptCatalog(data);
    setOnlineState(true);
    const defaultTask = state.tasks.find((task) => !task.archived);
    const linkedTaskId = initialConversationTaskId;
    initialConversationTaskId = null;
    if (linkedTaskId && !state.tasks.some((task) => task.taskId === linkedTaskId))
      showToast(ui("找不到链接中的会话，可能已被移除"));
    // The composer is usable before this first catalog lands. Text, attachments
    // or an upload still running in it are a new conversation: neither picking
    // the default conversation nor replacing one that disappeared may carry that
    // draft away from the person who typed it.
    const missingSelection = Boolean(
      state.selected && !state.tasks.some((task) => task.taskId === state.selected)
    );
    if ((!state.selected || missingSelection) && !state.composingNew && composerHasUnsentContent())
      state.composingNew = true;
    if (!state.selected && defaultTask && !state.composingNew) state.selected = defaultTask.taskId;
    if (missingSelection) state.selected = state.composingNew ? null : defaultTask?.taskId || null;
    renderConversationList();
    if (state.selected) {
      const listed = state.tasks.find((task) => task.taskId === state.selected);
      const loaded = state.detail?.task;
      if (
        !poll ||
        loaded?.taskId !== state.selected ||
        listed?.version !== loaded?.version ||
        listed?.activeRunId !== loaded?.activeRunId ||
        listed?.status !== loaded?.status
      )
        await loadDetail(state.selected, { poll });
      connection.connect(state.selected);
    } else renderEmpty();
    updateSendButton();
  }

  async function refreshState({ poll = false, isCurrent = () => true } = {}) {
    const requestSequence = ++listRequestSequence;
    try {
      const data = await readProjectCatalog(requestSequence, isCurrent);
      if (!isCurrent() || requestSequence !== listRequestSequence) return;
      await applyCatalog(data, { poll });
      onCatalogChanged();
    } catch (error) {
      // A request from the backend this page switched away from is not an outage.
      if (error?.stale || error?.code === "stale_client") return;
      if (!isCurrent() || requestSequence !== listRequestSequence) return;
      // An ended session has its own actionable state and reauthorize action.
      if (["session_revoked", "unauthorized", "host_credential_required"].includes(error?.code)) {
        updateSendButton();
        return;
      }
      setOnlineState(false);
      updateSendButton();
      onCatalogChanged();
    }
  }

  /** The backend the visible catalog belongs to; events from any other are dropped. */
  let boundBackendId = null;
  let backendRevision = 0;

  /**
   * Bind the page to one backend identity.
   *
   * Drafts and selections are per backend: the composer swaps its storage
   * namespace, and a switch back restores exactly what that backend had.
   */
  function adoptBackendIdentity(backendId) {
    if (!backendId || backendId === boundBackendId) return;
    boundBackendId = backendId;
    backendRevision += 1;
    composerSession.setBackend(backendId);
    onBackendChanged();
    // The backend's own draft namespace may name a different last conversation
    // than the page had before the session bound. A conversation link keeps its
    // choice; otherwise the stored slot is what "the last conversation" means.
    const active = initialConversationTaskId || composerSession.activeTask;
    if (!initialConversationTaskId) {
      state.selected = active;
      state.composingNew = !active && composerSession.hasNewDraft;
      state.selectedProjectId = composerSession.activeProject ?? null;
    }
    // Binding swapped the namespace and cleared the composer. Keep the composer
    // attached to the conversation it shows (the link, or the stored slot), so
    // typing before the first catalog lands in a draft instead of vanishing and a
    // link the catalog later reports gone still holds what was typed into it.
    composerSession.activate(active, { projectId: state.selectedProjectId });
  }

  /** Drop everything that belonged to the backend being left. */
  function resetBackendView() {
    resetBackendFiles();
    connection.close();
    boundBackendId = null;
    backendRevision += 1;
    onBackendChanged();
    state.selected = null;
    state.detail = null;
    state.tasks = [];
    state.projects = [];
    state.projectsLoaded = false;
    state.localMessages = [];
    state.previewPath = null;
    state.artifactDrawerOpen = false;
    state.openFiles = [];
    state.artifactCache.clear();
    state.viewerTaskId = null;
    composerModel.resetBackend();
    state.workspacePath = null;
    state.workspaceRoot = null;
    state.workspaceLabel = null;
    state.selectedProjectId = null;
    state.composingNew = false;
    renderedDetailSignature = undefined;
    projectController.reset();
    composerSession.detach();
    renderConversationList();
    renderEmpty();
    updateSendButton();
  }

  /** The client's catalog snapshot: same payload as `/api/tasks`, plus its cursor. */
  function adoptCatalogSnapshot(snapshot) {
    if (!snapshot || snapshot.backendId !== connectedBackend()) return;
    taskNotifications.snapshot(snapshot);
    if (snapshot.backendId !== boundBackendId) resetBackendView();
    adoptBackendIdentity(snapshot.backendId);
    // The snapshot is a catalog read: accept it exactly like `/api/tasks` before
    // deciding which conversation it names.
    projectController.accept(snapshot);
    // eslint-disable-next-line no-restricted-syntax -- a snapshot whose detail read fails while the backend restarts is re-applied by the 3.5s catalog poll
    void applyCatalog(snapshot).catch(() => undefined);
    onCatalogChanged();
  }

  /** Apply one live catalog event without waiting for a poll. */
  function applyCatalogEvent(record) {
    if (!record || record.backendId !== boundBackendId) return;
    taskNotifications.event(record);
    if (record.scope === "task") {
      const index = state.tasks.findIndex((task) => task.taskId === record.objectId);
      if (record.type === "task.deleted") {
        if (index >= 0) state.tasks.splice(index, 1);
        if (state.selected === record.objectId) {
          state.selected = null;
          state.detail = null;
          connection.close();
        }
      } else {
        const task = record.payload;
        if (!task || typeof task.taskId !== "string") return;
        if (index >= 0) state.tasks[index] = { ...state.tasks[index], ...task };
        else state.tasks.unshift(task);
      }
    } else if (record.scope === "project" && record.type === "project.changed") {
      const project = record.payload;
      if (!project || typeof project.projectId !== "string") return;
      const index = state.projects.findIndex((entry) => entry.projectId === project.projectId);
      if (index >= 0) state.projects[index] = { ...state.projects[index], ...project };
      else state.projects.push({ ...project, tasks: [] });
    } else {
      return;
    }
    for (const project of state.projects) {
      project.tasks = state.tasks.filter(
        (task) =>
          task.projectId === project.projectId ||
          (project.tasks || []).some((entry) => entry.taskId === task.taskId)
      );
    }
    announcePendingQuestions();
    renderConversationList();
    if (state.selected) connection.connect(state.selected);
    updateSendButton();
    onCatalogChanged();
  }

  // Whether a polled detail would draw anything new. The history arrays are
  // compared by their length and last entries: serializing a long conversation
  // on every poll cost more than drawing it.
  function detailViewSignature(detail) {
    const {
      statistics: allStatistics,
      messages = [],
      runtimeEvents = [],
      contextWindows = [],
      ...rest
    } = detail;
    const { elapsedMs: _elapsed, observedAt: _observed, ...statistics } = allStatistics || {};
    return JSON.stringify({
      ...rest,
      statistics,
      messages: [messages.length, messages.slice(-2)],
      contextWindows: contextWindows.map((window) => window.id),
      runtimeEvents: [runtimeEvents.length, runtimeEvents.slice(-3).map(streamRecordKey)]
    });
  }

  function loadDetail(taskId, options) {
    if (state.selected === taskId) {
      composerSession.activate(taskId);
      if (state.detail?.task?.taskId !== taskId) {
        const task = state.tasks.find((item) => item.taskId === taskId) || { taskId };
        projectController.selectTask(task);
        // A placeholder until the read returns: the pane stays blank rather than
        // flashing the empty-conversation welcome between two conversations.
        state.detail = { task, messages: [], loading: true };
        composerModel.showTaskChoices(taskId, task);
        renderAll();
      }
    }
    return detailReads(taskId, options);
  }

  async function readDetail(taskId, { poll = false, isCurrent = () => true } = {}) {
    if (state.selected !== taskId) return;
    const requestSequence = ++detailRequestSequence;
    try {
      const detail = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
      if (!isCurrent() || state.selected !== taskId || requestSequence !== detailRequestSequence) return;
      if (state.viewerTaskId !== taskId) {
        state.viewerTaskId = taskId;
        state.openFiles = [];
        state.artifactCache.clear();
        state.previewPath = null;
        state.drawerTab = null;
        state.drawerFile = null;
        state.drawerDiff = null;
        state.artifactDrawerOpen = false;
        resetRequirements(taskId);
      }
      if (state.detail?.task?.taskId === taskId) {
        if (state.detail.conversationVersion === detail.conversationVersion)
          detail.runtimeEvents = mergeRuntimeEvents(detail.runtimeEvents, state.detail.runtimeEvents);
        else connection.close();
      }
      connection.remember(taskId, detail.runtimeEvents);
      state.detail = detail;
      if (state.selected === taskId) composerModel.showTaskChoices(taskId, detail.task, detail);
      state.workspacePath = detail.storageRoot || detail.task?.storageRoot || state.workspaceRoot || null;
      state.workspaceLabel = workspaceDisplayName(state.workspacePath);
      const savedUsers = (detail.messages || []).filter((message) => message.role === "user").length;
      const localCount = state.localMessages.length;
      state.localMessages = state.localMessages.filter(
        (message) =>
          message.taskId === taskId &&
          (message.interjected
            ? !(detail.messages || []).some((saved) => saved.id === message.id)
            : savedUsers <= message.savedUsers)
      );
      if (
        !poll ||
        state.localMessages.length !== localCount ||
        detailViewSignature(detail) !== renderedDetailSignature
      )
        renderAll();
    } catch (error) {
      if (isCurrent() && state.selected === taskId && requestSequence === detailRequestSequence)
        showToast(ui`Task 加载失败：${error.message}`);
    }
  }

  return {
    refresh,
    loadDetail,
    adoptBackendIdentity,
    resetBackendView,
    adoptCatalogSnapshot,
    applyCatalogEvent,
    get backendId() {
      return boundBackendId;
    },
    get revision() {
      return backendRevision;
    },
    markRendered(detail) {
      renderedDetailSignature = detail && detailViewSignature(detail);
    }
  };
}
