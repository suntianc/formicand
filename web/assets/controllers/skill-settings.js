import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../ui/html.js";
import { createModal } from "../ui/modal.js";

/**
 * Settings → Skills.
 *
 * Two scopes like the Agent pages: the global list (skills CoworkOS installed,
 * the shared `~/.agents/skills` and the bundled ones) and one project's list,
 * picked from the project selector and read only after the user trusts that
 * project. Every source can be removed from CoworkOS's index; only skills
 * CoworkOS installed can be deleted.
 */
const PAGE_SIZE = 10;
const SOURCE_LABEL = {
  global: "本产品",
  "global-agents": "通用",
  bundled: "自带",
  project: ".atria",
  "project-agents": ".agents"
};
const SCOPE_LABEL = { global: "全局", project: "项目" };
const FILTERS = {
  global: [
    ["all", "全部"],
    ["global", "本产品"],
    ["global-agents", "通用"],
    ["bundled", "自带"]
  ],
  project: [
    ["all", "全部"],
    ["project", ".atria"],
    ["project-agents", ".agents"]
  ]
};

/** A skill's mark: plain instructions read as text; a skill that ships scripts reads as a terminal. */
const skillMark = (skill, size = "") =>
  `<span class="settings-icon-box skill-mark${size}${skill.scripts.length ? " is-script" : ""}">${icon(skill.scripts.length ? "square-terminal" : "file-text")}</span>`;

/** An icon-only action in the skill detail; its name is its label and tooltip. */
const detailAction = (action, glyph, label, danger = false) =>
  `<button class="settings-icon-button detail-action${danger ? " is-danger" : ""}" type="button" data-skill-action="${action}" aria-label="${esc(label)}" title="${esc(label)}">${icon(glyph)}</button>`;

export function createSkillSettings({ panel, api, projects = () => [], onSection, showToast = () => {} }) {
  const view = {
    scope: "global",
    projectId: "",
    filter: "all",
    query: "",
    page: 1,
    showRemoved: false,
    selected: "",
    loading: false,
    error: "",
    data: { skills: [] }
  };
  let requestSeq = 0;

  const target = () =>
    view.scope === "project" ? { scope: "project", projectId: view.projectId } : { scope: "global" };
  const targetQuery = () =>
    view.scope === "project"
      ? `scope=project&projectId=${encodeURIComponent(view.projectId)}`
      : "scope=global";
  const post = (path, json) => api(path, { method: "POST", json });

  panel.innerHTML = ui`<div class="skill-head">
      <h1 class="settings-page-title">技能</h1>
      <div class="settings-segmented" role="radiogroup" aria-label="范围" data-skill-scope>
        <button type="button" role="radio" data-skill-scope-value="global" aria-checked="true">全局</button>
        <button type="button" role="radio" data-skill-scope-value="project" aria-checked="false">项目</button>
      </div>
      <span class="settings-group-spacer"></span>
      <button class="app-button is-primary skill-add" type="button" data-skill-add>${icon("plus")}<span data-skill-add-label>添加技能</span></button>
    </div>
    <div class="skill-body">
      <div class="skill-list-pane">
        <div class="settings-project" data-skill-project hidden>
          <label class="settings-project-picker">
            ${icon("folder")}
            <span class="settings-project-text"><span data-skill-project-name></span><span class="is-mono" data-skill-project-dir></span></span>
            ${icon("chevrons-up-down")}
            <select data-skill-project-select aria-label="项目"></select>
          </label>
          <div class="settings-project-trust" data-skill-trust></div>
        </div>
        <label class="skill-search">${icon("search")}<input type="search" data-skill-search placeholder="搜索技能" aria-label="搜索技能" autocomplete="off" spellcheck="false"></label>
        <div class="skill-filters" role="radiogroup" aria-label="来源" data-skill-filters></div>
        <ul class="skill-list" data-skill-list aria-label="技能列表"></ul>
        <button class="skill-removed-toggle" type="button" data-skill-removed-toggle aria-pressed="false">${icon("eye-off")}<span>已从索引移除</span><span class="skill-count" data-skill-removed-count>0</span>${icon("chevron-right")}</button>
        <div class="skill-pager" data-skill-pager>
          <span data-skill-total></span>
          <span class="settings-group-spacer"></span>
          <button class="settings-icon-button" type="button" data-skill-page="-1" aria-label="上一页">${icon("chevron-left")}</button>
          <span data-skill-page-label></span>
          <button class="settings-icon-button" type="button" data-skill-page="1" aria-label="下一页">${icon("chevron-right")}</button>
        </div>
      </div>
      <div class="skill-detail" data-skill-detail aria-live="polite"></div>
    </div>`;

  const $ = (selector) => panel.querySelector(selector);

  /* ---------------------------------------------------------------- data */

  async function load() {
    const seq = ++requestSeq;
    if (view.scope === "project" && !view.projectId) {
      view.data = { skills: [] };
      view.error = "";
      render();
      return;
    }
    view.loading = true;
    render();
    try {
      const data = await api(`/api/skills?${targetQuery()}`);
      if (seq !== requestSeq) return;
      view.data = data;
      view.error = "";
    } catch (error) {
      if (seq !== requestSeq) return;
      view.data = { skills: [] };
      view.error = error?.message || ui("技能列表读取失败");
    } finally {
      if (seq === requestSeq) {
        view.loading = false;
        render();
      }
    }
  }

  const removedSkills = () => view.data.skills.filter((skill) => skill.removed);
  function visibleSkills() {
    const query = view.query.trim().toLowerCase();
    return view.data.skills.filter(
      (skill) =>
        skill.removed === view.showRemoved &&
        (view.filter === "all" || skill.source === view.filter) &&
        (!query ||
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query))
    );
  }

  /* ---------------------------------------------------------------- render */

  function renderProjectBar() {
    const bar = $("[data-skill-project]");
    bar.hidden = view.scope !== "project";
    if (bar.hidden) return;
    const list = projects();
    const select = $("[data-skill-project-select]");
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
    $("[data-skill-project-name]").textContent = chosen
      ? chosen.projectName || chosen.projectDirectory
      : ui("还没有项目");
    const project = view.data.project;
    const shown = project && project.projectId === view.projectId;
    $("[data-skill-project-dir]").textContent = shown ? project.displayDirectory : "";
    const trust = $("[data-skill-trust]");
    if (!shown) {
      trust.innerHTML = "";
      return;
    }
    trust.innerHTML =
      project.trust === "trusted"
        ? ui`<span class="is-ok">${icon("shield-check")}</span><span>已信任此项目</span><button class="settings-link" type="button" data-skill-trust-set="untrusted">撤销</button>`
        : ui`<span class="is-alert">${icon("triangle-alert")}</span><span>${project.trust === "untrusted" ? ui("未信任") : ui("尚未决定是否信任")}</span><button class="app-button is-secondary" type="button" data-skill-trust-set="trusted">信任此项目</button>`;
  }

  function renderFilters() {
    $("[data-skill-filters]").innerHTML = FILTERS[view.scope]
      .map(
        ([value, label]) =>
          `<button type="button" role="radio" class="skill-filter" data-skill-filter="${value}" aria-checked="${view.filter === value}">${esc(ui(label))}</button>`
      )
      .join("");
  }

  function emptyText() {
    if (view.loading) return ui("正在读取…");
    if (view.error) return view.error;
    if (view.scope === "project") {
      if (!projects().length) return ui("先添加一个项目");
      if (view.data.project && view.data.project.trust !== "trusted")
        return ui("信任这个项目后，才会读取它的 .atria/skills 和 .agents/skills");
    }
    if (view.showRemoved) return ui("没有从索引移除的技能");
    return view.query || view.filter !== "all" ? ui("没有匹配的技能") : ui("还没有技能");
  }

  function renderList() {
    const skills = visibleSkills();
    const pages = Math.max(1, Math.ceil(skills.length / PAGE_SIZE));
    view.page = Math.min(Math.max(1, view.page), pages);
    const shown = skills.slice((view.page - 1) * PAGE_SIZE, view.page * PAGE_SIZE);
    if (!skills.some((skill) => skill.directory === view.selected)) view.selected = shown[0]?.directory ?? "";
    $("[data-skill-list]").innerHTML = shown.length
      ? shown
          .map(
            (
              skill
            ) => `<li><button type="button" class="skill-row" data-skill-select="${esc(skill.directory)}" aria-current="${skill.directory === view.selected}">
              ${skillMark(skill)}
              <span class="skill-row-text"><span class="skill-row-name">${esc(skill.name)}</span><span class="skill-row-desc">${esc(skill.description)}</span></span>
              <span class="skill-tag${skill.shadowedBy ? " is-warn" : ""}">${esc(ui(SOURCE_LABEL[skill.source]))}</span>
            </button></li>`
          )
          .join("")
      : `<li class="skill-empty">${esc(emptyText())}</li>`;
    $("[data-skill-total]").textContent = ui`共 ${skills.length} 个`;
    $("[data-skill-page-label]").textContent = `${view.page} / ${pages}`;
    $('[data-skill-page="-1"]').disabled = view.page <= 1;
    $('[data-skill-page="1"]').disabled = view.page >= pages;
    const toggle = $("[data-skill-removed-toggle]");
    toggle.setAttribute("aria-pressed", String(view.showRemoved));
    toggle.querySelector("span").textContent = view.showRemoved ? ui("返回技能列表") : ui("已从索引移除");
    $("[data-skill-removed-count]").textContent = String(removedSkills().length);
    $("[data-skill-removed-count]").hidden = view.showRemoved;
  }

  function renderDetail() {
    const skill = view.data.skills.find((entry) => entry.directory === view.selected);
    const detail = $("[data-skill-detail]");
    if (!skill) {
      detail.innerHTML = "";
      return;
    }
    const shadow = skill.shadowedBy
      ? view.data.skills.find((entry) => entry.directory === skill.shadowedBy)
      : undefined;
    detail.innerHTML = ui`<div class="skill-detail-head">
        ${skillMark(skill, " is-large")}
        <span class="skill-detail-title"><h2>${esc(skill.name)}</h2><span class="skill-tag">${icon("layers")}${esc(ui(SOURCE_LABEL[skill.source]))} · ${esc(ui(SCOPE_LABEL[view.scope]))}</span></span>
        <span class="settings-group-spacer"></span>
        ${skill.removed ? detailAction("restore", "rotate-ccw", ui("恢复到索引")) : detailAction("remove", "eye-off", ui("从索引移除"))}
        ${skill.deletable ? detailAction("delete", "trash", ui("删除"), true) : ""}
      </div>
      <p class="skill-description">${esc(skill.description)}</p>
      <dl class="skill-facts">
        <dt>文件位置</dt><dd class="is-mono" title="${esc(skill.path)}">${esc(skill.displayPath)}</dd>
        <dt>同名技能</dt><dd>${shadow ? `${ui("已被覆盖，当前不生效：")}${esc(shadow.name)} · ${esc(ui(SOURCE_LABEL[shadow.source]))}` : ui("无")}</dd>
      </dl>
      ${
        skill.scripts.length
          ? ui`<h3 class="skill-section-title">包含的脚本 <span class="skill-count">${skill.scripts.length}</span></h3>
        <ul class="skill-scripts">${skill.scripts.map((name) => `<li class="is-mono">${icon("file-code")}scripts/${esc(name)}</li>`).join("")}</ul>`
          : ""
      }`;
  }

  function render() {
    for (const button of panel.querySelectorAll("[data-skill-scope-value]"))
      button.setAttribute("aria-checked", String(button.dataset.skillScopeValue === view.scope));
    $("[data-skill-add-label]").textContent = view.scope === "project" ? ui("添加到此项目") : ui("添加技能");
    $("[data-skill-add]").disabled = view.scope === "project" && view.data.project?.trust !== "trusted";
    renderProjectBar();
    renderFilters();
    renderList();
    renderDetail();
  }

  /* ---------------------------------------------------------------- confirm */

  const confirmPanel = document.createElement("div");
  confirmPanel.className = "modal-backdrop app-dialog-backdrop";
  confirmPanel.hidden = true;
  confirmPanel.innerHTML = ui`<section class="modal-card app-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-confirm-title">
      <h2 id="skill-confirm-title" data-skill-confirm-title></h2>
      <p class="skill-confirm-copy" data-skill-confirm-copy></p>
      <div class="modal-actions dialog-actions">
        <button class="app-button is-secondary" type="button" data-skill-confirm-cancel>取消</button>
        <button class="app-button" type="button" data-skill-confirm-ok></button>
      </div>
    </section>`;
  document.body.append(confirmPanel);
  const confirmModal = createModal(confirmPanel, confirmPanel.querySelector("[data-skill-confirm-cancel]"));
  let confirmAction;
  confirmPanel.querySelector("[data-skill-confirm-ok]").addEventListener("click", () => {
    const action = confirmAction;
    confirmAction = undefined;
    confirmModal.close();
    void action?.();
  });

  function confirm({ title, copy, okLabel, danger }, action) {
    confirmPanel.querySelector("[data-skill-confirm-title]").textContent = title;
    confirmPanel.querySelector("[data-skill-confirm-copy]").textContent = copy;
    const ok = confirmPanel.querySelector("[data-skill-confirm-ok]");
    ok.textContent = okLabel;
    ok.className = `app-button ${danger ? "is-danger" : "is-primary"}`;
    confirmAction = action;
    confirmModal.open();
    ok.focus();
  }

  async function act(action) {
    const skill = view.data.skills.find((entry) => entry.directory === view.selected);
    if (!skill) return;
    const run = async () => {
      try {
        await post(`/api/skills/${action}`, { target: target(), directory: skill.directory });
        showToast(
          action === "remove" ? ui("已从索引移除") : action === "restore" ? ui("已恢复到索引") : ui("已删除")
        );
        await load();
      } catch (error) {
        showToast(error?.message || ui("操作未完成"));
      }
    };
    if (action === "restore") return run();
    if (action === "remove")
      return confirm(
        {
          title: ui`从索引移除 ${skill.name}？`,
          copy: ui`Main 和所有 Agent 将查不到它，设置里也不再列出。文件 ${skill.directory} 保持不动，其他工具照常使用；可在「已从索引移除」里恢复。`,
          okLabel: ui("从索引移除"),
          danger: false
        },
        run
      );
    confirm(
      {
        title: ui`删除 ${skill.name}？`,
        copy: ui`将删除文件夹 ${skill.directory} 及其中所有文件，无法撤销。`,
        okLabel: ui("删除"),
        danger: true
      },
      run
    );
  }

  /* ---------------------------------------------------------------- add dialog */

  const addPanel = document.createElement("div");
  addPanel.className = "modal-backdrop app-dialog-backdrop";
  addPanel.hidden = true;
  addPanel.innerHTML = ui`<section class="modal-card app-dialog skill-add-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-add-title">
      <div class="mcp-dialog-head">
        <h2 id="skill-add-title" data-skill-add-title>添加技能</h2>
        <button class="settings-icon-button" type="button" data-skill-add-close aria-label="关闭">${icon("close")}</button>
      </div>
      <p class="skill-add-note" data-skill-add-note></p>
      <div class="settings-segmented mcp-kinds" role="radiogroup" aria-label="来源" data-skill-kind>
        <button type="button" role="radio" data-skill-kind-value="git" aria-checked="true">${icon("git-branch")}Git 地址</button>
        <button type="button" role="radio" data-skill-kind-value="folder" aria-checked="false">${icon("folder")}本地文件夹</button>
        <button type="button" role="radio" data-skill-kind-value="archive" aria-checked="false">${icon("archive")}压缩包</button>
      </div>
      <form class="skill-add-source" data-skill-add-form>
        <div class="skill-add-field" data-skill-kind-panel="git">
          <label for="skill-git">仓库地址</label><small>支持子目录，如 …/tree/main/skills</small>
          <div class="skill-add-input"><input id="skill-git" data-skill-git placeholder="https://github.com/owner/skills" autocomplete="off" spellcheck="false"></div>
        </div>
        <div class="skill-add-field" data-skill-kind-panel="folder" hidden>
          <label for="skill-folder">文件夹路径</label><small>可以是一个技能，或装着多个技能的文件夹</small>
          <div class="skill-add-input"><input id="skill-folder" data-skill-folder placeholder="/path/to/skills" autocomplete="off" spellcheck="false"><button class="app-button is-secondary" type="button" data-skill-choose>选择…</button></div>
        </div>
        <div class="skill-add-field" data-skill-kind-panel="archive" hidden>
          <label for="skill-archive">zip 文件</label><small></small>
          <div class="skill-add-input"><input id="skill-archive" data-skill-archive type="file" accept=".zip,application/zip"></div>
        </div>
        <button class="app-button is-secondary" type="submit" data-skill-find>${icon("search")}<span>读取</span></button>
      </form>
      <div class="skill-found" data-skill-found hidden>
        <div class="skill-found-head"><h3 class="skill-section-title" data-skill-found-title></h3><small>勾选要安装的</small></div>
        <ul class="skill-found-list" data-skill-found-list></ul>
        <p class="skill-warning" data-skill-found-warning hidden>${icon("triangle-alert")}<span>所选技能包含脚本，模型加载后可能运行它们。只安装你信任的来源。</span></p>
      </div>
      <p class="dialog-error" data-skill-add-error role="alert" hidden></p>
      <div class="modal-actions dialog-actions">
        <span class="skill-chosen" data-skill-chosen></span>
        <span class="settings-group-spacer"></span>
        <button class="app-button is-secondary" type="button" data-skill-add-cancel>取消</button>
        <button class="app-button is-primary" type="button" data-skill-install disabled>安装</button>
      </div>
    </section>`;
  document.body.append(addPanel);
  const addModal = createModal(addPanel, addPanel.querySelector("[data-skill-add-cancel]"));
  addPanel
    .querySelector("[data-skill-add-close]")
    .addEventListener("click", () => addPanel.querySelector("[data-skill-add-cancel]").click());
  const add = { kind: "folder", preview: undefined, target: undefined, busy: false };
  const addEl = (selector) => addPanel.querySelector(selector);

  function addError(message) {
    const error = addEl("[data-skill-add-error]");
    error.textContent = message;
    error.hidden = !message;
  }

  function renderAdd() {
    for (const button of addPanel.querySelectorAll("[data-skill-kind-value]"))
      button.setAttribute("aria-checked", String(button.dataset.skillKindValue === add.kind));
    for (const section of addPanel.querySelectorAll("[data-skill-kind-panel]"))
      section.hidden = section.dataset.skillKindPanel !== add.kind;
    const found = addEl("[data-skill-found]");
    found.hidden = !add.preview;
    addEl("[data-skill-find]").disabled = add.busy;
    if (!add.preview) {
      addEl("[data-skill-install]").disabled = true;
      addEl("[data-skill-chosen]").textContent = "";
      return;
    }
    addEl("[data-skill-found-title]").textContent = ui`找到 ${add.preview.skills.length} 个技能`;
    const checked = new Set(
      [...addPanel.querySelectorAll("[data-skill-found-name]:checked")].map((box) => box.value)
    );
    addEl("[data-skill-found-list]").innerHTML = add.preview.skills
      .map(
        (skill) => `<li><label class="skill-found-row">
          <input type="checkbox" data-skill-found-name value="${esc(skill.name)}"${!skill.valid ? " disabled" : checked.size === 0 || checked.has(skill.name) ? " checked" : ""}>
          <span class="skill-row-text"><span class="skill-row-name">${esc(skill.name)}</span><span class="skill-row-desc">${esc(skill.description)}</span></span>
          ${skill.scripts.length ? `<span class="skill-tag is-warn">${esc(ui`含 ${skill.scripts.length} 个脚本`)}</span>` : ""}
          ${skill.exists ? `<span class="skill-tag is-warn">${esc(ui("将替换同名"))}</span>` : ""}
          ${!skill.valid ? `<span class="skill-tag">${esc(ui("名称不可用"))}</span>` : ""}
        </label></li>`
      )
      .join("");
    syncInstall();
  }

  function chosen() {
    return [...addPanel.querySelectorAll("[data-skill-found-name]:checked")].map((box) => box.value);
  }

  function syncInstall() {
    const names = chosen();
    const skills = add.preview?.skills.filter((skill) => names.includes(skill.name)) ?? [];
    addEl("[data-skill-found-warning]").hidden = !skills.some((skill) => skill.scripts.length);
    const replace = skills.some((skill) => skill.exists);
    const install = addEl("[data-skill-install]");
    install.disabled = add.busy || !skills.length;
    install.textContent = replace ? ui("替换并安装") : ui("安装");
    addEl("[data-skill-chosen]").textContent = ui`已选 ${skills.length} 个`;
  }

  function openAdd() {
    add.kind = "git";
    add.preview = undefined;
    add.target = target();
    add.busy = false;
    addEl("[data-skill-add-title]").textContent =
      view.scope === "project" ? ui("添加技能到此项目") : ui("添加技能");
    addEl("[data-skill-add-note]").textContent =
      view.scope === "project"
        ? ui("安装到此项目的 .atria/skills/，跟着项目走。")
        : ui("安装到 ~/.atria/skills/，只给本产品用；不会写入通用目录 ~/.agents/skills/。");
    for (const input of addPanel.querySelectorAll("input")) input.value = "";
    addError("");
    renderAdd();
    addModal.open();
    addEl("[data-skill-git]").focus();
  }

  async function findSkills() {
    addError("");
    add.preview = undefined;
    add.busy = true;
    renderAdd();
    try {
      if (add.kind === "archive") {
        const file = addEl("[data-skill-archive]").files?.[0];
        if (!file) throw new Error(ui("请选择一个 zip 文件"));
        const query =
          add.target.scope === "project"
            ? `scope=project&projectId=${encodeURIComponent(add.target.projectId)}`
            : "scope=global";
        add.preview = await api(`/api/skills/preview-archive?${query}`, {
          method: "POST",
          headers: { "content-type": "application/zip" },
          body: file
        });
      } else {
        const location = addEl(
          add.kind === "folder" ? "[data-skill-folder]" : "[data-skill-git]"
        ).value.trim();
        if (!location) throw new Error(add.kind === "folder" ? ui("请填写文件夹路径") : ui("请填写仓库地址"));
        add.preview = await post("/api/skills/preview", { target: add.target, kind: add.kind, location });
      }
    } catch (error) {
      addError(error?.message || ui("没有找到技能"));
    } finally {
      add.busy = false;
      renderAdd();
    }
  }

  async function install() {
    const names = chosen();
    if (!add.preview || !names.length) return;
    const replace = add.preview.skills.some((skill) => skill.exists && names.includes(skill.name));
    add.busy = true;
    syncInstall();
    try {
      const result = await post("/api/skills/install", {
        target: add.target,
        stagingId: add.preview.stagingId,
        names,
        replace
      });
      addModal.close();
      showToast(ui`已安装 ${result.installed.length} 个技能`);
      await load();
    } catch (error) {
      addError(error?.message || ui("安装未完成"));
    } finally {
      add.busy = false;
      syncInstall();
    }
  }

  addEl("[data-skill-kind]").addEventListener("click", (event) => {
    const button = event.target.closest("[data-skill-kind-value]");
    if (!button) return;
    add.kind = button.dataset.skillKindValue;
    add.preview = undefined;
    addError("");
    renderAdd();
  });
  addEl("[data-skill-add-form]").addEventListener("submit", (event) => {
    event.preventDefault();
    void findSkills();
  });
  addEl("[data-skill-choose]").addEventListener("click", async () => {
    try {
      const result = await api("/api/projects/choose-directory", { method: "POST" });
      if (!result.cancelled && result.projectDirectory)
        addEl("[data-skill-folder]").value = result.projectDirectory;
    } catch (error) {
      addError(error?.message || ui("无法打开文件夹选择"));
    }
  });
  addEl("[data-skill-found-list]").addEventListener("change", syncInstall);
  addEl("[data-skill-install]").addEventListener("click", () => void install());

  /* ---------------------------------------------------------------- wiring */

  $("[data-skill-scope]").addEventListener("click", (event) => {
    const button = event.target.closest("[data-skill-scope-value]");
    if (!button || button.dataset.skillScopeValue === view.scope) return;
    view.scope = button.dataset.skillScopeValue;
    view.filter = "all";
    view.page = 1;
    view.showRemoved = false;
    view.selected = "";
    view.data = { skills: [] };
    if (view.scope === "project" && !projects().some((project) => project.projectId === view.projectId))
      view.projectId = projects()[0]?.projectId ?? "";
    void load();
  });
  $("[data-skill-project-select]").addEventListener("change", (event) => {
    view.projectId = event.target.value;
    view.page = 1;
    view.selected = "";
    view.data = { skills: [] };
    void load();
  });
  $("[data-skill-trust]").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-skill-trust-set]");
    if (!button) return;
    try {
      await post("/api/skills/trust", { projectId: view.projectId, trust: button.dataset.skillTrustSet });
      await load();
    } catch (error) {
      showToast(error?.message || ui("操作未完成"));
    }
  });
  $("[data-skill-filters]").addEventListener("click", (event) => {
    const button = event.target.closest("[data-skill-filter]");
    if (!button) return;
    view.filter = button.dataset.skillFilter;
    view.page = 1;
    render();
  });
  $("[data-skill-search]").addEventListener("input", (event) => {
    view.query = event.target.value;
    view.page = 1;
    render();
  });
  $("[data-skill-list]").addEventListener("click", (event) => {
    const row = event.target.closest("[data-skill-select]");
    if (!row) return;
    view.selected = row.dataset.skillSelect;
    render();
  });
  $("[data-skill-removed-toggle]").addEventListener("click", () => {
    view.showRemoved = !view.showRemoved;
    view.page = 1;
    view.selected = "";
    render();
  });
  $("[data-skill-pager]").addEventListener("click", (event) => {
    const button = event.target.closest("[data-skill-page]");
    if (!button) return;
    view.page += Number(button.dataset.skillPage);
    render();
  });
  $("[data-skill-detail]").addEventListener("click", (event) => {
    const button = event.target.closest("[data-skill-action]");
    if (button) void act(button.dataset.skillAction);
  });
  $("[data-skill-add]").addEventListener("click", openAdd);

  onSection("skills", () => void load());

  return { refresh: load };
}
