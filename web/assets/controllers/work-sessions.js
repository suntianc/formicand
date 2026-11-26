import { ui } from "../ui/language.js";
import { requestErrorMessage } from "../request-error.js";
import { conversationTitle, truncate } from "./work-title.js";
import { workspaceDisplayName } from "./session-catalog.js";

export function createWorkSessions({
  $,
  state,
  api,
  composerSession,
  composerModel,
  projectController,
  newOperationId,
  currentSubmission,
  closeSessionMenu,
  markRead,
  resetRunControl,
  resetRequirements,
  connectEventStream,
  closeStream,
  renderConversationList,
  renderEmpty,
  loadDetail,
  updateSendButton,
  showToast
}) {
  const creatingTasks = new Map();

  function selectConversation(taskId) {
    closeSessionMenu();
    markRead(taskId);
    document.body.classList.remove("sidebar-mobile-open");
    state.selected = taskId;
    state.composingNew = false;
    state.drawerTab = null;
    state.drawerFile = null;
    state.artifactDrawerOpen = false;
    state.openFiles = [];
    state.artifactCache.clear();
    state.viewerTaskId = null;
    state.localMessages = [];
    resetRequirements();
    resetRunControl();
    connectEventStream(taskId);
    renderConversationList();
    void loadDetail(taskId);
  }

  function beginNewConversation(projectId) {
    if (!state.projectsLoaded) return false;
    closeSessionMenu();
    const project =
      typeof projectId === "string"
        ? projectController.select(projectId)
        : projectId === null
          ? undefined
          : projectController.currentProject();
    if (project) projectController.select(project.projectId);
    else state.selectedProjectId = null;
    composerSession.activate(null, {
      projectId: project?.projectId,
      fresh:
        currentSubmission() &&
        state.selected === null &&
        composerSession.currentKey === `new:${encodeURIComponent(project?.projectId ?? "")}`
    });
    document.body.classList.remove("sidebar-mobile-open");
    closeStream();
    state.selected = null;
    state.detail = null;
    state.composingNew = true;
    resetRunControl();
    composerModel.beginNew();
    state.localMessages = [];
    state.drawerTab = null;
    state.drawerFile = null;
    state.artifactDrawerOpen = false;
    state.openFiles = [];
    state.artifactCache.clear();
    state.viewerTaskId = null;
    resetRequirements();
    state.workspacePath = state.workspaceRoot;
    state.workspaceLabel = state.workspaceRoot ? workspaceDisplayName(state.workspaceRoot) : null;
    renderConversationList();
    renderEmpty();
    updateSendButton();
    $("#composer-input").focus();
    return true;
  }

  async function createTask(goal, associateTask, workspaceRoot, projectId) {
    const sourceKey = composerSession.currentKey;
    const sourceToken = composerSession.currentToken;
    const sourceDraft = composerSession.snapshot();
    const sourceTask = state.selected;
    const sourceProject = projectId
      ? state.projects.find((project) => project.projectId === projectId)
      : workspaceRoot
        ? projectController.projectForWorkspace(workspaceRoot)
        : state.selectedProjectId === null
          ? undefined
          : projectController.currentProject();
    if (projectId && !sourceProject) throw new Error(ui("目标项目已不可用，请重新选择项目"));
    const creationKey = JSON.stringify([sourceProject?.projectId ?? null, sourceToken]);
    if (creatingTasks.has(creationKey)) return creatingTasks.get(creationKey);
    composerSession.save();
    const creation = createTaskFromDraft(
      goal,
      sourceTask,
      sourceKey,
      sourceToken,
      sourceDraft,
      sourceProject?.projectId ?? null,
      associateTask,
      sourceProject ? undefined : workspaceRoot
    );
    creatingTasks.set(creationKey, creation);
    try {
      return await creation;
    } finally {
      if (creatingTasks.get(creationKey) === creation) creatingTasks.delete(creationKey);
      composerSession.release(sourceToken);
    }
  }

  /**
   * One pending Task creation per draft and command content.
   *
   * A retry after an uncertain response must present the same operation id and
   * the same task id; otherwise a response that was lost after the commit would
   * become a second Task. Editing the draft changes the content key and starts a
   * genuinely new command.
   */
  const pendingCreations = new Map();

  function pendingCreation(draftIdentity, content) {
    const contentKey = JSON.stringify(content);
    const existing = pendingCreations.get(draftIdentity);
    if (existing && existing.contentKey === contentKey) return existing;
    const pending = {
      contentKey,
      operationId: newOperationId(),
      taskId: `task-${crypto.randomUUID()}`
    };
    pendingCreations.set(draftIdentity, pending);
    return pending;
  }

  async function createTaskFromDraft(
    goal,
    sourceTask,
    sourceKey,
    sourceToken,
    sourceDraft,
    projectId,
    associateTask,
    temporaryWorkspaceRoot
  ) {
    const draftIdentity = composerSession.shownDraftIdentity;
    const pending = pendingCreation(draftIdentity, [goal, projectId, temporaryWorkspaceRoot || null]);
    const taskId = pending.taskId;
    const body = { taskId, goal, projectId, ...(temporaryWorkspaceRoot ? { temporaryWorkspaceRoot } : {}) };
    // A catalog poll may expose the committed Task before this POST returns.
    associateTask?.(taskId);
    const task = await api.command("/api/tasks", {
      method: "POST",
      body,
      operationId: pending.operationId
    });
    if (pendingCreations.get(draftIdentity) === pending) pendingCreations.delete(draftIdentity);
    if (task.taskId !== taskId) associateTask?.(task.taskId);
    const foreground =
      state.selected === sourceTask &&
      (state.selectedProjectId ?? null) === projectId &&
      composerSession.currentToken === sourceToken;
    composerSession.transfer(task.taskId, sourceKey, sourceToken, sourceDraft, { background: !foreground });
    if (!state.tasks.some((item) => item.taskId === task.taskId)) state.tasks.unshift(task);
    projectController.addTask(task);
    // The request owns its original draft; a late response must not undo navigation.
    if (!foreground || composerSession.currentKey !== task.taskId) {
      renderConversationList();
      return task.taskId;
    }
    state.selected = task.taskId;
    composerModel.rememberTaskChoices(task.taskId);
    state.composingNew = false;
    state.detail = { task, messages: [] };
    state.localMessages = [];
    state.artifactDrawerOpen = false;
    state.openFiles = [];
    state.artifactCache.clear();
    state.viewerTaskId = task.taskId;
    state.workspacePath = task.storageRoot || state.workspaceRoot;
    renderConversationList();
    return task.taskId;
  }

  /**
   * A new conversation beside this one that starts from one reply. Only the
   * history up to that reply is copied; the new conversation opens, settled, so
   * the next message continues from there.
   */
  async function forkConversation(sourceTaskId, messageId) {
    const source = state.tasks.find((task) => task.taskId === sourceTaskId);
    if (!source) return;
    let task;
    try {
      task = await api.command(`/api/tasks/${encodeURIComponent(sourceTaskId)}/fork`, {
        method: "POST",
        body: {
          taskId: `task-${crypto.randomUUID()}`,
          messageId,
          title: `${truncate(conversationTitle(source), 92)} · Fork`
        }
      });
    } catch (error) {
      showToast(requestErrorMessage(error));
      return;
    }
    if (!state.tasks.some((item) => item.taskId === task.taskId)) state.tasks.unshift(task);
    projectController.addTask(task);
    // Opening it is the confirmation; navigation already left the source.
    if (state.selected !== sourceTaskId) return renderConversationList();
    projectController.selectTask(task);
    selectConversation(task.taskId);
  }

  return { selectConversation, beginNewConversation, createTask, forkConversation };
}
