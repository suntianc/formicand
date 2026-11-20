import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../ui/html.js";
import { createModal } from "../ui/modal.js";
import { formatStamp } from "../ui/time-format.js";

/**
 * Settings → Memory.
 *
 * What Main remembers across sessions, in two scopes: the user's own (every
 * project) and one project's, picked from the project selector. Main writes
 * these itself; here the user reads, edits, adds and deletes them, and can
 * switch a project's memory off so Main neither sees nor writes it.
 */
const TYPE_LABEL = { user: "用户", feedback: "纠正与认可", project: "项目情况", reference: "外部资料" };
const TYPE_ICON = { user: "team", feedback: "messages-square", project: "folder", reference: "link" };
const BLANK = { name: "", type: "feedback", description: "", body: "" };

export function createMemorySettings({ panel, api, projects = () => [], onSection, showToast = () => {} }) {
  const view = {
    scope: "user",
    projectId: "",
    selected: "",
    /** The memory in the editor: its saved name (empty for a new one) and the draft. */
    editing: undefined,
    loading: false,
    error: "",
    data: { memories: [] }
  };
  let requestSeq = 0;

  const target = () =>
    view.scope === "project" ? { scope: "project", projectId: view.projectId } : { scope: "user" };
  const targetQuery = () =>
    view.scope === "project" ? `scope=project&projectId=${encodeURIComponent(view.projectId)}` : "scope=user";
  const post = (path, json) => api(path, { method: "POST", json });

  panel.innerHTML = ui`<div class="skill-head">
      <h1 class="settings-page-title">记忆</h1>
      <div class="settings-segmented" role="radiogroup" aria-label="范围" data-memory-scope>
        <button type="button" role="radio" data-memory-scope-value="user" aria-checked="true">用户</button>
        <button type="button" role="radio" data-memory-scope-value="project" aria-checked="false">项目</button>
      </div>
      <span class="settings-group-spacer"></span>
      <span class="settings-head-note">${icon("info")}<span data-memory-note></span></span>
      <button class="app-button is-primary skill-add" type="button" data-memory-add>${icon("plus")}<span>新建记忆</span></button>
    </div>
    <div class="skill-body">
      <div class="skill-list-pane">
        <div class="settings-project" data-memory-project hidden>
          <label class="settings-project-picker">
            ${icon("folder")}
            <span class="settings-project-text"><span data-memory-project-name></span></span>
            ${icon("chevrons-up-down")}
            <select data-memory-project-select aria-label="项目"></select>
          </label>
          <label class="settings-project-trust memory-enabled"><input type="checkbox" data-memory-enabled><span>Main 使用这个项目的记忆</span></label>
        </div>
        <ul class="skill-list" data-memory-list aria-label="记忆列表"></ul>
      </div>
      <div class="skill-detail" data-memory-detail aria-live="polite"></div>
    </div>`;

  const $ = (selector) => panel.querySelector(selector);

  /* ---------------------------------------------------------------- data */

  async function load() {
    const seq = ++requestSeq;
    if (view.scope === "project" && !view.projectId) view.projectId = projects()[0]?.projectId ?? "";
    if (view.scope === "project" && !view.projectId) {
      view.data = { memories: [] };
      view.error = "";
      render();
      return;
    }
    view.loading = true;
    render();
    try {
      const data = await api(`/api/memory?${targetQuery()}`);
      if (seq !== requestSeq) return;
      view.data = data;
      view.error = "";
    } catch (error) {
      if (seq !== requestSeq) return;
      view.data = { memories: [] };
      view.error = error?.message || ui("记忆读取失败");
    } finally {
      if (seq === requestSeq) {
        view.loading = false;
        render();
      }
    }
  }

  async function open(name) {
    view.selected = name;
    try {
      const { memory } = await api(`/api/memory/read?${targetQuery()}&name=${encodeURIComponent(name)}`);
      view.editing = { savedName: name, draft: memory };
    } catch (error) {
      view.editing = undefined;
      showToast(error?.message || ui("记忆读取失败"));
    }
    render();
  }

  /* ---------------------------------------------------------------- render */

  function renderProjectBar() {
    const bar = $("[data-memory-project]");
    bar.hidden = view.scope !== "project";
    if (bar.hidden) return;
    const list = projects();
    const select = $("[data-memory-project-select]");
    select.innerHTML = list.length
      ? list
          .map(
            (project) =>
              `<option value="${esc(project.projectId)}"${project.projectId === view.projectId ? " selected" : ""}>${esc(project.projectName || project.projectDirectory)}</option>`
          )
          .join("")
      : `<option value="">${ui("还没有项目")}</option>`;
    select.disabled = !list.length;
    const chosen = list.find((project) => project.projectId === view.projectId);
    $("[data-memory-project-name]").textContent = chosen
      ? chosen.projectName || chosen.projectDirectory
      : ui("还没有项目");
    const enabled = $("[data-memory-enabled]");
    enabled.disabled = !chosen;
    enabled.checked = view.data.enabled !== false;
  }

  function emptyText() {
    if (view.loading) return ui("正在读取…");
    if (view.error) return view.error;
    if (view.scope === "project" && !projects().length) return ui("先添加一个项目");
    return ui("还没有记忆");
  }

  function renderList() {
    const memories = view.data.memories;
    $("[data-memory-list]").innerHTML = memories.length
      ? memories
          .map(
            (
              memory
            ) => `<li><button type="button" class="skill-row" data-memory-select="${esc(memory.name)}" aria-current="${memory.name === view.selected}">
              <span class="settings-icon-box">${icon(TYPE_ICON[memory.type])}</span>
              <span class="skill-row-text"><span class="skill-row-name">${esc(memory.name)}</span><span class="skill-row-desc">${esc(memory.description)}</span></span>
              <span class="skill-tag">${esc(ui(TYPE_LABEL[memory.type]))}</span>
            </button></li>`
          )
          .join("")
      : `<li class="skill-empty">${esc(emptyText())}</li>`;
  }

  function renderDetail() {
    const detail = $("[data-memory-detail]");
    if (!view.editing) {
      detail.innerHTML = "";
      return;
    }
    const { savedName, draft } = view.editing;
    const saved = view.data.memories.find((memory) => memory.name === savedName);
    detail.innerHTML = ui`<form class="agent-form memory-form" data-memory-form>
        <div class="skill-detail-head">
          <span class="settings-icon-box is-large">${icon(TYPE_ICON[draft.type])}</span>
          <span class="skill-detail-title"><h2>${savedName ? esc(savedName) : ui("新记忆")}</h2>${saved ? `<span class="skill-tag">${esc(formatStamp(saved.updatedAt))}</span>` : ""}</span>
          <span class="settings-group-spacer"></span>
          ${savedName ? `<button class="app-button is-danger" type="button" data-memory-delete>${icon("trash")}<span>${ui("删除")}</span></button>` : ""}
          <button class="app-button is-primary" type="submit" data-memory-save>${icon("check")}<span>${ui("保存")}</span></button>
        </div>
        <div class="mcp-field">
          <label for="memory-name">名称</label><small>小写字母、数字和连字符</small>
          <input id="memory-name" data-memory-field="name" value="${esc(draft.name)}" autocomplete="off" spellcheck="false" maxlength="64">
        </div>
        <div class="mcp-field">
          <label for="memory-type">类型</label><span></span>
          <select id="memory-type" data-memory-field="type">${Object.entries(TYPE_LABEL)
            .map(
              ([value, label]) =>
                `<option value="${value}"${draft.type === value ? " selected" : ""}>${esc(ui(label))}</option>`
            )
            .join("")}</select>
        </div>
        <div class="mcp-field">
          <label for="memory-description">一句话说明</label><small>出现在 Main 每次看到的索引里</small>
          <input id="memory-description" data-memory-field="description" value="${esc(draft.description)}" autocomplete="off" maxlength="150">
        </div>
        <div class="mcp-field">
          <label for="memory-body">正文</label><small>Main 用到时才读</small>
          <textarea id="memory-body" data-memory-field="body" rows="10" maxlength="4000">${esc(draft.body)}</textarea>
        </div>
      </form>`;
  }

  function render() {
    for (const button of panel.querySelectorAll("[data-memory-scope-value]"))
      button.setAttribute("aria-checked", String(button.dataset.memoryScopeValue === view.scope));
    $("[data-memory-note]").textContent =
      view.scope === "project"
        ? ui("只在这个项目里用；关闭后 Main 看不到也写不了")
        : ui("跟着你走，所有项目的 Main 都会用到");
    $("[data-memory-add]").disabled = view.scope === "project" && !view.projectId;
    renderProjectBar();
    renderList();
    renderDetail();
  }

  /* ---------------------------------------------------------------- confirm */

  const confirmPanel = document.createElement("div");
  confirmPanel.className = "modal-backdrop app-dialog-backdrop";
  confirmPanel.hidden = true;
  confirmPanel.innerHTML = ui`<section class="modal-card app-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-confirm-title">
      <h2 id="memory-confirm-title" data-memory-confirm-title></h2>
      <p class="skill-confirm-copy">删除后 Main 不再记得这一条，无法撤销。</p>
      <div class="modal-actions dialog-actions">
        <button class="app-button is-secondary" type="button" data-memory-confirm-cancel>取消</button>
        <button class="app-button is-danger" type="button" data-memory-confirm-ok>删除</button>
      </div>
    </section>`;
  document.body.append(confirmPanel);
  const confirmModal = createModal(confirmPanel, confirmPanel.querySelector("[data-memory-confirm-cancel]"));
  confirmPanel.querySelector("[data-memory-confirm-ok]").addEventListener("click", async () => {
    confirmModal.close();
    const name = view.editing?.savedName;
    if (!name) return;
    try {
      await post("/api/memory/delete", { target: target(), name });
      showToast(ui("已删除"));
      view.editing = undefined;
      view.selected = "";
      await load();
    } catch (error) {
      showToast(error?.message || ui("操作未完成"));
    }
  });

  /* ---------------------------------------------------------------- events */

  function draftFromForm() {
    const field = (name) => panel.querySelector(`[data-memory-field="${name}"]`).value;
    return {
      name: field("name").trim(),
      type: field("type"),
      description: field("description"),
      body: field("body")
    };
  }

  async function save() {
    const { savedName } = view.editing;
    const memory = draftFromForm();
    view.editing = { savedName, draft: memory };
    try {
      const result = await post("/api/memory/save", {
        target: target(),
        memory,
        ...(savedName && savedName !== memory.name ? { previousName: savedName } : {})
      });
      showToast(ui("已保存"));
      view.selected = result.memory.name;
      view.editing = { savedName: result.memory.name, draft: result.memory };
      await load();
    } catch (error) {
      showToast(error?.message || ui("保存未完成"));
      render();
    }
  }

  panel.querySelector("[data-memory-scope]").addEventListener("click", (event) => {
    const button = event.target.closest("[data-memory-scope-value]");
    if (!button || button.dataset.memoryScopeValue === view.scope) return;
    view.scope = button.dataset.memoryScopeValue;
    view.selected = "";
    view.editing = undefined;
    view.data = { memories: [] };
    void load();
  });
  $("[data-memory-project-select]").addEventListener("change", (event) => {
    view.projectId = event.target.value;
    view.selected = "";
    view.editing = undefined;
    view.data = { memories: [] };
    void load();
  });
  $("[data-memory-enabled]").addEventListener("change", async (event) => {
    try {
      await post("/api/memory/enabled", { projectId: view.projectId, enabled: event.target.checked });
      showToast(event.target.checked ? ui("Main 会使用这个项目的记忆") : ui("Main 不再使用这个项目的记忆"));
      await load();
    } catch (error) {
      showToast(error?.message || ui("操作未完成"));
      await load();
    }
  });
  $("[data-memory-list]").addEventListener("click", (event) => {
    const row = event.target.closest("[data-memory-select]");
    if (row) void open(row.dataset.memorySelect);
  });
  $("[data-memory-add]").addEventListener("click", () => {
    view.selected = "";
    view.editing = { savedName: "", draft: { ...BLANK } };
    render();
    panel.querySelector('[data-memory-field="name"]').focus();
  });
  $("[data-memory-detail]").addEventListener("submit", (event) => {
    event.preventDefault();
    void save();
  });
  $("[data-memory-detail]").addEventListener("click", (event) => {
    if (!event.target.closest("[data-memory-delete]")) return;
    confirmPanel.querySelector("[data-memory-confirm-title]").textContent =
      ui`删除 ${view.editing.savedName}？`;
    confirmModal.open();
  });

  onSection("memory", () => void load());

  return { refresh: load };
}
