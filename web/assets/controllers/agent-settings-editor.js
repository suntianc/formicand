import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../ui/html.js";

export const PERMISSION_LABEL = { write: "可写", read: "只读" };

export const agentIcon = (definition) =>
  definition?.name === "main" ? "bot" : definition?.permission === "read" ? "scan-eye" : "wrench";

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

export function agentEditorMarkup({
  agent,
  draft,
  locked,
  options: availableOptions,
  saving,
  inheritHint,
  levels,
  modelLabel,
  levelLabel
}) {
  // A built-in's name, description, permission and tools are fixed.
  const fixed = locked || Boolean(draft.builtin);
  const main = draft.builtin && draft.name === "main";
  const options = availableOptions ?? { tools: { write: [], read: [] }, skills: [], mcp: [] };
  const allTools = options.tools.write;
  const allowed = new Set(options.tools[draft.permission]);
  const tools = draft.tools ?? DEFAULT_TOOLS[draft.permission];
  const skillChoices = options.skills.filter((name) => !(draft.skills ?? []).includes(name));
  const mcpList = draft.mcp === "all" ? [] : (draft.mcp ?? []);
  const mcpChoices = options.mcp.filter((server) => !mcpList.includes(server.name));
  const disabled = locked ? " disabled" : "";
  const fixedAttr = fixed ? " disabled" : "";
  const hint = (field) => {
    const text = inheritHint(field);
    return text ? `<small>${esc(text)}</small>` : "<span></span>";
  };
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
            <button type="button" class="role-picker agent-model-picker" data-agent-model aria-haspopup="listbox" aria-label="${esc(ui("模型"))}"${disabled}>${modelLabel}${icon("chevrons-up-down")}</button>
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
      <button class="app-button is-primary" type="submit" data-agent-save${saving ? " disabled" : ""}>保存</button>
    </div>`
    }
  </form>`;
}

export function agentDetailHeader({ agent, draft, scope, project, locked }) {
  const source = agent?.source ?? scope;
  const sourceLabel =
    source === "builtin"
      ? ui("内置")
      : source === "project"
        ? ui`项目 · ${project?.projectName ?? ""}`
        : ui("全局");
  const sourceIcon = source === "builtin" ? "lock" : source === "project" ? "folder" : "globe";
  const canToggle = agent && !agent.builtin && !locked;
  const overrides = agent?.builtin && scope === "project" ? Object.keys(agent.builtin.settings) : [];
  const head = ui`<div class="skill-detail-head">
        <span class="settings-icon-box is-large">${icon(agentIcon(draft))}</span>
        <span class="skill-detail-title"><h2>${esc(agent?.name ?? ui("新建 Agent"))}</h2><span class="agent-detail-meta"><span class="skill-tag has-icon">${icon(sourceIcon)}${esc(sourceLabel)}</span>${agent?.displayPath ? `<span class="agent-path" title="${esc(agent.path)}">${esc(agent.displayPath)}</span>` : ""}</span></span>
        <span class="settings-group-spacer"></span>
        ${canToggle ? `<span class="mcp-enabled"><span>${ui("启用")}</span><button type="button" class="ui-switch" role="switch" data-agent-enabled aria-checked="${agent.definition.enabled !== false}" aria-label="${esc(ui("启用"))}"></button></span>` : ""}
        ${agent?.builtin && scope === "project" ? `<button class="app-button is-secondary" type="button" data-agent-reset${overrides.length ? "" : " disabled"}>${icon("rotate-ccw")}<span>${ui("全部跟随全局")}</span></button>` : ""}
        ${agent?.definition && agent.name !== "main" && !(agent.builtin && scope === "project") ? `<button class="app-button is-secondary" type="button" data-agent-copy>${icon("copy")}<span>${ui("复制")}</span></button>` : ""}
        ${agent && agent.source === scope && agent.source !== "builtin" ? `<button class="app-button is-danger" type="button" data-agent-delete>${icon("trash")}<span>${ui("删除")}</span></button>` : ""}
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
    agent && agent.source === "global" && scope === "project"
      ? `<p class="agent-hint">${esc(ui("全局 Agent 在「全局」页编辑"))}</p>`
      : ""
  ].join("");
  return head + notes;
}
