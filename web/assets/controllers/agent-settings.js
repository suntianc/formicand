import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../ui/html.js";
import { createModal } from "../ui/modal.js";
import { LEVEL_LABELS } from "./model-picker.js";
import { providerLogo } from "./model-providers.js";

/**
 * Settings → Agent.
 *
 * Two scopes like Skills: the global list (the built-in Main, Executor and
 * Reviewer, then `~/.atria/agents`) and one project's list (the built-ins
 * again, `.atria/agents` once the user trusts that project, then the global
 * Agents that project can also use). The detail pane is the editor: what Main
 * reads to choose the Agent, its permission, model and effort, tools, skills,
 * MCP servers and extra prompt. A built-in keeps its name, description,
 * permission and tools; the rest is saved with the host's role settings, and
 * a project can override each field. A running work item keeps what it was
 * dispatched with, so an edit only affects later ones.
 */
const PAGE_SIZE = 10;
const NEW = "\0new";
const PERMISSION_LABEL = { write: "可写", read: "只读" };
const agentIcon = (definition) =>
  definition?.name === "main" ? "bot" : definition?.permission === "read" ? "scan-eye" : "wrench";
const LEVELS = ["off", "low", "medium", "high", "xhigh", "max"];
/** What each built-in setting is called in "本项目单独设置了…". */
const FIELD_LABEL = {
  profileId: "模型",
  thinkingLevel: "推理强度",
  skills: "技能",
  mcp: "MCP",
  prompt: "附加提示词"
};
const SCOPE_NOTE = {
  global: "Main 按「使用说明」决定派给谁；同名时项目覆盖全局",
  project: "项目 Agent 存在 .atria/agents/，跟着项目走；同名时覆盖全局"
};

export function createAgentSettings({
  panel,
  api,
  projects = () => [],
  onSection,
  showToast = () => {},
  onBuiltinSaved = () => {},
  askMain
}) {
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
    /** A definition handed over from a proposal in the conversation, opened once the list loads. */
    pending: undefined,
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
      <span class="settings-group-spacer"></span>
      <span class="settings-head-note">${icon("info")}<span data-agent-note></span></span>
      ${askMain ? `<button class="app-button is-secondary" type="button" data-agent-ask>${icon("sparkles")}<span>${ui("让 Main 帮我写")}</span></button>` : ""}
      <button class="app-button is-primary skill-add" type="button" data-agent-new>${icon("plus")}<span>新建 Agent</span></button>
    </div>
    <div class="skill-body">
      <div class="skill-list-pane">
        <div class="settings-project" data-agent-project hidden>
          <label class="settings-project-picker">
            ${icon("folder")}
            <span class="settings-project-text"><span data-agent-project-name></span><span class="is-mono" data-agent-project-dir></span></span>
            ${icon("chevrons-up-down")}
            <select data-agent-project-select aria-label="项目"></select>
          </label>
          <div class="settings-project-trust" data-agent-trust></div>
        </div>
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
          provider,
          profile: model.profileId,
          model: model.id,
          name: model.name || model.id,
          levels: model.levels
        }))
      );
      view.error = "";
      if (view.pending) {
        view.selected = view.pending.key;
        const definition = view.pending.definition;
        view.draft = {
          ...definition,
          ...(definition.profile ? { profileId: definition.profile } : {}),
          mcp: [...(definition.mcp ?? [])]
        };
        view.pending = undefined;
      } else if (view.selected !== NEW) view.draft = undefined;
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
  const builtinOf = (role) =>
    view.data.agents.find((agent) => agent.source === "builtin" && agent.name === role);
  const modelEntry = (profileId) => view.models.find((entry) => entry.profile === profileId);
  const levelLabel = (level) => (level ? ui(LEVEL_LABELS[level] || level) : "");

  /** A built-in's global settings with defaults applied, to compare a project draft against. */
  function globalValue(agent) {
    const saved = agent.builtin.global ?? {};
    return {
      profileId: saved.profileId,
      thinking: saved.thinkingLevel,
      skills: saved.skills ?? "all",
      mcp: saved.mcp ?? (agent.name === "main" ? "all" : []),
      prompt: saved.prompt ?? ""
    };
  }
  /** The draft's built-in fields in the same shape. */
  const draftValue = (draft) => ({
    profileId: draft.profileId,
    thinking: draft.thinking,
    skills: draft.skills ?? "all",
    mcp: draft.mcp,
    prompt: draft.prompt.trim()
  });
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  /** The rows in display order, each with the group it is shown under. */
  function rows() {
    const query = view.query.trim().toLowerCase();
    const groups =
      view.scope === "global"
        ? [
            ["builtin", ui("内置"), ""],
            ["global", ui("全局"), "~/.atria/agents"]
          ]
        : [
            ["builtin", ui("内置"), ""],
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
    if (agent.builtin) {
      if (view.scope === "project") {
        const fields = Object.keys(agent.builtin.settings);
        return fields.length
          ? ui`本项目单独设置了${fields.map((field) => ui(FIELD_LABEL[field])).join(ui("、"))}`
          : ui("跟随全局");
      }
      if (agent.name === "main") return ui("你对话的那个");
      const effective = agent.builtin.effective;
      return [
        ui(PERMISSION_LABEL[definition.permission]),
        modelEntry(effective.profileId)?.name,
        levelLabel(effective.thinkingLevel)
      ]
        .filter(Boolean)
        .join(" · ");
    }
    const parts = [ui(PERMISSION_LABEL[definition.permission])];
    if (definition.skills) parts.push(ui`${definition.skills.length} 技能`);
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
    const chosen = list.find((project) => project.projectId === view.projectId);
    $("[data-agent-project-name]").textContent = chosen
      ? chosen.projectName || chosen.projectDirectory
      : ui("还没有项目");
    const project = view.data.project;
    const shown = project && project.projectId === view.projectId;
    $("[data-agent-project-dir]").textContent = shown ? project.displayDirectory : "";
    const trust = $("[data-agent-trust]");
    if (!shown) {
      trust.innerHTML = "";
      return;
    }
    trust.innerHTML =
      project.trust === "trusted"
        ? ui`<span class="is-ok">${icon("shield-check")}</span><span>已信任此项目</span><button class="settings-link" type="button" data-agent-trust-set="untrusted">撤销</button>`
        : ui`<span class="is-alert">${icon("triangle-alert")}</span><span>${project.trust === "untrusted" ? ui("未信任") : ui("尚未决定是否信任")}</span><button class="app-button is-secondary" type="button" data-agent-trust-set="trusted">信任此项目</button>`;
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
                  ? `<span class="skill-tag has-icon">${icon("lock")}${esc(ui("内置"))}</span>`
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
              <span class="settings-icon-box">${icon(agentIcon(agent.definition))}</span>
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

  /**
   * Whether the selected entry's settings can be edited here: a built-in on
   * either page (its fixed fields stay locked), a file Agent only on its own page.
   */
  function editable(agent) {
    if (!agent) return view.selected === NEW;
    if (agent.builtin) return true;
    if (!agent.definition) return false;
    return agent.source === view.scope;
  }

  function startDraft(agent) {
    if (agent?.builtin) {
      const effective = agent.builtin.effective;
      view.draft = {
        ...agent.definition,
        builtin: true,
        tools: undefined,
        profileId: effective.profileId,
        thinking: effective.thinkingLevel,
        skills: effective.skills === "all" ? undefined : [...effective.skills],
        mcp: effective.mcp === "all" ? "all" : [...effective.mcp],
        prompt: effective.prompt
      };
      return;
    }
    const definition = agent?.definition;
    view.draft = definition
      ? {
          ...definition,
          ...(definition.profile ? { profileId: definition.profile } : {}),
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
          `<span class="agent-chip">${icon(kind === "skill" ? "book-open" : "plug")}<span>${esc(name)}</span>${disabled ? "" : `<button type="button" data-agent-remove-${kind}="${esc(name)}" aria-label="${esc(ui`移除 ${name}`)}">${icon("close")}</button>`}</span>`
      )
      .join("");
  }

  /** The 添加 button: a native select under a chip-shaped label, so keyboard and screen readers keep the list. */
  function addButton(kind, label, choices) {
    return `<label class="agent-add">${icon("plus")}<span>${esc(ui("添加"))}</span><select data-agent-add-${kind} aria-label="${esc(label)}"><option value="">${esc(ui("添加"))}</option>${choices}</select></label>`;
  }

  /** The model field's button: the chosen model with its provider's mark, or what applies without one. */
  function modelButtonLabel(draft) {
    const entry = draft.profileId && modelEntry(draft.profileId);
    if (entry)
      return `${providerLogo(entry.provider, 22, entry.model)}<span class="role-picker-text"><span>${esc(entry.name)}</span><small>${esc(entry.provider.name)}</small></span>`;
    if (draft.model) return `<span class="role-picker-text"><span>${esc(draft.model)}</span></span>`;
    return `<span class="role-picker-text is-empty"><span>${esc(modelFallback(draft))}</span></span>`;
  }

  /** What runs when no model is chosen. */
  function modelFallback(draft) {
    if (draft.builtin) {
      if (view.scope === "project") return ui("跟随全局");
      return draft.name === "main" ? ui("第一个可用模型") : ui("沿用 Main 的模型");
    }
    const role = draft.permission === "read" ? "reviewer" : "executor";
    const name = modelEntry(builtinOf(role)?.builtin?.effective.profileId)?.name;
    return name ? ui`沿用 ${role} 的模型（${name}）` : ui`沿用 ${role} 的模型`;
  }

  /** The levels the chosen model accepts; without one, every level. */
  function effortLevels(draft) {
    const role = draft.builtin ? undefined : draft.permission === "read" ? "reviewer" : "executor";
    const profileId = draft.profileId ?? (role && builtinOf(role)?.builtin?.effective.profileId);
    return modelEntry(profileId)?.levels ?? LEVELS;
  }

  /** On the project page, where a built-in field's value comes from. */
  function inheritHint(agent, field) {
    if (!agent?.builtin || view.scope !== "project") return "";
    const global = globalValue(agent);
    const value = draftValue(view.draft);
    const keys = field === "model" ? ["profileId", "thinking"] : [field];
    if (keys.every((key) => same(value[key], global[key]))) return ui("跟随全局");
    if (field === "model")
      return ui`全局：${[modelEntry(global.profileId)?.name ?? ui("未选择"), levelLabel(global.thinking)].filter(Boolean).join(" · ")}`;
    return "";
  }

  function renderEditor(agent) {
    const draft = view.draft;
    const locked = !editable(agent);
    // A built-in's name, description, permission and tools are fixed.
    const fixed = locked || Boolean(draft.builtin);
    const main = draft.builtin && draft.name === "main";
    const options = view.options ?? { tools: { write: [], read: [] }, skills: [], mcp: [] };
    const allTools = options.tools.write;
    const allowed = new Set(options.tools[draft.permission]);
    const tools = draft.tools ?? DEFAULT_TOOLS[draft.permission];
    const skillChoices = options.skills.filter((name) => !(draft.skills ?? []).includes(name));
    const mcpList = draft.mcp === "all" ? [] : (draft.mcp ?? []);
    const mcpChoices = options.mcp.filter((server) => !mcpList.includes(server.name));
    const disabled = locked ? " disabled" : "";
    const fixedAttr = fixed ? " disabled" : "";
    const hint = (field) => {
      const text = inheritHint(agent, field);
      return text ? `<small>${esc(text)}</small>` : "<span></span>";
    };
    const levels = effortLevels(draft);
    const effortShown = draft.thinking ? levelLabel(draft.thinking) : draft.builtin ? ui("默认") : ui("沿用");
    const skillField = ui`<div class="mcp-field">
            <span class="mcp-field-label">技能</span>${hint("skills")}
            <div class="settings-segmented" role="radiogroup" aria-label="技能" data-agent-skill-mode>
              <button type="button" role="radio" data-agent-skill-mode-value="all" aria-checked="${!draft.skills}"${disabled}>全部可见</button>
              <button type="button" role="radio" data-agent-skill-mode-value="some" aria-checked="${Boolean(draft.skills)}"${disabled}>只用指定的</button>
            </div>
            ${
              draft.skills
                ? `<div class="agent-chips">${chips(draft.skills, "skill", locked)}${locked || !skillChoices.length ? "" : addButton("skill", ui("添加技能"), skillChoices.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join(""))}</div>`
                : ""
            }
          </div>`;
    const mcpChips = `<div class="agent-chips">${chips(mcpList, "mcp", locked)}${locked || !mcpChoices.length ? "" : addButton("mcp", ui("添加 MCP 服务"), mcpChoices.map((server) => `<option value="${esc(server.name)}">${esc(server.name)}${server.enabled ? "" : esc(ui("（已停用）"))}</option>`).join(""))}</div>`;
    const mcpField = main
      ? ui`<div class="mcp-field">
            <span class="mcp-field-label">MCP 服务</span>${hint("mcp")}
            <div class="settings-segmented" role="radiogroup" aria-label="MCP 服务" data-agent-mcp-mode>
              <button type="button" role="radio" data-agent-mcp-mode-value="all" aria-checked="${draft.mcp === "all"}"${disabled}>全部可用</button>
              <button type="button" role="radio" data-agent-mcp-mode-value="some" aria-checked="${draft.mcp !== "all"}"${disabled}>只用指定的</button>
            </div>
            ${draft.mcp === "all" ? "" : mcpChips}
          </div>`
      : ui`<div class="mcp-field">
            <span class="mcp-field-label">MCP 服务</span>${draft.builtin ? hint("mcp") : `<small>${esc(ui("不选则不给任何服务"))}</small>`}
            ${mcpChips}
          </div>`;
    const toolField = main
      ? ui`<div class="mcp-field">
            <span class="mcp-field-label">工具</span><span></span>
            <p class="agent-tools-text">派活、提问、合入，读写、搜索与浏览</p>
          </div>`
      : ui`<div class="mcp-field">
            <span class="mcp-field-label">工具</span>${fixed ? "<span></span>" : `<small>${esc(ui("只读时不能选写入类工具"))}</small>`}
            <div class="agent-tools">
              ${allTools
                .map((tool) => {
                  const off = !allowed.has(tool);
                  return `<label class="agent-tool${off ? " is-off" : ""}"><input type="checkbox" value="${esc(tool)}" data-agent-tool${tools.includes(tool) && !off ? " checked" : ""}${off || fixed ? " disabled" : ""}>${icon(off ? "ban" : "check")}<span>${esc(tool)}</span></label>`;
                })
                .join("")}
            </div>
            ${fixed ? "" : `<p class="agent-hint">${esc(ui("ask_main、send_peer_message 始终可用；Main 专用工具不可选"))}</p>`}
          </div>`;
    return ui`<form class="agent-form" data-agent-form>
      <div class="agent-form-columns">
        <div class="agent-form-column">
          <div class="mcp-field">
            <label for="agent-name">名称</label>${fixed ? "<span></span>" : `<small>${esc(ui("字母、数字和连字符"))}</small>`}
            <input id="agent-name" data-agent-field="name" value="${esc(draft.name)}" autocomplete="off" spellcheck="false"${fixedAttr}>
          </div>
          <div class="mcp-field">
            <label for="agent-description">${main ? ui("职责") : ui("给 Main 的使用说明")}</label>${fixed ? "<span></span>" : `<small>${esc(ui("Main 据此决定何时派给它"))}</small>`}
            <textarea id="agent-description" data-agent-field="description" rows="3"${fixedAttr}>${esc(draft.description)}</textarea>
          </div>
          ${
            main
              ? ""
              : ui`<div class="mcp-field">
            <span class="mcp-field-label">权限</span><span></span>
            <div class="agent-permissions" role="radiogroup" aria-label="权限">
              ${["write", "read"]
                .map(
                  (permission) =>
                    `<label class="agent-permission"><input type="radio" name="agent-permission" value="${permission}" data-agent-permission${draft.permission === permission ? " checked" : ""}${fixedAttr}><strong>${icon(permission === "write" ? "pencil" : "eye")}${esc(ui(PERMISSION_LABEL[permission]))}</strong><small>${esc(permission === "write" ? ui("在隔离现场修改代码") : ui("独立副本里检查，结论文字交回"))}</small></label>`
                )
                .join("")}
            </div>
          </div>`
          }
          <div class="mcp-field">
            <span class="mcp-field-label">模型与推理强度</span>${draft.builtin ? hint("model") : `<small>${esc(ui("不选则可写跟 executor、只读跟 reviewer"))}</small>`}
            <div class="agent-model-row">
              <button type="button" class="role-picker agent-model-picker" data-agent-model aria-haspopup="listbox" aria-label="${esc(ui("模型"))}"${disabled}>${modelButtonLabel(draft)}${icon("chevrons-up-down")}</button>
              <label class="agent-effort${locked ? " is-disabled" : ""}">${icon("brain")}<span>${esc(effortShown)}</span>${icon("chevron-down")}<select data-agent-effort aria-label="${esc(ui("推理强度"))}"${disabled}>
                <option value=""${draft.thinking ? "" : " selected"}>${esc(draft.builtin ? ui("默认") : ui("沿用"))}</option>
                ${[...new Set([...levels, ...(draft.thinking ? [draft.thinking] : [])])]
                  .map(
                    (level) =>
                      `<option value="${esc(level)}"${level === draft.thinking ? " selected" : ""}>${esc(levelLabel(level))}</option>`
                  )
                  .join("")}
              </select></label>
            </div>
          </div>
        </div>
        <div class="agent-form-column">
          ${toolField}
          ${skillField}
          ${mcpField}
        </div>
      </div>
      <div class="mcp-field">
        <label for="agent-prompt">附加提示词</label>${draft.builtin ? hint("prompt") : `<small>${esc(ui("接在角色基础提示词之后，不替换安全规则"))}</small>`}
        <textarea id="agent-prompt" class="agent-prompt" data-agent-field="prompt" rows="4" placeholder="${esc(draft.builtin ? ui("接在内置提示词之后，例如：提交信息用中文写；改动前先跑一遍现有测试。") : "")}"${disabled}>${esc(draft.prompt)}</textarea>
      </div>
      ${
        locked
          ? ""
          : ui`<div class="agent-form-foot">
        <span class="agent-hint">${icon("info")}${main ? ui("保存后从下一轮对话起生效") : ui("运行中的工作项保持派单时的定义，修改只影响之后的派单")}</span>
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
    const sourceIcon = source === "builtin" ? "lock" : source === "project" ? "folder" : "globe";
    const canToggle = agent && !agent.builtin && editable(agent);
    const overrides = agent?.builtin && view.scope === "project" ? Object.keys(agent.builtin.settings) : [];
    const head = ui`<div class="skill-detail-head">
        <span class="settings-icon-box is-large">${icon(agentIcon(view.draft))}</span>
        <span class="skill-detail-title"><h2>${esc(agent?.name ?? ui("新建 Agent"))}</h2><span class="agent-detail-meta"><span class="skill-tag has-icon">${icon(sourceIcon)}${esc(sourceLabel)}</span>${agent?.displayPath ? `<span class="agent-path" title="${esc(agent.path)}">${esc(agent.displayPath)}</span>` : ""}</span></span>
        <span class="settings-group-spacer"></span>
        ${canToggle ? `<span class="mcp-enabled"><span>${ui("启用")}</span><button type="button" class="ui-switch" role="switch" data-agent-enabled aria-checked="${agent.definition.enabled !== false}" aria-label="${esc(ui("启用"))}"></button></span>` : ""}
        ${agent?.builtin && view.scope === "project" ? `<button class="app-button is-secondary" type="button" data-agent-reset${overrides.length ? "" : " disabled"}>${icon("rotate-ccw")}<span>${ui("全部跟随全局")}</span></button>` : ""}
        ${agent?.definition && agent.name !== "main" && !(agent.builtin && view.scope === "project") ? `<button class="app-button is-secondary" type="button" data-agent-copy>${icon("copy")}<span>${ui("复制")}</span></button>` : ""}
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
    $("[data-agent-note]").textContent = ui(SCOPE_NOTE[view.scope]);
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
    if (!view.draft.builtin)
      view.draft.tools = [...form.querySelectorAll("[data-agent-tool]:checked")].map((box) => box.value);
    const effort = form.querySelector("[data-agent-effort]")?.value;
    if (effort) view.draft.thinking = effort;
    else delete view.draft.thinking;
  }

  /** What a built-in's draft saves: on the project page, only the fields that differ from the global value. */
  function builtinSettings(agent, draft) {
    const value = draftValue(draft);
    const base =
      view.scope === "project"
        ? globalValue(agent)
        : {
            profileId: undefined,
            thinking: undefined,
            skills: "all",
            mcp: agent.name === "main" ? "all" : [],
            prompt: ""
          };
    const settings = {};
    if (value.profileId && value.profileId !== base.profileId) settings.profileId = value.profileId;
    if (value.thinking && value.thinking !== base.thinking) settings.thinkingLevel = value.thinking;
    if (!same(value.skills, base.skills)) settings.skills = value.skills;
    if (!same(value.mcp, base.mcp)) settings.mcp = value.mcp;
    if (value.prompt !== base.prompt) settings.prompt = value.prompt;
    return settings;
  }

  async function saveBuiltin(agent, settings, done) {
    view.saving = true;
    render();
    try {
      await post("/api/agents/builtin", { target: target(), name: agent.name, settings });
      showToast(done);
      onBuiltinSaved();
      view.draft = undefined;
      await load();
    } catch (error) {
      showToast(error?.message || ui("保存未完成"));
    } finally {
      view.saving = false;
      render();
    }
  }

  async function save() {
    readForm();
    const agent = view.selected === NEW ? undefined : selectedAgent();
    const draft = view.draft;
    if (agent?.builtin) return saveBuiltin(agent, builtinSettings(agent, draft), ui("已保存"));
    const allowed = new Set(view.options?.tools[draft.permission] ?? []);
    const definition = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      permission: draft.permission,
      ...(draft.profileId ? { profile: draft.profileId } : {}),
      ...(draft.model ? { model: draft.model } : {}),
      ...(draft.thinking ? { thinking: draft.thinking } : {}),
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

  /* ---------------------------------------------------------------- model menu */

  /** One floating list of every usable model, grouped by provider. */
  const menu = document.createElement("div");
  menu.className = "role-menu";
  menu.hidden = true;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", ui("模型"));
  menu.innerHTML = `<label class="provider-search">${icon("search")}<input type="search" data-agent-menu-search placeholder="${esc(ui("搜索模型"))}" aria-label="${esc(ui("搜索模型"))}"></label><div class="role-menu-items" data-agent-menu-items></div>`;
  document.body.append(menu);
  let menuQuery = "";
  const closeMenu = () => {
    menu.hidden = true;
  };
  function renderMenu() {
    const draft = view.draft;
    if (!draft) return;
    const current = draft.profileId ?? "";
    const query = menuQuery.toLowerCase();
    const groups = new Map();
    for (const entry of view.models) {
      if (!`${entry.name} ${entry.model} ${entry.provider.name}`.toLowerCase().includes(query)) continue;
      if (!groups.has(entry.provider.id)) groups.set(entry.provider.id, []);
      groups.get(entry.provider.id).push(entry);
    }
    menu.querySelector("[data-agent-menu-items]").innerHTML =
      `<button type="button" class="role-menu-item" role="option" data-agent-pick="" aria-selected="${!current}"><span>${esc(modelFallback({ ...draft, profileId: undefined, model: undefined }))}</span><span class="settings-row-spacer"></span>${!current ? icon("check") : ""}</button>` +
      [...groups.values()]
        .map(
          (entries) =>
            `<div class="role-menu-group">${providerLogo(entries[0].provider, 16, entries[0].model)}<span>${esc(entries[0].provider.name)}</span></div>${entries
              .map(
                (entry) =>
                  `<button type="button" class="role-menu-item" role="option" data-agent-pick="${esc(entry.profile)}" aria-selected="${entry.profile === current}"><span>${esc(entry.name)}</span><span class="settings-row-spacer"></span>${entry.profile === current ? icon("check") : ""}</button>`
              )
              .join("")}`
        )
        .join("");
  }
  function openMenu(button) {
    menuQuery = "";
    menu.querySelector("[data-agent-menu-search]").value = "";
    renderMenu();
    const box = button.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(box.left, innerWidth - 348))}px`;
    menu.style.top = `${Math.min(box.bottom + 6, innerHeight - 320)}px`;
    menu.hidden = false;
    menu.querySelector("[data-agent-menu-search]").focus();
  }
  menu.addEventListener("input", (event) => {
    if (!event.target.matches("[data-agent-menu-search]")) return;
    menuQuery = event.target.value;
    renderMenu();
  });
  menu.addEventListener("click", (event) => {
    const pick = event.target.closest("[data-agent-pick]");
    if (!pick || !view.draft) return;
    closeMenu();
    readForm();
    const entry = modelEntry(pick.dataset.agentPick);
    if (entry) {
      view.draft.profileId = entry.profile;
      if (view.draft.builtin) delete view.draft.model;
      else view.draft.model = entry.model;
    } else {
      delete view.draft.profileId;
      delete view.draft.model;
    }
    // A level the new model does not take falls back to the default.
    if (view.draft.thinking && !effortLevels(view.draft).includes(view.draft.thinking))
      delete view.draft.thinking;
    render();
    $("[data-agent-model]")?.focus();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !event.target.closest("[data-agent-model]"))
      closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      closeMenu();
      $("[data-agent-model]")?.focus();
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
      if (agent.builtin) {
        delete view.draft.builtin;
        view.draft.tools = undefined;
        if (view.draft.mcp === "all") view.draft.mcp = [];
        // A copy names the model the built-in used, so it keeps running there.
        const entry = modelEntry(view.draft.profileId);
        if (entry) view.draft.model = entry.model;
        else delete view.draft.profileId;
      }
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
    if (event.target.closest("[data-agent-reset]") && agent?.builtin) {
      await saveBuiltin(agent, {}, ui("已改为跟随全局"));
      return;
    }
    const picker = event.target.closest("[data-agent-model]");
    if (picker && !picker.disabled) {
      if (menu.hidden) openMenu(picker);
      else closeMenu();
      return;
    }
    const mcpMode = event.target.closest("[data-agent-mcp-mode-value]");
    if (mcpMode && view.draft) {
      readForm();
      view.draft.mcp =
        mcpMode.dataset.agentMcpModeValue === "all" ? "all" : view.draft.mcp === "all" ? [] : view.draft.mcp;
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
        view.draft[key] = (view.draft[key] === "all" ? [] : view.draft[key]).filter(
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
      const list = view.draft[key] === "all" ? [] : (view.draft[key] ?? []);
      view.draft[key] = [...list, add.value];
      render();
      return;
    }
    if (event.target.matches("[data-agent-effort]")) {
      readForm();
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

  $("[data-agent-ask]")?.addEventListener("click", () => askMain());

  onSection("agents", () => void load());

  return {
    refresh: load,
    /** Open a definition Main proposed, to finish it here instead of in the conversation. */
    openProposal(proposal) {
      view.scope = proposal.scope;
      if (proposal.scope === "project") {
        const project = projects().find((entry) => proposal.path.startsWith(`${entry.projectDirectory}/`));
        if (project) view.projectId = project.projectId;
      }
      view.page = 1;
      view.query = "";
      view.pending = {
        key: proposal.action === "create" ? NEW : `${proposal.scope}:${proposal.definition.name}`,
        definition: proposal.definition
      };
    }
  };
}
