import { ui, localizeShell } from "./assets/ui/language.js";
import { installLanguageSettings } from "./assets/controllers/language-settings.js";
import { createMessageEditController } from "./assets/controllers/message-edit.js";
import { antMarkSvg } from "./assets/ui/thinking-mark.js";
import { createComposerSession } from "./assets/controllers/composer-session.js";
import { createDraftRecovery } from "./assets/controllers/draft-recovery.js";
import { createComposerLayout } from "./assets/controllers/composer-layout.js";
import { createSidebarLayout } from "./assets/sidebar-layout.js";
import { createResponsiveShell } from "./assets/controllers/responsive-shell.js";
import { createConversationHistory } from "./assets/controllers/conversation-history.js";
import { installSelectMenus } from "./assets/ui/select-menu.js";
import { createVisiblePoll } from "./assets/ui/visible-poll.js";
import { installDesktopSettings } from "./assets/controllers/desktop-settings.js";
import { installDesktopUpdates } from "./assets/controllers/desktop-updates.js";
import { createArtifactController } from "./assets/controllers/artifact-controller.js";
import { createArtifactViewer } from "./assets/controllers/artifact-viewer.js";
import { createConversationView } from "./assets/controllers/conversation-view.js";
import { createConversationLayout } from "./assets/controllers/conversation-layout.js";
import { createConnectionController } from "./assets/controllers/connection-controller.js";
import { revealScrollbarsWhileScrolling } from "./assets/ui/scrollbars.js";
import { createManagementClient } from "./assets/controllers/management-client.js";
import { createTaskNotifications } from "./assets/controllers/task-notifications.js";
import { createBackendConnection } from "./assets/controllers/backend-connection.js";
import { createProjectController } from "./assets/controllers/project-controller.js";
import { createConversationMenu } from "./assets/controllers/conversation-menu.js";
import { createConversationOperations } from "./assets/controllers/conversation-operations.js";
import { createConversationReadState, conversationTaskId } from "./assets/conversation-actions.js";
import { createEntryController } from "./assets/controllers/entry-controller.js";
import { createProjectTrustPrompt } from "./assets/controllers/project-trust-prompt.js";
import { createRequirementPanel } from "./assets/controllers/requirement-panel.js";
import { createRunControl } from "./assets/controllers/run-control.js";
import { createNewSessionView } from "./assets/controllers/new-session.js";
import { createFirstUseView } from "./assets/controllers/first-use.js";
import { createAddProjectController } from "./assets/controllers/add-project.js";
import { createHumanQuestions } from "./assets/human-questions.js";
import { installComputerUse } from "./assets/controllers/computer-use.js";
import { installCodeBlockActions } from "./assets/ui/code-blocks.js";
import { installSelectionGlide } from "./assets/ui/motion.js";
import { createComposerMenu } from "./assets/controllers/composer-menu.js";

import { showToast } from "./assets/ui/toast.js";
import { createBackendFiles } from "./assets/controllers/backend-files.js";
import { createComposerModel } from "./assets/controllers/composer-model.js";
import { createComposerAttachments } from "./assets/controllers/composer-attachments.js";
import { createConversationDelivery } from "./assets/controllers/conversation-delivery.js";
import { createObservationSettings } from "./assets/controllers/observation-settings.js";
import { createSessionCatalog } from "./assets/controllers/session-catalog.js";
import { createTaskSearch } from "./assets/controllers/task-search.js";
import { createWorkSessions } from "./assets/controllers/work-sessions.js";
import { bindWorkShortcuts, createWorkView } from "./assets/controllers/work-view.js";
import { conversationTitle, textContent } from "./assets/controllers/work-title.js";

revealScrollbarsWhileScrolling();

localizeShell(document.body);
// The run pill walks the Formicand ant while Main works.
for (const dot of document.querySelectorAll(".run-control-dot")) {
  dot.classList.add("ant-mark");
  dot.innerHTML = antMarkSvg;
}

/** Asks whether to trust a project's own Agents and skills; set once the composer exists. */
const state = {
  online: true,
  get modelConfigured() {
    return composerModel.configured;
  },
  get model() {
    return composerModel.model;
  },
  get defaultModel() {
    return composerModel.defaultModel;
  },
  tasks: [],
  projects: [],
  collapsedProjects: new Set(),
  collapsedSessions: new Set(),
  selected: null,
  detail: null,
  previewPath: null,
  drawerTab: null,
  drawerFile: null,
  drawerLine: null,
  drawerDiff: null,
  drawerTrigger: null,
  artifactDrawerOpen: false,
  openFiles: [],
  artifactCache: new Map(),
  viewerTaskId: null,
  localMessages: [],
  submittingTaskId: null,
  composingNew: false,
  attachments: [],
  workspacePath: null,
  workspaceRoot: null,
  workspaceLabel: null,
  executionHistoryOpen: new Map()
};
let observation;
let initialized = false;
const $ = (selector) => document.querySelector(selector);
createComposerLayout($("#composer-input"));
createSidebarLayout($(".app-layout"), $(".conversation-sidebar"), $("#sidebar-divider"), {
  outputPane: $(".agent-pane"),
  outputToggle: $("#output-pane-toggle")
});
createResponsiveShell({
  toggles: [$("#sidebar-toggle")],
  closeButton: $("#sidebar-drawer-close"),
  sidebar: $("#conversation-sidebar")
});
const conversationHistory = createConversationHistory({
  back: $("#history-back"),
  forward: $("#history-forward"),
  exists: (taskId) => state.tasks.some((task) => task.taskId === taskId),
  open: (taskId) => {
    const task = state.tasks.find((entry) => entry.taskId === taskId);
    if (entryController.state().mode !== "work") entryController.setMode("work");
    if (task) projectController.selectTask(task);
    selectConversation(taskId);
  }
});
let draftStorage;
let browserSessionStorage;
try {
  draftStorage = window.localStorage;
  // eslint-disable-next-line no-restricted-syntax -- the localStorage getter throws SecurityError when the browser blocks storage, and every reader below treats draftStorage as optional
} catch {
  /* storage may be disabled */
}
try {
  browserSessionStorage = window.sessionStorage;
  // eslint-disable-next-line no-restricted-syntax -- the sessionStorage getter throws when storage is blocked; the management client then keeps sessions in memory
} catch {
  /* storage may be disabled */
}
const conversationReadState = createConversationReadState(draftStorage);
const entryController = createEntryController({
  root: $(".app-layout"),
  storage: draftStorage,
  onChange: (next) => {
    observation?.applyEntry(next);
  }
});
for (const button of document.querySelectorAll("[data-entry-mode]"))
  button.addEventListener("click", () => entryController.setMode(button.dataset.entryMode));
$(".entry-switch")?.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  const next = entryController.state().mode === "work" ? "observe" : "work";
  entryController.setMode(next);
  $(`[data-entry-mode="${next}"]`)?.focus();
});
for (const button of document.querySelectorAll("[data-observe-view]"))
  button.addEventListener("click", () => entryController.setObserveView(button.dataset.observeView));
const initialConversationTaskId = conversationTaskId(location.href);
let backendConnection;
const taskNotifications = createTaskNotifications({ notify: window.bookmanDesktop?.notify });
/**
 * The one client every business call goes through.
 *
 * It owns the local session, the catalog snapshot and its event stream. The
 * page never learns a backend's file paths and never calls Electron IPC; the
 * desktop renderer and a plain browser consume exactly this module.
 */
const management = createManagementClient({
  ...(window.bookmanDesktop?.backend
    ? {
        hostManagedSession: true,
        transportHeaders: { "x-cowork-desktop-nonce": window.bookmanDesktop.transportNonce },
        authorizeSession: async (input) => {
          const result = await window.bookmanDesktop.backend.authorize(input);
          if (result.error) {
            const error = new Error(result.error.message);
            error.code = result.error.code;
            error.status = result.error.status;
            throw error;
          }
          return result;
        }
      }
    : {}),
  storage: browserSessionStorage,
  targetStorage: draftStorage,
  events: {
    onSnapshot: (snapshot) => catalog.adoptCatalogSnapshot(snapshot),
    onEvent: (record) => catalog.applyCatalogEvent(record),
    onReset: (reset) => {
      // A cursor reset only asks for a new snapshot of the same backend; the
      // screen is rebuilt from that snapshot. Only a backend change discards it.
      if (reset?.reason === "backend_switched" || reset?.reason === "backend_mismatch")
        catalog.resetBackendView();
    },
    onStatus: () => {
      backendConnection?.apply(management.state());
      updateSendButton();
    }
  },
  onStateChange: (state) => {
    backendConnection?.apply(state);
    updateSendButton();
    observation.data.localChanged();
  }
});
/** Every business request belongs to the bound backend's session. */
async function api(path, options) {
  return management.request(path, options);
}
/** A change command: same operation id and content may be retried after a lost response. */
api.command = (path, options) => management.command(path, options);

const artifactViewer = createArtifactViewer({
  read: (path) => management.blob(path),
  identity: () => management.state(),
  host: window.bookmanDesktop?.artifactViewer
});
const backendFiles = createBackendFiles(management, showToast);
window.addEventListener(
  "unload",
  () => {
    artifactViewer.dispose();
    backendFiles.clear();
    observation?.dispose();
    management.stop();
  },
  { once: true }
);
window.addEventListener("pagehide", () => management.stop());
window.addEventListener("pageshow", (event) => {
  if (event.persisted && initialized) void bootBackend();
});

const composerSession = createComposerSession({
  input: $("#composer-input"),
  storage: draftStorage,
  getAttachments: () => state.attachments,
  setAttachments: (files) => composerAttachments.setDraft(files),
  onError: showToast,
  onPersist: () => window.bookmanDesktop?.saveComposerDrafts?.()
});
await composerSession.ready;
const composerAttachments = createComposerAttachments({
  $,
  state,
  api,
  upload: (file, options) => management.upload(file, options),
  mediaUrl: (path) => backendFiles.mediaUrl(path),
  session: () => composerSession,
  updateSendButton,
  showToast
});
/** The project the draft belongs to: the open session's, or the one chosen for a new session. */
function composerProjectId() {
  if (state.selected) {
    const task = state.detail?.task || state.tasks.find((entry) => entry.taskId === state.selected);
    return task?.projectId || undefined;
  }
  // A new draft goes where sending it would put it: the chosen project, else the first one.
  if (state.selectedProjectId === null && state.composingNew) return undefined;
  return state.selectedProjectId || state.projects?.[0]?.projectId || undefined;
}
const composerMenu = createComposerMenu({
  input: $("#composer-input"),
  container: $(".composer"),
  api,
  getProjectId: composerProjectId,
  commands: [
    { name: "new", icon: "square-pen", description: ui("新会话"), run: () => beginNewConversation() },
    {
      name: "compact",
      icon: "refresh",
      description: ui("换一个上下文窗口"),
      run: () => void delivery.compactConversation()
    },
    {
      name: "model",
      icon: "cpu",
      description: ui("切换本会话的模型与推理强度"),
      run: () => void composerModel.toggleMenu()
    }
  ],
  onError: showToast
});
const trustPrompt = createProjectTrustPrompt({ api, getProjectId: composerProjectId, showToast });
const messageEdit = createMessageEditController({
  composerSession,
  input: $("#composer-input"),
  getState: () => state,
  isBusy: () =>
    Boolean(delivery.currentSubmission() || composerAttachments.busy || delivery.isTaskStopping()),
  api,
  onError: showToast,
  onChange: () => {
    renderAll();
    updateSendButton();
  },
  onSubmit: () => delivery.submitMessageEdit(),
  referencesOf: (text) => delivery.draftReferences(text),
  onAccepted: async (taskId, run) => {
    if (state.selected === taskId) {
      state.localMessages = [];
      await loadDetail(taskId);
      if (run.status !== "failed") connectEventStream(taskId);
    }
    await refresh();
  }
});
state.selected = initialConversationTaskId || composerSession.activeTask;
state.composingNew = !initialConversationTaskId && composerSession.hasNewDraft;
state.selectedProjectId = composerSession.activeProject;
window.addEventListener("pagehide", () => composerSession.save());
const humanQuestions = createHumanQuestions($("#human-questions"), {
  onError: showToast,
  submit: (taskId, requestId, answer) =>
    humanAction(taskId, `human/${encodeURIComponent(requestId)}/answer`, { answer }),
  resume: (taskId) => humanAction(taskId, "human/resume", {}),
  onEditProposal: (proposal) => observation.openAgentProposal(proposal),
  onVisibility: (visible) => {
    $(".composer").hidden = visible;
  }
});
const computerUse = installComputerUse({
  api,
  showToast,
  getSelectedTaskId: () => state.selected,
  getTaskLabel: (taskId) =>
    conversationTitle(state.tasks.find((task) => task.taskId === taskId) || state.detail?.task)
});
const artifacts = createArtifactController({
  state,
  $,
  api,
  showToast,
  renderRightPanel: () => workView.renderRightPanel(),
  mediaUrl: (path) => backendFiles.mediaUrl(path),
  openArtifactViewer: (path) => artifactViewer.open(path),
  getDelivery: () => requirementPanel?.records()
});
const {
  openArtifact,
  closeArtifactDrawer,
  renderArtifactDrawer,
  openPreview,
  canOpenReference,
  openFileReference
} = artifacts;
const requirementPanel = createRequirementPanel({
  state,
  $,
  api,
  onCollapse: () => void toggleOutputPane(),
  openArtifact,
  openPreview,
  onRendered: () => workView.paintTopbarContext()
});
const conversationView = createConversationView({
  state,
  $,
  textContent,
  openArtifact,
  retry: (taskId) => void delivery.retryFailedRequest(taskId),
  messageEdit,
  edit: (taskId, target) => messageEdit.begin(taskId, target),
  fork: (taskId, messageId) => workSessions.forkConversation(taskId, messageId),
  resolveFile: () => canOpenReference(),
  showToast
});
installSelectionGlide();
installCodeBlockActions(document, {
  showToast,
  openFile: (path, line) => {
    if (!openFileReference(path, line)) showToast(ui("项目里找不到这个文件"));
  }
});
const runControl = createRunControl({
  state,
  $,
  api,
  showToast,
  onChanged: () => refresh(),
  interruptRun: (taskId) => delivery.stopRound(taskId),
  continueRun: (taskId) => delivery.continuePausedRun(taskId),
  isContinuing: (taskId) => delivery.isContinuing(taskId)
});
function renderConversation(messages, task) {
  conversationView.renderConversation(messages, task);
  backendFiles.hydrateImages($("#conversation"));
}
const connection = createConnectionController({
  state,
  renderConversation,
  loadDetail,
  openStream: (path, options) => management.openStream(path, options)
});
const connectEventStream = (taskId) => connection.connect(taskId);

const projectController = createProjectController({
  openAddProject: () => addProjectController.open(),
  state,
  $,
  api,
  storage: draftStorage,
  showToast,
  beginConversation: (projectId) => beginNewConversation(projectId),
  onSelectionChanged: (project) => {
    if (!state.selected) composerSession.activate(null, { projectId: project.projectId });
  },
  isTaskVisible: () => true,
  isUnread: (taskId) => conversationReadState.isUnread(taskId),
  selectConversation,
  conversationTitle,
  openTaskMenu: (node, taskId, options) => sessionMenu.open(node, taskId, options),
  quickTaskAction: (action, taskId) => {
    const task = state.tasks.find((entry) => entry.taskId === taskId);
    if (task) void sessionAction(action, taskId, task);
  },
  onRendered: () => {
    // The project list has just been drawn: a draft's project may only be known now.
    void trustPrompt.check();
    if (!sessionMenu.isOpen) return;
    const trigger = $("#project-list").querySelector(
      `.conversation-item[data-task="${CSS.escape(sessionMenu.taskId)}"]`
    );
    if (trigger) sessionMenu.rebind(trigger);
    else sessionMenu.close();
  },
  getNavigationIdentity: () =>
    JSON.stringify([state.selected, state.selectedProjectId, composerSession.currentToken]),
  onUpdated: () => void refresh()
});
const addProjectController = createAddProjectController({
  api,
  command: (path, options) => (api.command ? api.command(path, options) : api(path, options)),
  showToast,
  onCreated: async (project) => {
    const navigation = () =>
      JSON.stringify([state.selected, state.selectedProjectId, composerSession.currentToken]);
    const before = navigation();
    await refresh();
    // The person moved elsewhere while the catalog loaded: the new project is listed, and they stay put.
    if (navigation() !== before) return;
    projectController.select(project.projectId);
    beginNewConversation(project.projectId);
  },
  onListed: () => refresh()
});
const newSession = createNewSessionView({
  state,
  $,
  titleFor: (task) => conversationTitle(task),
  onOpenTask: (taskId) => {
    const task = state.tasks.find((entry) => entry.taskId === taskId);
    if (task) projectController.selectTask(task);
    selectConversation(taskId);
  },
  onSelectProject: (projectId) => beginNewConversation(projectId),
  onAddProject: () => projectController.openCreate()
});
const draftRecovery = createDraftRecovery({
  button: $("#recover-drafts"),
  session: composerSession,
  getBackend: () => catalog.backendId,
  getContext: () => catalog.revision,
  getProjects: () => state.projects,
  openDraft: (projectId) => beginNewConversation(projectId)
});
async function humanAction(taskId, action, body) {
  const result = await api(`/api/tasks/${encodeURIComponent(taskId)}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (state.selected === taskId) {
    await loadDetail(taskId);
    connectEventStream(taskId);
  }
  return result;
}

const composerModel = createComposerModel({
  $,
  api,
  storage: draftStorage,
  selectedTask: () => state.selected,
  composerProjectDirectory: () => {
    const projectId = composerProjectId();
    return state.projects.find((entry) => entry.projectId === projectId)?.projectDirectory || "";
  },
  updateSendButton
});
function onModelChanged() {
  void composerModel.connectionChanged().then(() => refresh());
}
const workSessions = createWorkSessions({
  $,
  state,
  api,
  composerSession,
  composerModel,
  projectController,
  newOperationId: () => management.newOperationId(),
  currentSubmission: () => delivery.currentSubmission(),
  closeSessionMenu: () => sessionMenu.close(),
  markRead: (taskId) => conversationReadState.setUnread(taskId, false),
  resetRunControl: () => runControl.reset(),
  resetRequirements: () => requirementPanel.reset(),
  connectEventStream,
  closeStream: () => connection.close(),
  renderConversationList,
  renderEmpty,
  loadDetail,
  updateSendButton,
  showToast
});
const openTaskSearch = createTaskSearch({
  $,
  tasks: () => state.tasks,
  selectConversation
});

createConversationLayout($("#conversation"));
// Interrupting a run discards the step in flight, so the stop key asks first.
$("#stop-button").addEventListener("click", () => runControl.confirmInterrupt($("#stop-button")));

bindWorkShortcuts({
  $,
  beginNewConversation,
  openTaskSearch,
  toggleOutputPane,
  artifactDrawerOpen: () => state.artifactDrawerOpen,
  closeArtifactDrawer
});
const sessionAction = createConversationOperations({
  readState: conversationReadState,
  onReadChange: () => renderConversationList(),
  titleFor: conversationTitle,
  api,
  refresh,
  getNavigation: () => ({ taskId: state.selected, token: composerSession.currentToken }),
  openNewConversation: () => beginNewConversation(),
  stop: (taskId) => delivery.stopTask(taskId),
  showToast
});
const sessionMenu = createConversationMenu({
  panel: $("#session-menu"),
  getTask: (taskId) => state.tasks.find((task) => task.taskId === taskId),
  getContext: () => JSON.stringify([state.selected]),
  isTaskActive: (taskId, task) =>
    ["running", "waiting"].includes(task.status) ||
    (state.detail?.task?.taskId === taskId && state.detail?.runtime?.active),
  isTaskStopping: (taskId) => delivery.isTaskStopping(taskId),
  isUnread: (taskId) => conversationReadState.isUnread(taskId),
  onAction: (action, taskId, task) => void sessionAction(action, taskId, task)
});

window.addEventListener("resize", () => sessionMenu.reposition());
$("#project-list").addEventListener("scroll", () => sessionMenu.reposition(), true);
window.addEventListener("storage", (event) => {
  if (event.key !== "atria.conversations.unread.v1" && event.key !== null) return;
  conversationReadState.reload();
  renderConversationList();
});
window.addEventListener("popstate", () => {
  const taskId = conversationTaskId(location.href);
  if (!taskId || taskId === state.selected) return;
  if (state.tasks.some((task) => task.taskId === taskId)) selectConversation(taskId);
});
observation = createObservationSettings({
  $,
  api,
  management,
  storage: draftStorage,
  sessionStorage: browserSessionStorage,
  isOnline: () => state.online,
  snapshot: () => ({ projects: state.projects, tasks: state.tasks }),
  visibleProjects: () => projectController.visibleProjects(),
  entryController,
  onModelChanged,
  beginNewConversation,
  showToast
});
const firstUse = createFirstUseView({
  state,
  $,
  projectCount: () => projectController.visibleProjects().length,
  onConnectModel: () => void modelSettings.open(),
  onAddProject: () => projectController.openCreate()
});
$("#titlebar-search").addEventListener("click", openTaskSearch);
$("#sidebar-search").addEventListener("click", openTaskSearch);

function beginNewConversation(projectId) {
  return workSessions.beginNewConversation(projectId);
}
function selectConversation(taskId) {
  workSessions.selectConversation(taskId);
}
function renderConversationList() {
  workView.renderConversationList();
}
function renderAll() {
  workView.renderAll();
}
function renderEmpty() {
  workView.renderEmpty();
}
function toggleOutputPane() {
  return workView.toggleOutputPane();
}
function refresh(options) {
  return catalog.refresh(options);
}
function loadDetail(taskId, options) {
  return catalog.loadDetail(taskId, options);
}
function updateSendButton() {
  delivery.updateSendButton();
}

const workView = createWorkView({
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
  renderRunControl: () => runControl.render(),
  markRendered: (detail) => catalog.markRendered(detail),
  composerModel
});
const catalog = createSessionCatalog({
  state,
  api,
  composerSession,
  composerModel,
  projectController,
  connection,
  taskNotifications,
  initialConversationTaskId,
  connectedBackend: () => management.state().backendId,
  resetBackendFiles: () => {
    computerUse.reset();
    artifactViewer.reset();
    artifacts.resetMedia();
    backendFiles.clear();
  },
  resetRequirements: (taskId) => requirementPanel.reset(taskId),
  onOnline: (online) => backendConnection?.setOnline(online),
  onBackendChanged: () => void draftRecovery.refresh(),
  onCatalogChanged: () => observation.data.localChanged(),
  composerHasUnsentContent: () => delivery.composerHasUnsentContent(),
  renderConversationList,
  renderAll,
  renderEmpty,
  updateSendButton,
  showToast
});
const delivery = createConversationDelivery({
  $,
  state,
  api,
  composerSession,
  composerModel,
  composerMenu,
  attachments: composerAttachments,
  messageEdit,
  firstUse,
  createTask: workSessions.createTask,
  connectEventStream,
  renderAll,
  refresh,
  loadDetail,
  isBackendReady: () => Boolean(backendConnection?.ready()),
  waiting: () => runControl.waiting(),
  openModelSettings: () => modelSettings.open(),
  showToast
});

composerSession.activate(state.selected, { projectId: state.selectedProjectId });
// The page ships the composer read-only: the draft lease and this first
// activation both write the input, so earlier typing would be overwritten.
// Text typed from here on, including while the backend connects, is kept.
$("#composer-input").readOnly = false;
$("#composer-input").removeAttribute("aria-busy");
/**
 * Authorize this page and load its backend.
 *
 * The page can manage another local backend than the one that served it, so
 * nothing is read before the session binds; a refused session or an
 * incompatible protocol leaves the page in an actionable state instead of a
 * half-populated screen.
 */
async function bootBackend() {
  const connected = await management.connect({
    baseUrl: window.bookmanDesktop?.backend ? "" : management.rememberedTarget()
  });
  if (connected.status !== "connected") {
    updateSendButton();
    return;
  }
  // Bind drafts to the backend before the first conversation is activated, or
  // the composer would read the pre-connection namespace.
  catalog.adoptBackendIdentity(connected.backendId);
  void computerUse.refresh();
  await composerModel.refresh();
  await refresh();
  await draftRecovery.refresh();
  updateSendButton();
  if (window.bookmanDesktop && state.modelConfigured === false) void modelSettings.open();
}
initialized = true;
void bootBackend();
// Reserve initial navigation before starting reads that can restore a tab.
// Automatic reads pause while hidden; explicit actions still refresh directly.
// A catalog read stays as the bounded fallback; live changes arrive as events.
createVisiblePoll({ run: () => refresh({ poll: true }), intervalMs: 3500 });
// List metadata supplies immediate Task version changes. This independent
// fallback catches external history/job changes even without a Task version bump.
createVisiblePoll({
  run: () => {
    if (state.selected) {
      connectEventStream(state.selected);
      return loadDetail(state.selected, { poll: true });
    }
  },
  intervalMs: () =>
    connection.isStreaming(state.selected) ? 30000 : state.detail?.runtime?.active ? 3500 : 15000
});

async function prepareInterfaceClose() {
  if (composerAttachments.busy) {
    showToast(ui("附件仍在读取，请稍候再关闭窗口或更新模型连接"));
    return false;
  }
  const repliesSaved = humanQuestions.flushDrafts();
  if (!repliesSaved) showToast(ui("人工回复草稿暂时无法保存，请保留当前窗口并稍后重试"));
  const composerSaved = composerSession.prepareClose();
  return repliesSaved && composerSaved;
}
observation.data.start();
backendConnection = createBackendConnection({
  management,
  settingsHost: observation.settingsPages.host,
  showToast,
  onReady: async ({ backendId }) => {
    catalog.adoptBackendIdentity(backendId);
    void computerUse.refresh();
    await composerModel.refresh();
    await refresh();
    updateSendButton();
  }
});
window.bookmanDesktop?.onPrepareClose(prepareInterfaceClose);
installLanguageSettings({ prepareClose: prepareInterfaceClose, storage: draftStorage });
installSelectMenus();
installDesktopUpdates({ host: observation.settingsPages.host });
const modelSettings = installDesktopSettings({
  host: observation.settingsPages.host,
  showToast,
  api,
  identity: () => {
    const current = management.state();
    return current.status === "connected"
      ? JSON.stringify([current.backendId, current.baseUrl, current.pid, current.startedAt])
      : null;
  },
  onSaved: onModelChanged
});
$("#model-setup-button").addEventListener("click", () => void modelSettings.open());
