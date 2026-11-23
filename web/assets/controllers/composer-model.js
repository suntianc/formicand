import { ui } from "../ui/language.js";
import { createMenu } from "../ui/menu.js";
import { rememberedTaskMap } from "../remembered-choices.js";
import { providerLogo } from "./model-provider-display.js";
import { createModelPicker, DEFAULT_LEVELS, LEVEL_LABELS, nearestLevel } from "./model-picker.js";

export function createComposerModel({
  $,
  api,
  storage,
  selectedTask,
  composerProjectDirectory,
  updateSendButton
}) {
  const modelState = {
    models: [],
    defaultModel: null,
    model: null,
    // The model picked for each conversation, remembered across restarts like
    // its level and provider; a conversation without one shows the default.
    modelByTask: rememberedTaskMap(() => storage, "atria.model.model-by-task"),
    /**
     * A model picked from another provider: its profile id, sent with each run so
     * that run uses that provider. Null follows the Main connection.
     */
    profileId: null,
    // Remembered per conversation across restarts (`remembered-choices.js`).
    profileByTask: rememberedTaskMap(() => storage, "atria.model.profile-by-task"),
    /** Usable providers and their models, from /api/models. */
    modelProviders: [],
    mainProviderId: "",
    /**
     * The level the user picked for the current conversation, or null to let the
     * Main connection's saved level govern. The two are separate on purpose: an
     * inherited level must never be sent as if it were a choice.
     */
    thinkingLevel: null,
    thinkingLevelByTask: rememberedTaskMap(() => storage, "atria.model.level-by-task"),
    /** Per model: the reasoning levels it accepts and where they came from (#27). */
    modelLevels: {},
    /** The Main connection's saved level, reported by the server for the label. */
    mainThinkingLevel: null,
    /**
     * The project directory the model list was read for ("" for none): a project
     * may give Main its own model, so the composer reads it again on a switch.
     */
    modelScope: undefined,
    /** The project the latest model read asks for, so a render does not ask twice. */
    modelReadScope: undefined,
    /** Main's model per project as last read, to tell a real change from a switch. */
    mainByScope: new Map(),
    modelConfigured: undefined
  };

  // The last model a person picked stays as the default for the next new
  // conversation, so switching once is enough instead of re-picking each time.
  const PREFERRED_MODEL_KEY = "atria.model.preferred";
  function readPreferredModel() {
    try {
      return (storage && storage.getItem(PREFERRED_MODEL_KEY)) || "";
      // eslint-disable-next-line no-restricted-syntax -- getItem throws when the browser blocks storage, and the composer must still start with no preferred model
    } catch {
      return "";
    }
  }
  function writePreferredModel(model) {
    try {
      if (!storage) return;
      if (model) storage.setItem(PREFERRED_MODEL_KEY, model);
      else storage.removeItem(PREFERRED_MODEL_KEY);
      // eslint-disable-next-line no-restricted-syntax -- best-effort preference write: blocked or full storage only loses the remembered model
    } catch {
      /* storage may be disabled */
    }
  }
  const PREFERRED_PROFILE_KEY = "atria.model.preferred-profile";
  function readPreferredProfile() {
    try {
      return (storage && storage.getItem(PREFERRED_PROFILE_KEY)) || "";
      // eslint-disable-next-line no-restricted-syntax -- getItem throws when the browser blocks storage; the composer then follows the Main connection
    } catch {
      return "";
    }
  }
  function writePreferredProfile(profileId) {
    try {
      if (!storage) return;
      if (profileId) storage.setItem(PREFERRED_PROFILE_KEY, profileId);
      else storage.removeItem(PREFERRED_PROFILE_KEY);
      // eslint-disable-next-line no-restricted-syntax -- best-effort preference write: blocked or full storage only loses the remembered provider
    } catch {
      /* storage may be disabled */
    }
  }
  function setModelLabel(value) {
    const label = String(value || "").trim();
    if (!label) return;
    const name = $(".model-name");
    if (name) name.textContent = label;
    else $(".model-select").textContent = label;
    paintModelProvider();
    paintModelButton();
  }
  /** The composer's model button carries the mark of the provider the models come from. */
  function paintModelProvider(provider) {
    if (provider !== undefined) modelState.modelProvider = provider || null;
    const slot = $("#model-select .model-logo");
    const shown = pickedProfile()?.provider || modelState.modelProvider;
    if (!slot) return;
    slot.innerHTML = providerLogo(shown, 18, modelState.model || modelState.defaultModel);
  }
  /** One button names the model and the reasoning level this Run will send. */
  function paintModelButton() {
    const button = $("#model-select");
    if (!button) return;
    const model = $(".model-name")?.textContent || "";
    const level = $(".reasoning-name")?.textContent || "";
    button.title = ui`切换模型与推理强度 · ${model} · 推理 ${level}`;
    button.setAttribute("aria-label", ui`模型：${model}，推理强度：${level}`);
  }

  const THINKING_LEVEL_LABELS = LEVEL_LABELS;
  /** The model entry of a profile picked from another provider, with its provider. */
  function pickedProfile(profileId = modelState.profileId) {
    if (!profileId) return null;
    for (const provider of modelState.modelProviders) {
      const model = provider.models.find((entry) => entry.profileId === profileId);
      if (model) return { provider, model };
    }
    return null;
  }
  /** The reasoning levels the selected model accepts (#27). */
  function modelLevelsFor(model = modelState.model || modelState.defaultModel) {
    const picked = pickedProfile();
    if (picked && picked.model.id === model) return picked.model.levels || DEFAULT_LEVELS;
    return modelState.modelLevels[model]?.levels || DEFAULT_LEVELS;
  }
  /** The level the connection this run uses applies when nothing is picked. */
  function baseThinkingLevel() {
    return pickedProfile()?.model.reasoningEffort || modelState.mainThinkingLevel || null;
  }
  /**
   * The level used when nothing is picked: the Main connection's saved level,
   * or the nearest one this model accepts when it does not take that one.
   */
  function fallbackThinkingLevel() {
    return nearestLevel(baseThinkingLevel(), modelLevelsFor());
  }
  /** What a run sends: the pick, or the fallback only when it had to move. */
  function sentThinkingLevel() {
    if (modelState.thinkingLevel) return modelState.thinkingLevel;
    const fallback = fallbackThinkingLevel();
    return fallback && fallback !== baseThinkingLevel() ? fallback : undefined;
  }
  function setThinkingLabel(value) {
    // An unpicked level is not a choice: the label names what this Run will
    // actually send, which is the Main connection's saved level.
    const effective = value || fallbackThinkingLevel();
    const label = effective ? THINKING_LEVEL_LABELS[effective] || effective : ui("自动");
    const name = $(".reasoning-name");
    if (name) name.textContent = label;
    // No reasoning reads as just the model's name, not "model · Off".
    $(".reasoning-label")?.classList.toggle("is-off", !effective || effective === "off");
    paintModelButton();
  }

  // A new conversation inherits the last picked model when it is still offered
  // by the current connection; otherwise it falls back to the configured default.
  function defaultModelForNewConversation() {
    const preferred = readPreferredModel();
    if (preferred && (!modelState.models.length || modelState.models.includes(preferred))) return preferred;
    return modelState.defaultModel;
  }

  function syncModelConnection(model, profileId, mainEffort, scope = modelState.modelScope ?? "") {
    // Only the model list reports the Main connection's level; a catalog refresh
    // omits it and must not erase what the composer is showing.
    if (mainEffort !== undefined) modelState.mainThinkingLevel = mainEffort;
    // The first read after start, or of another project, is not a switch: each
    // conversation keeps the level and provider remembered for it. A real switch
    // of a project's Main connection starts every conversation's choices over.
    const main = `${profileId}\n${model}`;
    const before = modelState.mainByScope.get(scope);
    modelState.mainByScope.set(scope, main);
    if (before !== undefined && before !== main) {
      modelState.modelByTask.clear();
      modelState.profileByTask.clear();
      modelState.thinkingLevelByTask.clear();
    }
    if (modelState.connectionProfileId !== profileId || modelState.defaultModel !== model) {
      const taskId = selectedTask();
      modelState.connectionProfileId = profileId;
      modelState.profileId = taskId ? (modelState.profileByTask.get(taskId) ?? null) : null;
      // A remembered model of another provider is that provider's, not the default.
      modelState.model = pickedProfile()?.model.id ?? (taskId && modelState.modelByTask.get(taskId)) ?? model;
      modelState.thinkingLevel = taskId ? (modelState.thinkingLevelByTask.get(taskId) ?? null) : null;
    }
    modelState.defaultModel = model;
    modelState.model ||= model;
    setModelLabel(modelState.model);
    setThinkingLabel(modelState.thinkingLevel);
  }

  let modelReadSequence = 0;
  async function loadModels() {
    const scope = composerProjectDirectory();
    const sequence = ++modelReadSequence;
    modelState.modelReadScope = scope;
    try {
      const data = await api(
        scope ? `/api/models?projectDirectory=${encodeURIComponent(scope)}` : "/api/models"
      );
      // A later read, for another project, has the say.
      if (sequence !== modelReadSequence) return;
      modelState.modelScope = scope;
      modelState.modelConfigured = data.configured;
      updateSendButton();
      modelState.models = Array.isArray(data.models)
        ? data.models.filter((model) => typeof model === "string" && model.trim())
        : [];
      modelState.modelLevels = data.levels && typeof data.levels === "object" ? data.levels : {};
      const defaultModel =
        typeof data.current === "string" && data.current.trim()
          ? data.current.trim()
          : modelState.models[0] || "glm-5.3";
      // Providers first: restoring a remembered provider looks its model up.
      modelState.modelProviders = Array.isArray(data.providers) ? data.providers : [];
      modelState.mainProviderId = typeof data.mainProviderId === "string" ? data.mainProviderId : "";
      syncModelConnection(defaultModel, data.connectionProfileId, data.reasoningEffort ?? null, scope);
      if (modelState.profileId && !pickedProfile()) modelState.profileId = null;
      paintModelProvider(data.provider);
      // eslint-disable-next-line no-restricted-syntax -- /api/models is unavailable while the backend restarts or is offline; the picker keeps a usable model instead of an empty list
    } catch {
      modelState.models = modelState.model ? [modelState.model] : ["glm-5.3"];
      modelState.defaultModel ||= modelState.models[0];
      modelState.model ||= modelState.defaultModel;
      setModelLabel(modelState.model);
    }
  }

  function positionModelMenu(button = $("#model-select"), menu = $("#model-menu")) {
    if (!menu || !button || menu.hidden || !menu.offsetParent) return;
    const bounds = menu.offsetParent.getBoundingClientRect();
    const anchor = button.getBoundingClientRect();
    const maximum = Math.max(0, bounds.width - menu.getBoundingClientRect().width);
    menu.style.left = `${Math.min(maximum, Math.max(0, anchor.left - bounds.left))}px`;
  }

  let modelNotice = "";
  const modelPicker = createModelPicker({
    panel: $("#model-menu"),
    view: () => ({
      model: modelState.model || modelState.defaultModel || "glm-5.3",
      defaultModel: modelState.defaultModel,
      models: modelState.models.length
        ? modelState.models
        : [modelState.model || modelState.defaultModel || "glm-5.3"],
      levels: modelLevelsFor(),
      chosen: modelState.thinkingLevel,
      fallback: fallbackThinkingLevel(),
      notice: modelNotice,
      provider: modelState.modelProvider
        ? {
            name: modelState.modelProvider.name,
            mark: providerLogo(modelState.modelProvider, 18, modelState.model || modelState.defaultModel)
          }
        : null,
      groups: pickerGroups()
    }),
    chooseModel,
    chooseLevel: chooseThinkingLevel
  });

  function renderModelMenu(page = "effort") {
    const menu = $("#model-menu");
    const button = $("#model-select");
    if (!menu || !button) return;
    modelNotice = "";
    menu.hidden = false;
    modelPicker.open(page);
    positionModelMenu();
    button.setAttribute("aria-expanded", "true");
  }

  function closeModelMenu() {
    const menu = $("#model-menu");
    const button = $("#model-select");
    if (!menu || !button) return;
    menu.hidden = true;
    modelNotice = "";
    button.setAttribute("aria-expanded", "false");
  }

  /** `page: "models"` opens straight on the model list, as the error card's 切换模型 does. */
  async function toggleModelMenu({ page = "effort" } = {}) {
    const menu = $("#model-menu");
    if (!menu) return;
    if (!menu.hidden) return closeModelMenu();
    if (!modelState.models.length) await loadModels();
    renderModelMenu(page);
  }

  /**
   * Every usable provider's models for the picker. The Main connection's own
   * provider comes first; the active entry is the picked profile, or the model
   * on that provider when nothing else was picked.
   */
  function pickerGroups() {
    if (!modelState.modelProviders.length) return null;
    const mainProvider = modelState.mainProviderId;
    const model = modelState.model || modelState.defaultModel;
    const ordered = [...modelState.modelProviders].sort(
      (left, right) => Number(right.id === mainProvider) - Number(left.id === mainProvider)
    );
    return ordered.map((provider) => ({
      name: provider.name,
      mark: providerLogo(provider, 18),
      models: provider.models.map((entry) => ({
        id: entry.id,
        mark: providerLogo(provider, 18, entry.id),
        profileId: entry.profileId,
        active: modelState.profileId
          ? entry.profileId === modelState.profileId
          : provider.id === mainProvider && entry.id === model,
        isDefault: provider.id === mainProvider && entry.id === modelState.defaultModel
      }))
    }));
  }

  /** Picking a model keeps the popover open; a pick it does not accept moves to the nearest level. */
  function chooseModel(model, profileId = null) {
    const selected = String(model || "").trim();
    if (!selected) return;
    modelState.model = selected;
    // A model of the Main connection's own provider follows that connection.
    const mainProvider = modelState.mainProviderId;
    modelState.profileId = profileId && !profileId.startsWith(`${mainProvider}#`) ? profileId : null;
    const taskId = selectedTask();
    if (taskId) {
      modelState.modelByTask.set(taskId, selected);
      modelState.profileByTask.set(taskId, modelState.profileId);
    }
    writePreferredModel(selected);
    writePreferredProfile(modelState.profileId);
    setModelLabel(selected);
    const picked = modelState.thinkingLevel;
    const kept = nearestLevel(picked, modelLevelsFor(selected));
    modelNotice =
      picked && kept !== picked
        ? ui`此模型不支持「${THINKING_LEVEL_LABELS[picked] || picked}」，已改为「${THINKING_LEVEL_LABELS[kept] || kept}」。`
        : "";
    if (kept !== picked) {
      modelState.thinkingLevel = kept;
      if (taskId) modelState.thinkingLevelByTask.set(taskId, kept);
    }
    setThinkingLabel(modelState.thinkingLevel);
  }

  /** `null` returns to the connection's default; the popover stays open on the rail. */
  function chooseThinkingLevel(value) {
    const selected = value ? String(value).trim() : null;
    if (selected && !modelLevelsFor().includes(selected)) return;
    modelState.thinkingLevel = selected;
    const taskId = selectedTask();
    if (taskId) modelState.thinkingLevelByTask.set(taskId, selected);
    modelNotice = "";
    setThinkingLabel(selected);
    if (!$("#model-menu").hidden) modelPicker.render({ focus: true });
  }

  $("#model-select").addEventListener("click", () => void toggleModelMenu());
  document.addEventListener("click", (event) => {
    // The popover redraws its page on a click, so the target may be detached by now.
    if (!event.composedPath().some((node) => node.id === "model-select" || node.id === "model-menu"))
      closeModelMenu();
  });
  createMenu($("#model-select"), $("#model-menu"), {
    toggleOnClick: false,
    closeOnSelect: false,
    onClose: closeModelMenu
  });
  window.addEventListener("resize", () => positionModelMenu());

  function acceptCatalog(data) {
    // The host's Main arrives before provider discovery; a project owns its model list.
    if (!data.model || modelState.modelScope) return;
    if (data.connectionProfileId) syncModelConnection(data.model, data.connectionProfileId);
    else {
      modelState.defaultModel = data.model;
      if (!modelState.model) modelState.model = data.model;
      const taskId = selectedTask();
      if (!taskId || !modelState.modelByTask.has(taskId)) setModelLabel(modelState.model);
    }
  }
  function showTaskChoices(taskId, task, detail) {
    const taskModel = modelState.connectionProfileId ? modelState.defaultModel : task?.model;
    modelState.model =
      modelState.modelByTask.get(taskId) ||
      detail?.runtime?.model ||
      taskModel ||
      modelState.defaultModel ||
      modelState.model;
    modelState.profileId = modelState.profileByTask.get(taskId) ?? null;
    setModelLabel(modelState.model);
    modelState.thinkingLevel = modelState.thinkingLevelByTask.get(taskId) ?? null;
    setThinkingLabel(modelState.thinkingLevel);
  }
  function beginNew() {
    modelState.model = defaultModelForNewConversation();
    const profile = readPreferredProfile();
    modelState.profileId = pickedProfile(profile)?.model.id === modelState.model ? profile : null;
    setModelLabel(modelState.model);
    modelState.thinkingLevel = null;
    setThinkingLabel(modelState.thinkingLevel);
  }
  function rememberTaskChoices(taskId) {
    if (modelState.model) modelState.modelByTask.set(taskId, modelState.model);
    modelState.profileByTask.set(taskId, modelState.profileId);
    modelState.thinkingLevelByTask.set(taskId, modelState.thinkingLevel);
  }
  function acceptRun(taskId, runModel) {
    if (!runModel) return;
    modelState.modelByTask.set(taskId, runModel);
    if (selectedTask() === taskId) {
      modelState.model = runModel;
      setModelLabel(runModel);
    }
  }
  function syncProject() {
    // Another project may give Main another model.
    if (modelState.modelScope !== undefined && composerProjectDirectory() !== modelState.modelReadScope)
      void loadModels();
  }
  function connectionChanged() {
    modelState.model = null;
    return loadModels();
  }
  function resetBackend() {
    // Conversation ids remain distinct when a backend is switched or recovered.
    modelState.mainThinkingLevel = null;
    modelState.models = [];
    modelState.model = null;
    modelState.defaultModel = null;
    modelState.modelConfigured = undefined;
    modelState.connectionProfileId = undefined;
    modelState.modelScope = undefined;
    modelState.modelReadScope = undefined;
    modelState.mainByScope.clear();
  }
  return {
    refresh: loadModels,
    connectionChanged,
    resetBackend,
    acceptCatalog,
    showTaskChoices,
    beginNew,
    rememberTaskChoices,
    acceptRun,
    syncProject,
    setLabel: setModelLabel,
    toggleMenu: toggleModelMenu,
    sentThinkingLevel,
    get configured() {
      return modelState.modelConfigured;
    },
    get model() {
      return modelState.model;
    },
    get defaultModel() {
      return modelState.defaultModel;
    },
    get profileId() {
      return modelState.profileId;
    }
  };
}
