import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../ui/html.js";
import { createModal } from "../ui/modal.js";

/**
 * Settings → Agent.
 *
 * Two scopes like Skills: the global list (the built-in Executor and Reviewer,
 * read-only, and `~/.atria/agents`) and one project's list (`.atria/agents`,
 * read only after the user trusts that project, then the global Agents that
 * project can also use). The detail pane is the editor: what Main reads to
 * choose the Agent, its permission, model, tools, skills, MCP servers and
 * extra prompt. A running work item keeps the definition it was dispatched
 * with, so an edit only affects later ones.
 */
const PAGE_SIZE = 10;
const NEW = "\0new";
const PERMISSION_LABEL = { write: "可写", read: "只读" };

export function createAgentSettings({ panel, api, projects = () => [], onSection, showToast = () => {} }) {
  const view = {
    scope: "global",
    projectId: "",
    query: "",
    page: 1,
    selected: "",
    loading: false,
    error: "",
    data: { agents: [] },
    options: undefined,
    models: [],
    /** The definition being edited: a copy of the selected one, or a new draft. */
    draft: undefined,
    saving: false
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
      <h1 class="settings-page-title">Agent</h1>
      <div class="settings-segmented" role="radiogroup" aria-label="范围" data-agent-scope>
        <button type="button" role="radio" data-agent-scope-value="global" aria-checked="true">全局</button>
        <button type="button" role="radio" data-agent-scope-value="project" aria-checked="false">项目</button>
      </div>
      <span class="settings-info" title="Main 按「使用说明」决定派给谁；同名时项目覆盖全局">${icon("info")}</span>
      <span class="settings-group-spacer"></span>
      <button class="app-button is-primary skill-add" type="button" data-agent-new>${icon("plus")}<span>新建 Agent</span></button>
    </div>
    <div class="skill-project-bar" data-agent-project hidden>
      <label class="sr-only" for="agent-project-select">项目</label>
      <select class="settings-select" id="agent-project-select" data-agent-project-select></select>
      <span class="skill-trust" data-agent-trust></span>
    </div>
    <div class="skill-body">
      <div class="skill-list-pane">
        <label class="skill-search">${icon("search")}<input type="search" data-agent-search placeholder="搜索 Agent" aria-label="搜索 Agent" autocomplete="off" spellcheck="false"></label>
        <ul class="skill-list" data-agent-list aria-label="Agent 列表"></ul>
        <div class="skill-pager" data-agent-pager>
          <span data-agent-total></span>
          <span class="settings-group-spacer"></span>
          <button class="settings-icon-button" type="button" data-agent-page="-1" aria-label="上一页">${icon("chevron-left")}</button>
          <span data-agent-page-label></span>
          <button class="settings-icon-button" type="button" data-agent-page="1" aria-label="下一页">${icon("chevron-right")}</button>
        </div>
      </div>
      <div class="skill-detail agent-detail" data-agent-detail aria-live="polite"></div>
    </div>`;

  const $ = (selector) => panel.querySelector(selector);

  /* ---------------------------------------------------------------- data */

  async function load() {
    const seq = ++requestSeq;
    if (view.scope === "project" && !view.projectId) {
      view.data = { agents: [] };
      view.error = "";
      render();
      return;
    }
    view.loading = true;
    render();
    try {
      const [data, options, models] = await Promise.all([
        api(`/api/agents?${targetQuery()}`),
        api(`/api/agents/options?${targetQuery()}`),
        // eslint-disable-next-line no-restricted-syntax -- 模型列表读不到时只少了可选模型，编辑页仍可用「沿用」
        api("/api/models").catch(() => ({ providers: [] }))
      ]);
      if (seq !== requestSeq) return;
      view.data = data;
      view.options = options;
      view.models = (models.providers || []).flatMap((provider) =>
        provider.models.map((model) => ({
          profile: model.profileId,
          model: model.id,
          label: `${provider.name} · ${model.id}`
        }))
      );
      view.error = "";
      if (view.selected !== NEW) view.draft = undefined;
    } catch (error) {
      if (seq !== requestSeq) return;
      view.data = { agents: [] };
      view.error = error?.message || ui("Agent 列表读取失败");
    } finally {
      if (seq === requestSeq) {
        view.loading = false;
        render();
      }
    }
  }

  const keyOf = (agent) => `${agent.source}:${agent.name}`;
  const selectedAgent = () => view.data.agents.find((agent) => keyOf(agent) === view.selected);

  /** The rows in display order, each with the group it is shown under. */
  function rows() {
    const query = view.query.trim().toLowerCase();
    const groups =
      view.scope === "global"
        ? [
            ["builtin", ui("内置"), ui("只读")],
            ["global", ui("全局"), "~/.atria/agents"]
          ]
        : [
            ["project", ui`项目 · ${view.data.project?.projectName ?? ""}`, ".atria/agents"],
            ["global", ui("此项目也能用的全局 Agent"), ""]
          ];
    return groups.flatMap(([source, title, note]) =>
      view.data.agents
        .filter(
          (agent) =>
            agent.source === source &&
            (!query ||
              agent.name.toLowerCase().includes(query) ||
              (agent.definition?.description ?? "").toLowerCase().includes(query))
        )
        .map((agent) => ({ agent, group: { source, title, note } }))
    );
  }

  /** The short line under a name: permission, then what it adds or what is wrong. */
  function summary(agent) {
    if (agent.error) return ui("定义有误");
    if (agent.shadowedBy) return ui("被项目版本覆盖");
    const definition = agent.definition;
    if (definition.enabled === false) return ui("已停用");
    if (agent.source === "builtin")
      return agent.name === "reviewer" ? ui("只读 · 独立审查") : ui("可写 · 实现与验证");
    const parts = [ui(PERMISSION_LABEL[definition.permission])];
    if (definition.skills) parts.push(ui`${definition.skills.length} 技能`);
    else parts.push(ui("全部技能"));
    if (definition.mcp?.length) parts.push(`${definition.mcp.length} MCP`);
    return parts.join(" · ");
  }

  /* ---------------------------------------------------------------- render */

  function renderProjectBar() {
    const bar = $("[data-agent-project]");
    bar.hidden = view.scope !== "project";
    if (bar.hidden) return;
    const list = projects();
    const select = $("[data-agent-project-select]");
    select.innerHTML = list.length
      ? list
          .map(
            (project) =>
              `<option value="${esc(project.projectId)}"${project.projectId === view.projectId ? " selected" : ""}>${esc(project.projectName || project.projectDirectory)}</option>`
          )
          .join("")
      : `<option value="">${ui("还没有项目")}</option>`;
    select.disabled = !list.length;
    const project = view.data.project;
    const trust = $("[data-agent-trust]");
    if (!project || project.projectId !== view.projectId) {
      trust.innerHTML = "";
      return;
    }
    trust.innerHTML =
      project.trust === "trusted"
        ? ui`<span class="settings-dot is-ok" aria-hidden="true"></span><span>已信任此项目</span><button class="settings-link" type="button" data-agent-trust-set="untrusted">撤销</button>`
        : ui`<span class="settings-dot is-alert" aria-hidden="true"></span><span>${project.trust === "untrusted" ? ui("未信任") : ui("尚未决定是否信任")}</span><button class="app-button is-secondary" type="button" data-agent-trust-set="trusted">信任此项目</button>`;
  }

  function emptyText() {
    if (view.loading) return ui("正在读取…");
    if (view.error) return view.error;
    if (view.scope === "project") {
      if (!projects().length) return ui("先添加一个项目");
      if (view.data.project && view.data.project.trust !== "trusted")
        return ui("信任这个项目后，才会读取它的 .atria/agents");
    }
    return view.query ? ui("没有匹配的 Agent") : ui("还没有 Agent");
  }

  function renderList() {
    const all = rows();
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    view.page = Math.min(Math.max(1, view.page), pages);
    const shown = all.slice((view.page - 1) * PAGE_SIZE, view.page * PAGE_SIZE);
    if (!view.loading && view.selected !== NEW && !all.some((row) => keyOf(row.agent) === view.selected))
      view.selected = shown[0] ? keyOf(shown[0].agent) : "";
    let group;
    $("[data-agent-list]").innerHTML = shown.length
      ? shown
          .map(({ agent, group: next }) => {
            const header =
              next.source !== group
                ? `<li class="agent-group" role="presentation"><span>${esc(next.title)}</span>${next.note ? `<span class="is-mono">${esc(next.note)}</span>` : ""}</li>`
                : "";
            group = next.source;
            const off = agent.error || agent.shadowedBy || agent.definition?.enabled === false;
            const tag =
              agent.problems.length || agent.error
                ? `<span class="skill-tag is-warn">${esc(ui("引用失效"))}</span>`
                : agent.source === "builtin"
                  ? `<span class="skill-tag">${esc(ui("内置"))}</span>`
                  : view.scope === "project" &&
                      agent.source === "project" &&
                      view.data.agents.some(
                        (other) => other.source === "global" && other.shadowedBy && other.name === agent.name
                      )
                    ? `<span class="skill-tag is-warn">${esc(ui("覆盖全局"))}</span>`
                    : view.scope === "project" && agent.source === "global"
                      ? `<span class="skill-tag">${esc(ui("全局"))}</span>`
                      : "";
            return `${header}<li><button type="button" class="skill-row${off ? " is-muted" : ""}" data-agent-select="${esc(keyOf(agent))}" aria-current="${keyOf(agent) === view.selected}">
              <span class="settings-icon-box">${icon(agent.definition?.permission === "read" ? "eye-off" : "team")}</span>
              <span class="skill-row-text"><span class="skill-row-name">${esc(agent.name)}</span><span class="skill-row-desc">${esc(summary(agent))}</span></span>
              ${tag}
            </button></li>`;
          })
          .join("")
      : `<li class="skill-empty">${esc(emptyText())}</li>`;
    $("[data-agent-total]").textContent = ui`共 ${all.length} 个`;
    $("[data-agent-page-label]").textContent = `${view.page} / ${pages}`;
    $('[data-agent-page="-1"]').disabled = view.page <= 1;
    $('[data-agent-page="1"]').disabled = view.page >= pages;
  }

  /** Whether the selected entry can be edited here: built-ins never, a global one only on the global page. */
  function editable(agent) {
    if (!agent) return view.selected === NEW;
    if (agent.source === "builtin" || !agent.definition) return false;
    return agent.source === view.scope;
  }

  function startDraft(agent) {
    const definition = agent?.definition;
    view.draft = definition
      ? {
          ...definition,
          tools: definition.tools ? [...definition.tools] : undefined,
          skills: definition.skills ? [...definition.skills] : undefined,
          mcp: definition.mcp ? [...definition.mcp] : []
        }
      : { name: "", description: "", permission: "write", prompt: "", mcp: [] };
  }

  const DEFAULT_TOOLS = {
    write: ["read", "bash", "edit", "write", "browse_workspace", "search", "visit"],
    read: ["read", "bash", "grep", "find", "ls", "browse_workspace", "search", "visit"]
  };

  function chips(list, kind, disabled) {
    return list
      .map(
        (name) =>
          `<span class="settings-chip agent-chip">${esc(name)}${disabled ? "" : `<button type="button" data-agent-remove-${kind}="${esc(name)}" aria-label="${esc(ui`移除 ${name}`)}">${icon("close")}</button>`}</span>`
      )
      .join("");
  }

  function renderEditor(agent) {
    const draft = view.draft;
    const locked = !editable(agent);
    const options = view.options ?? { tools: { write: [], read: [] }, skills: [], mcp: [] };
    const allTools = options.tools.write;
    const allowed = new Set(options.tools[draft.permission]);
    const tools = draft.tools ?? DEFAULT_TOOLS[draft.permission];
    const modelValue = draft.model
      ? JSON.stringify({ profile: draft.profile ?? null, model: draft.model })
      : "";
    const knownModel = view.models.some(
      (entry) => entry.model === draft.model && (entry.profile ?? null) === (draft.profile ?? null)
    );
    const skillChoices = options.skills.filter((name) => !(draft.skills ?? []).includes(name));
    const mcpChoices = options.mcp.filter((server) => !(draft.mcp ?? []).includes(server.name));
    const disabled = locked ? " disabled" : "";
    return ui`<form class="agent-form" data-agent-form>
      <div class="agent-form-columns">
        <div class="agent-form-column">
          <div class="mcp-field">
            <label for="agent-name">名称</label><small>字母、数字和连字符</small>
            <input id="agent-name" data-agent-field="name" value="${esc(draft.name)}" autocomplete="off" spellcheck="false"${disabled}>
          </div>
          <div class="mcp-field">
            <label for="agent-description">给 Main 的使用说明</label><small>Main 据此决定何时派给它</small>
            <textarea id="agent-description" data-agent-field="description" rows="3"${disabled}>${esc(draft.description)}</textarea>
          </div>
          <div class="mcp-field">
            <span class="mcp-field-label">权限</span><span></span>
            <div class="agent-permissions" role="radiogroup" aria-label="权限">
              ${["write", "read"]
                .map(
                  (permission) =>
                    `<label class="agent-permission"><input type="radio" name="agent-permission" value="${permission}" data-agent-permission${draft.permission === permission ? " checked" : ""}${disabled}><span><strong>${esc(ui(PERMISSION_LABEL[permission]))}</strong><small>${esc(permission === "write" ? ui("在隔离现场修改代码") : ui("独立副本里检查，结论文字交回"))}</small></span></label>`
                )
                .join("")}
            </div>
          </div>
          <div class="mcp-field">
            <label for="agent-model">模型</label><small>不选则沿用角色的模型</small>
            <select class="settings-select" id="agent-model" data-agent-model${disabled}>
              <option value="">${esc(ui("沿用角色的模型"))}</option>
              ${!knownModel && draft.model ? `<option value="${esc(modelValue)}" selected>${esc(draft.model)}</option>` : ""}
              ${view.models
                .map((entry) => {
                  const value = JSON.stringify({ profile: entry.profile ?? null, model: entry.model });
                  return `<option value="${esc(value)}"${value === modelValue ? " selected" : ""}>${esc(entry.label)}</option>`;
                })
                .join("")}
            </select>
          </div>
        </div>
        <div class="agent-form-column">
          <div class="mcp-field">
            <span class="mcp-field-label">工具</span><small>只读时不能选写入类工具</small>
            <div class="agent-tools">
              ${allTools
                .map((tool) => {
                  const off = !allowed.has(tool);
                  return `<label class="agent-tool${off ? " is-off" : ""}"><input type="checkbox" value="${esc(tool)}" data-agent-tool${tools.includes(tool) && !off ? " checked" : ""}${off || locked ? " disabled" : ""}><span class="is-mono">${esc(tool)}</span></label>`;
                })
                .join("")}
            </div>
            <p class="agent-hint">ask_main、send_peer_message 始终可用；Main 专用工具不可选</p>
          </div>
          <div class="mcp-field">
            <span class="mcp-field-label">技能</span><span></span>
            <div class="settings-segmented" role="radiogroup" aria-label="技能" data-agent-skill-mode>
              <button type="button" role="radio" data-agent-skill-mode-value="all" aria-checked="${!draft.skills}"${disabled}>全部可见</button>
              <button type="button" role="radio" data-agent-skill-mode-value="some" aria-checked="${Boolean(draft.skills)}"${disabled}>只用指定的</button>
            </div>
            ${
              draft.skills
                ? `<div class="agent-chips">${chips(draft.skills, "skill", locked)}${locked || !skillChoices.length ? "" : `<select class="settings-select agent-add" data-agent-add-skill aria-label="${esc(ui("添加技能"))}"><option value="">${esc(ui("添加"))}</option>${skillChoices.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("")}</select>`}</div>`
                : `<p class="agent-hint">${esc(ui`可见全部 ${options.skills.length} 个技能（已移除的除外）`)}</p>`
            }
          </div>
          <div class="mcp-field">
            <span class="mcp-field-label">MCP 服务</span><small>不选则不给任何服务</small>
            <div class="agent-chips">${chips(draft.mcp ?? [], "mcp", locked)}${locked || !mcpChoices.length ? "" : `<select class="settings-select agent-add" data-agent-add-mcp aria-label="${esc(ui("添加 MCP 服务"))}"><option value="">${esc(ui("添加"))}</option>${mcpChoices.map((server) => `<option value="${esc(server.name)}">${esc(server.name)}${server.enabled ? "" : esc(ui("（已停用）"))}</option>`).join("")}</select>`}</div>
          </div>
        </div>
      </div>
      <div class="mcp-field">
        <label for="agent-prompt">附加提示词</label><small>接在角色基础提示词之后，不替换安全规则</small>
        <textarea id="agent-prompt" class="agent-prompt" data-agent-field="prompt" rows="6"${disabled}>${esc(draft.prompt)}</textarea>
      </div>
      ${
        locked
          ? ""
          : ui`<div class="agent-form-foot">
        <span class="agent-hint">${icon("info")}运行中的工作项保持派单时的定义，修改只影响之后的派单</span>
        <span class="settings-group-spacer"></span>
        <button class="app-button is-secondary" type="button" data-agent-cancel>取消</button>
        <button class="app-button is-primary" type="submit" data-agent-save${view.saving ? " disabled" : ""}>保存</button>
      </div>`
      }
    </form>`;
  }

  function renderDetail() {
    const detail = $("[data-agent-detail]");
    const agent = view.selected === NEW ? undefined : selectedAgent();
    if (!agent && view.selected !== NEW) {
      detail.innerHTML = "";
      return;
    }
    if (!view.draft && agent?.definition) startDraft(agent);
    const source = agent?.source ?? view.scope;
    const sourceLabel =
      source === "builtin"
        ? ui("内置")
        : source === "project"
          ? ui`项目 · ${view.data.project?.projectName ?? ""}`
          : ui("全局");
    const canToggle = agent && editable(agent);
    const head = ui`<div class="skill-detail-head">
        <span class="settings-icon-box is-large">${icon(view.draft?.permission === "read" ? "eye-off" : "team")}</span>
        <span class="skill-detail-title"><h2>${esc(agent?.name ?? ui("新建 Agent"))}</h2><span class="skill-tag">${esc(sourceLabel)}</span>${agent?.path ? `<span class="agent-path is-mono">${esc(agent.path)}</span>` : ""}</span>
        <span class="settings-group-spacer"></span>
        ${canToggle ? `<span class="mcp-enabled"><span>${ui("启用")}</span><button type="button" class="ui-switch" role="switch" data-agent-enabled aria-checked="${agent.definition.enabled !== false}" aria-label="${esc(ui("启用"))}"></button></span>` : ""}
        ${agent?.definition ? `<button class="app-button is-secondary" type="button" data-agent-copy>${icon("copy")}<span>${ui("复制")}</span></button>` : ""}
        ${agent && agent.source === view.scope && agent.source !== "builtin" ? `<button class="app-button is-danger" type="button" data-agent-delete>${icon("trash")}<span>${ui("删除")}</span></button>` : ""}
      </div>`;
    const notes = [
      agent?.error
        ? `<p class="skill-warning">${icon("triangle-alert")}<span>${esc(ui`定义有误：${agent.error}`)}</span></p>`
        : "",
      agent?.problems.length
        ? `<p class="skill-warning">${icon("triangle-alert")}<span>${esc(ui`引用失效：${agent.problems.join("；")}`)}</span></p>`
        : "",
      agent?.shadowedBy
        ? `<p class="skill-warning">${icon("info")}<span>${esc(ui`此项目用的是项目里的同名 Agent：${agent.shadowedBy}`)}</span></p>`
        : "",
      agent && agent.source === "global" && view.scope === "project"
        ? `<p class="agent-hint">${esc(ui("全局 Agent 在「全局」页编辑"))}</p>`
        : ""
    ].join("");
    detail.innerHTML = head + notes + (view.draft ? renderEditor(agent) : "");
  }

  function render() {
    for (const button of panel.querySelectorAll("[data-agent-scope-value]"))
      button.setAttribute("aria-checked", String(button.dataset.agentScopeValue === view.scope));
    $("[data-agent-new]").disabled = view.scope === "project" && view.data.project?.trust !== "trusted";
    renderProjectBar();
    renderList();
    renderDetail();
  }

  /* ---------------------------------------------------------------- editing */

  /** Read the form back into the draft, so a re-render keeps what was typed. */
  function readForm() {
    const form = $("[data-agent-form]");
    if (!form || !view.draft) return;
    for (const field of form.querySelectorAll("[data-agent-field]"))
      view.draft[field.dataset.agentField] = field.value;
    const permission = form.querySelector("[data-agent-permission]:checked");
    if (permission) view.draft.permission = permission.value;
    const tools = [...form.querySelectorAll("[data-agent-tool]:checked")].map((box) => box.value);
    view.draft.tools = tools;
    const model = form.querySelector("[data-agent-model]").value;
    if (model) {
      const chosen = JSON.parse(model);
      view.draft.model = chosen.model;
      if (chosen.profile) view.draft.profile = chosen.profile;
      else delete view.draft.profile;
    } else {
      delete view.draft.model;
      delete view.draft.profile;
    }
  }

  async function save() {
    readForm();
    const agent = view.selected === NEW ? undefined : selectedAgent();
    const draft = view.draft;
    const allowed = new Set(view.options?.tools[draft.permission] ?? []);
    const definition = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      permission: draft.permission,
      ...(draft.profile ? { profile: draft.profile } : {}),
      ...(draft.model ? { model: draft.model } : {}),
      tools: (draft.tools ?? []).filter((tool) => allowed.has(tool)),
      ...(draft.skills ? { skills: draft.skills } : {}),
      ...(draft.mcp?.length ? { mcp: draft.mcp } : {}),
      ...(draft.enabled === false ? { enabled: false } : {}),
      prompt: draft.prompt
    };
    view.saving = true;
    render();
    try {
      await post("/api/agents/save", {
        target: target(),
        definition,
        ...(agent ? { previousName: agent.name } : {})
      });
      showToast(ui("已保存"));
      view.selected = `${view.scope}:${definition.name}`;
      view.draft = undefined;
      await load();
    } catch (error) {
      showToast(error?.message || ui("保存未完成"));
    } finally {
      view.saving = false;
      render();
    }
  }

  /* ---------------------------------------------------------------- confirm */

  const confirmPanel = document.createElement("div");
  confirmPanel.className = "modal-backdrop app-dialog-backdrop";
  confirmPanel.hidden = true;
  confirmPanel.innerHTML = ui`<section class="modal-card app-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-confirm-title">
      <h2 id="agent-confirm-title" data-agent-confirm-title></h2>
      <p class="skill-confirm-copy" data-agent-confirm-copy></p>
      <div class="modal-actions dialog-actions">
        <button class="app-button is-secondary" type="button" data-agent-confirm-cancel>取消</button>
        <button class="app-button is-danger" type="button" data-agent-confirm-ok>删除</button>
      </div>
    </section>`;
  document.body.append(confirmPanel);
  const confirmModal = createModal(confirmPanel, confirmPanel.querySelector("[data-agent-confirm-cancel]"));
  confirmPanel.querySelector("[data-agent-confirm-ok]").addEventListener("click", async () => {
    confirmModal.close();
    const agent = selectedAgent();
    if (!agent) return;
    try {
      await post("/api/agents/delete", { target: target(), name: agent.name });
      showToast(ui("已删除"));
      view.selected = "";
      view.draft = undefined;
      await load();
    } catch (error) {
      showToast(error?.message || ui("操作未完成"));
    }
  });

  /* ---------------------------------------------------------------- wiring */

  $("[data-agent-scope]").addEventListener("click", (event) => {
    const button = event.target.closest("[data-agent-scope-value]");
    if (!button || button.dataset.agentScopeValue === view.scope) return;
    view.scope = button.dataset.agentScopeValue;
    view.page = 1;
    view.selected = "";
    view.draft = undefined;
    view.data = { agents: [] };
    if (view.scope === "project" && !projects().some((project) => project.projectId === view.projectId))
      view.projectId = projects()[0]?.projectId ?? "";
    void load();
  });
  $("[data-agent-project-select]").addEventListener("change", (event) => {
    view.projectId = event.target.value;
    view.page = 1;
    view.selected = "";
    view.draft = undefined;
    view.data = { agents: [] };
    void load();
  });
  $("[data-agent-trust]").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-agent-trust-set]");
    if (!button) return;
    try {
      await post("/api/agents/trust", { projectId: view.projectId, trust: button.dataset.agentTrustSet });
      await load();
    } catch (error) {
      showToast(error?.message || ui("操作未完成"));
    }
  });
  $("[data-agent-search]").addEventListener("input", (event) => {
    view.query = event.target.value;
    view.page = 1;
    render();
  });
  $("[data-agent-list]").addEventListener("click", (event) => {
    const row = event.target.closest("[data-agent-select]");
    if (!row) return;
    view.selected = row.dataset.agentSelect;
    view.draft = undefined;
    render();
  });
  $("[data-agent-pager]").addEventListener("click", (event) => {
    const button = event.target.closest("[data-agent-page]");
    if (!button) return;
    view.page += Number(button.dataset.agentPage);
    render();
  });
  $("[data-agent-new]").addEventListener("click", () => {
    view.selected = NEW;
    startDraft();
    render();
    $("#agent-name")?.focus();
  });

  const detail = $("[data-agent-detail]");
  detail.addEventListener("click", async (event) => {
    const agent = selectedAgent();
    if (event.target.closest("[data-agent-copy]") && agent?.definition) {
      startDraft(agent);
      view.draft.name = `${agent.name}-copy`;
      delete view.draft.enabled;
      if (agent.source === "builtin") view.draft.tools = undefined;
      view.selected = NEW;
      render();
      $("#agent-name")?.focus();
      return;
    }
    if (event.target.closest("[data-agent-delete]") && agent) {
      confirmPanel.querySelector("[data-agent-confirm-title]").textContent = ui`删除 ${agent.name}？`;
      confirmPanel.querySelector("[data-agent-confirm-copy]").textContent =
        ui`将删除文件 ${agent.path}，无法撤销。正在运行的工作项不受影响，之后再派给它会报错。`;
      confirmModal.open();
      return;
    }
    if (event.target.closest("[data-agent-enabled]") && agent) {
      try {
        await post("/api/agents/enabled", {
          target: target(),
          name: agent.name,
          enabled: agent.definition.enabled === false
        });
        view.draft = undefined;
        await load();
      } catch (error) {
        showToast(error?.message || ui("操作未完成"));
      }
      return;
    }
    if (event.target.closest("[data-agent-cancel]")) {
      if (view.selected === NEW) view.selected = "";
      view.draft = undefined;
      render();
      return;
    }
    const mode = event.target.closest("[data-agent-skill-mode-value]");
    if (mode && view.draft) {
      readForm();
      view.draft.skills = mode.dataset.agentSkillModeValue === "some" ? (view.draft.skills ?? []) : undefined;
      render();
      return;
    }
    for (const kind of ["skill", "mcp"]) {
      const remove = event.target.closest(`[data-agent-remove-${kind}]`);
      if (remove && view.draft) {
        readForm();
        const key = kind === "skill" ? "skills" : "mcp";
        view.draft[key] = view.draft[key].filter(
          (name) => name !== remove.getAttribute(`data-agent-remove-${kind}`)
        );
        render();
        return;
      }
    }
  });
  detail.addEventListener("change", (event) => {
    if (!view.draft) return;
    const add = event.target.closest("[data-agent-add-skill], [data-agent-add-mcp]");
    if (add && add.value) {
      readForm();
      const key = add.matches("[data-agent-add-skill]") ? "skills" : "mcp";
      view.draft[key] = [...(view.draft[key] ?? []), add.value];
      render();
      return;
    }
    if (event.target.matches("[data-agent-permission]")) {
      readForm();
      const allowed = new Set(view.options?.tools[view.draft.permission] ?? []);
      view.draft.tools = (view.draft.tools ?? []).filter((tool) => allowed.has(tool));
      render();
    }
  });
  detail.addEventListener("submit", (event) => {
    event.preventDefault();
    void save();
  });

  onSection("agents", () => void load());

  return { refresh: load };
}
