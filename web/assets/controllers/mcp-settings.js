import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../ui/html.js";
import { createModal } from "../ui/modal.js";
import { letterMark } from "../ui/letter-mark.js";

/**
 * Settings → MCP.
 *
 * One global list, `~/.atria/mcp.json`, shared by every project. The backend
 * checks each server through Pi and reports its state and tools; a server's
 * default exposure and single tools' exposure are set here. Which Agent uses
 * which server is chosen on the Agent's own page, not here.
 */
const PAGE_SIZE = 10;
const EXPOSURES = [
  ["direct", "直接给模型"],
  ["deferred", "按需搜索"],
  ["hidden", "隐藏"]
];
const FILTERS = [
  ["all", "全部"],
  ["connected", "已连接"],
  ["problem", "有问题"],
  ["disabled", "已停用"]
];
const PROBLEM_STATES = new Set(["failed", "needs-auth", "invalid"]);
/** Tools past this many fold behind one row. */
const FOLDED_TOOLS = 4;

/** A literal value is masked; a `${NAME}` reference or `!command` is shown, since it names where the value comes from. */
const shownValue = (value) => (/^\$\{[^}]+\}$/.test(value) || value.startsWith("!") ? value : "••••••");
const fromEnvironment = (value) => /\$\{[^}]+\}/.test(value);

function relativeTime(iso) {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return ui("刚刚检查");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return ui`${minutes} 分钟前检查`;
  return ui`${Math.round(minutes / 60)} 小时前检查`;
}

function stateText(server) {
  const status = server.status;
  if (server.login?.state === "waiting") return ui("正在等待浏览器登录");
  switch (status.state) {
    case "connected":
      return ui`${server.kind === "http" ? ui("远程") : ui("本地命令")} · ${status.tools.length} 个工具`;
    case "needs-auth":
      return ui("需要登录");
    case "failed":
      return ui`连接失败 · ${status.error ?? ""}`;
    case "disabled":
      return ui("已停用");
    case "invalid":
      return ui("配置有误");
    default:
      return ui("正在检查…");
  }
}

/** The line under a server's name is coloured by how urgent its state is. */
function stateTone(server) {
  const state = server.status.state;
  if (state === "needs-auth") return " is-warn";
  if (state === "failed" || state === "invalid") return " is-alert";
  return "";
}

/** An icon-only action in the server detail; its name is its label and tooltip. */
const detailAction = (action, glyph, label, { danger = false, disabled = false } = {}) =>
  `<button class="settings-icon-button detail-action${danger ? " is-danger" : ""}" type="button" data-mcp-action="${action}" aria-label="${esc(label)}" title="${esc(label)}"${disabled ? " disabled" : ""}>${icon(glyph)}</button>`;

function dotClass(server) {
  const state = server.status.state;
  if (state === "connected") return "is-ok";
  if (PROBLEM_STATES.has(state)) return "is-alert";
  return "is-muted";
}

export function createMcpSettings({ panel, api, onSection, showToast = () => {} }) {
  const view = {
    filter: "all",
    query: "",
    page: 1,
    selected: "",
    toolsOpen: false,
    loading: false,
    checking: false,
    error: "",
    data: { path: "", servers: [] }
  };
  let requestSeq = 0;
  let loginTimer;
  const post = (path, json) => api(path, { method: "POST", json });

  panel.innerHTML = ui`<div class="skill-head">
      <h1 class="settings-page-title">MCP</h1>
      <span class="settings-group-spacer"></span>
      <button class="app-button is-secondary" type="button" data-mcp-import>${icon("clipboard-paste")}<span>粘贴 JSON</span></button>
      <button class="app-button is-primary" type="button" data-mcp-add>${icon("plus")}<span>新建</span></button>
    </div>
    <div class="skill-body">
      <div class="skill-list-pane">
        <label class="skill-search">${icon("search")}<input type="search" data-mcp-search placeholder="搜索服务或工具" aria-label="搜索服务或工具" autocomplete="off" spellcheck="false"></label>
        <div class="skill-filters" role="radiogroup" aria-label="状态" data-mcp-filters></div>
        <ul class="skill-list" data-mcp-list aria-label="服务列表"></ul>
        <div class="skill-pager" data-mcp-pager>
          <span data-mcp-total></span>
          <span class="settings-group-spacer"></span>
          <button class="settings-icon-button" type="button" data-mcp-page="-1" aria-label="上一页">${icon("chevron-left")}</button>
          <span data-mcp-page-label></span>
          <button class="settings-icon-button" type="button" data-mcp-page="1" aria-label="下一页">${icon("chevron-right")}</button>
        </div>
      </div>
      <div class="skill-detail" data-mcp-detail aria-live="polite"></div>
    </div>`;

  const $ = (selector) => panel.querySelector(selector);
  const selectedServer = () => view.data.servers.find((server) => server.name === view.selected);

  /* ---------------------------------------------------------------- data */

  function accept(data) {
    view.data = data;
    view.error = "";
    scheduleLoginPoll();
  }

  async function load() {
    const seq = ++requestSeq;
    view.loading = true;
    render();
    try {
      const data = await api("/api/mcp");
      if (seq !== requestSeq) return;
      accept(data);
    } catch (error) {
      if (seq !== requestSeq) return;
      view.data = { path: "", servers: [] };
      view.error = error?.message || ui("MCP 服务读取失败");
    } finally {
      if (seq === requestSeq) {
        view.loading = false;
        render();
      }
    }
    if (seq === requestSeq && view.data.servers.some((server) => server.status.state === "unchecked"))
      void check();
  }

  /** Check servers again; the ones not yet checked when `names` is omitted. */
  async function check(names) {
    const targets =
      names ??
      view.data.servers.filter((server) => server.status.state === "unchecked").map((server) => server.name);
    if (!targets.length) return;
    view.checking = true;
    render();
    const seq = ++requestSeq;
    try {
      const data = await post("/api/mcp/check", { names: targets });
      if (seq === requestSeq) accept(data);
    } catch (error) {
      showToast(error?.message || ui("检查连接失败"));
    } finally {
      view.checking = false;
      render();
    }
  }

  function scheduleLoginPoll() {
    clearTimeout(loginTimer);
    if (!view.data.servers.some((server) => server.login?.state === "waiting")) return;
    loginTimer = setTimeout(async () => {
      try {
        accept(await api("/api/mcp"));
        render();
        // eslint-disable-next-line no-restricted-syntax -- 轮询登录状态时一次读取失败只需稍后再试，登录本身不受影响
      } catch {
        scheduleLoginPoll();
      }
    }, 2000);
  }

  function visibleServers() {
    const query = view.query.trim().toLowerCase();
    return view.data.servers.filter((server) => {
      const state = server.status.state;
      if (view.filter === "connected" && state !== "connected") return false;
      if (view.filter === "problem" && !PROBLEM_STATES.has(state)) return false;
      if (view.filter === "disabled" && state !== "disabled") return false;
      return (
        !query ||
        server.name.toLowerCase().includes(query) ||
        server.status.tools.some((tool) => tool.toLowerCase().includes(query))
      );
    });
  }

  /* ---------------------------------------------------------------- render */

  function renderFilters() {
    $("[data-mcp-filters]").innerHTML = FILTERS.map(
      ([value, label]) =>
        `<button type="button" role="radio" class="skill-filter" data-mcp-filter="${value}" aria-checked="${view.filter === value}">${esc(ui(label))}</button>`
    ).join("");
  }

  function emptyText() {
    if (view.loading) return ui("正在读取…");
    if (view.error) return view.error;
    return view.query || view.filter !== "all" ? ui("没有匹配的服务") : ui("还没有 MCP 服务");
  }

  function renderList() {
    const servers = visibleServers();
    const pages = Math.max(1, Math.ceil(servers.length / PAGE_SIZE));
    view.page = Math.min(Math.max(1, view.page), pages);
    const shown = servers.slice((view.page - 1) * PAGE_SIZE, view.page * PAGE_SIZE);
    if (!servers.some((server) => server.name === view.selected)) view.selected = shown[0]?.name ?? "";
    $("[data-mcp-list]").innerHTML = shown.length
      ? shown
          .map(
            (
              server
            ) => `<li><button type="button" class="skill-row${server.enabled ? "" : " is-off"}" data-mcp-select="${esc(server.name)}" aria-current="${server.name === view.selected}">
              ${letterMark(server.name)}
              <span class="skill-row-text"><span class="skill-row-name">${esc(server.name)}</span><span class="skill-row-desc${stateTone(server)}">${esc(stateText(server))}</span></span>
              <span class="settings-dot ${dotClass(server)}" aria-hidden="true"></span>
            </button></li>`
          )
          .join("")
      : `<li class="skill-empty">${esc(emptyText())}</li>`;
    $("[data-mcp-total]").textContent = ui`共 ${servers.length} 个`;
    $("[data-mcp-page-label]").textContent = `${view.page} / ${pages}`;
    $('[data-mcp-page="-1"]').disabled = view.page <= 1;
    $('[data-mcp-page="1"]').disabled = view.page >= pages;
  }

  function pairs(map, mask) {
    const entries = Object.entries(map ?? {});
    if (!entries.length) return ui("无");
    return entries
      .map(
        ([key, value]) =>
          `<span class="mcp-pair"><span class="is-mono">${esc(key)}: ${esc(mask ? shownValue(value) : value)}</span>${fromEnvironment(value) ? `<span class="skill-tag">${esc(ui("取自环境变量"))}</span>` : ""}</span>`
      )
      .join("");
  }

  function exposureOptions(selected, withDefault) {
    return [
      ...(withDefault ? [["", ui("默认")]] : []),
      ...EXPOSURES.map(([value, label]) => [value, ui(label)])
    ]
      .map(
        ([value, label]) =>
          `<option value="${value}"${value === selected ? " selected" : ""}>${esc(label)}</option>`
      )
      .join("");
  }

  function renderTools(server) {
    const tools = server.status.tools;
    const overrides = server.config?.toolExposure ?? {};
    const segment = EXPOSURES.map(
      ([value, label]) =>
        `<button type="button" role="radio" data-mcp-exposure="${value}" aria-checked="${server.exposure === value}">${esc(ui(label))}</button>`
    ).join("");
    // A search that names a tool keeps the whole list open so the match is visible.
    const open = view.toolsOpen || Boolean(view.query.trim()) || tools.length <= FOLDED_TOOLS + 1;
    const shown = open ? tools : tools.slice(0, FOLDED_TOOLS);
    const rows = tools.length
      ? shown
          .map(
            (tool) => `<li class="mcp-tool">
              <span class="is-mono">${esc(tool)}</span>
              <label class="sr-only" for="mcp-tool-${esc(tool)}">${esc(ui`${tool} 的可见方式`)}</label>
              <select class="mcp-exposure-select" id="mcp-tool-${esc(tool)}" data-mcp-tool="${esc(tool)}" data-exposure="${esc(overrides[tool] ?? "")}">${exposureOptions(overrides[tool] ?? "", true)}</select>
            </li>`
          )
          .join("")
      : `<li class="skill-empty">${esc(server.status.state === "connected" ? ui("这个服务没有工具") : ui("连接成功后显示工具"))}</li>`;
    const fold =
      tools.length > FOLDED_TOOLS + 1
        ? `<button class="mcp-fold" type="button" data-mcp-tools-fold aria-expanded="${open}">${icon(open ? "chevron-up" : "chevron-down")}<span>${esc(open ? ui("收起") : ui("其余 {count} 个").replace("{count}", String(tools.length - FOLDED_TOOLS)))}</span></button>`
        : "";
    return ui`<div class="mcp-tools-head">
        <h3 class="skill-section-title">工具 <span class="skill-count">${tools.length}</span></h3>
        <span class="settings-group-spacer"></span>
        <span class="mcp-label">默认</span>
        <div class="settings-segmented" role="radiogroup" aria-label="默认可见方式" data-mcp-exposures>${segment}</div>
      </div>
      <ul class="mcp-tool-list">${rows}</ul>${fold}`;
  }

  function renderDetail() {
    const server = selectedServer();
    const detail = $("[data-mcp-detail]");
    if (!server) {
      detail.innerHTML = "";
      return;
    }
    const config = server.config ?? {};
    const status = server.status;
    const stateLine =
      status.state === "connected"
        ? ui`已连接 · ${status.tools.length} 个工具 · ${relativeTime(status.checkedAt)}`
        : stateText(server);
    const login = server.login;
    const connection =
      server.kind === "http"
        ? ui`<dt>地址</dt><dd class="is-mono">${esc(config.url ?? "")}</dd>
          <dt>请求头</dt><dd>${pairs(config.headers, true)}</dd>`
        : ui`<dt>命令</dt><dd class="is-mono">${esc([config.command, ...(config.args ?? [])].filter(Boolean).join(" "))}</dd>
          <dt>环境变量</dt><dd>${pairs(config.env, true)}</dd>
          ${config.cwd ? ui`<dt>工作目录</dt><dd class="is-mono">${esc(config.cwd)}</dd>` : ""}`;
    detail.innerHTML = ui`<div class="skill-detail-head">
        ${letterMark(server.name, "is-large")}
        <span class="skill-detail-title"><h2>${esc(server.name)}</h2><span class="mcp-state"><span class="settings-dot ${dotClass(server)}" aria-hidden="true"></span><span data-mcp-state>${esc(stateLine)}</span></span></span>
        <span class="settings-group-spacer"></span>
        ${server.oauth && server.enabled && status.state === "connected" ? `<button class="app-button is-secondary" type="button" data-mcp-action="logout">${icon("unplug")}<span>${ui("退出登录")}</span></button>` : ""}
        ${server.oauth && server.enabled && (status.state === "needs-auth" || login) ? `<button class="app-button is-primary" type="button" data-mcp-action="login"${login?.state === "waiting" ? " disabled" : ""}>${icon("key-round")}<span>${ui("登录")}</span></button>` : ""}
        ${server.config ? `<button type="button" class="ui-switch" role="switch" data-mcp-enabled aria-checked="${server.enabled}" aria-label="${esc(ui("启用"))}"></button>` : ""}
        ${server.enabled && server.config ? detailAction("check", "refresh", ui("重新连接"), { disabled: view.checking }) : ""}
        ${server.config ? detailAction("edit", "pencil", ui("编辑")) : ""}
        ${detailAction("remove", "trash", ui("删除"), { danger: true })}
      </div>
      ${login?.state === "waiting" ? ui`<p class="mcp-notice">${icon("loader")}<span>请在浏览器中完成登录。${login.url ? ui`<a href="${esc(login.url)}" target="_blank" rel="noopener noreferrer">浏览器没有打开？点这里</a>` : ""}</span></p>` : ""}
      ${login?.state === "failed" ? `<p class="skill-warning">${icon("triangle-alert")}<span>${esc(ui("登录未完成："))}${esc(login.error ?? "")}</span></p>` : ""}
      ${status.state === "failed" || status.state === "invalid" ? `<p class="skill-warning">${icon("triangle-alert")}<span class="is-mono">${esc(status.error ?? "")}</span></p>` : ""}
      ${config.description ? `<p class="skill-description">${esc(config.description)}</p>` : ""}
      <dl class="skill-facts">
        <dt>方式</dt><dd>${server.kind === "http" ? ui("远程地址") : ui("本地命令")}</dd>
        ${server.config ? connection : ""}
      </dl>
      ${server.config && server.enabled ? renderTools(server) : ""}`;
  }

  function render() {
    renderFilters();
    renderList();
    renderDetail();
  }

  /* ---------------------------------------------------------------- confirm */

  const confirmPanel = document.createElement("div");
  confirmPanel.className = "modal-backdrop app-dialog-backdrop";
  confirmPanel.hidden = true;
  confirmPanel.innerHTML = ui`<section class="modal-card app-dialog" role="dialog" aria-modal="true" aria-labelledby="mcp-confirm-title">
      <h2 id="mcp-confirm-title" data-mcp-confirm-title></h2>
      <p class="skill-confirm-copy" data-mcp-confirm-copy></p>
      <div class="modal-actions dialog-actions">
        <button class="app-button is-secondary" type="button" data-mcp-confirm-cancel>取消</button>
        <button class="app-button is-danger" type="button" data-mcp-confirm-ok>删除</button>
      </div>
    </section>`;
  document.body.append(confirmPanel);
  const confirmModal = createModal(confirmPanel, confirmPanel.querySelector("[data-mcp-confirm-cancel]"));
  let confirmAction;
  confirmPanel.querySelector("[data-mcp-confirm-ok]").addEventListener("click", () => {
    const action = confirmAction;
    confirmAction = undefined;
    confirmModal.close();
    void action?.();
  });

  async function change(path, json, done) {
    try {
      accept(await post(path, json));
      if (done) showToast(done);
    } catch (error) {
      showToast(error?.message || ui("操作未完成"));
    }
    render();
  }

  async function act(action) {
    const server = selectedServer();
    if (!server) return;
    if (action === "check") return check([server.name]);
    if (action === "edit") return openEditor(server);
    if (action === "login") {
      await change("/api/mcp/login", { name: server.name });
      return;
    }
    if (action === "logout") return change("/api/mcp/logout", { name: server.name }, ui("已退出登录"));
    confirmPanel.querySelector("[data-mcp-confirm-title]").textContent = ui`删除 ${server.name}？`;
    confirmPanel.querySelector("[data-mcp-confirm-copy]").textContent =
      ui`将从 ${view.data.path} 中删除这个服务，Main 下一轮起不再连接它；已选用它的 Agent 也将失去它的工具。`;
    confirmAction = () => change("/api/mcp/remove", { name: server.name }, ui("已删除"));
    confirmModal.open();
    confirmPanel.querySelector("[data-mcp-confirm-ok]").focus();
  }

  /* ---------------------------------------------------------------- add / edit dialog */

  const editorPanel = document.createElement("div");
  editorPanel.className = "modal-backdrop app-dialog-backdrop";
  editorPanel.hidden = true;
  editorPanel.innerHTML = ui`<section class="modal-card app-dialog mcp-dialog" role="dialog" aria-modal="true" aria-labelledby="mcp-editor-title">
      <div class="mcp-dialog-head">
        <h2 id="mcp-editor-title" data-mcp-editor-title>新建 MCP 服务</h2>
        <button class="settings-icon-button" type="button" data-mcp-editor-close aria-label="关闭">${icon("close")}</button>
      </div>
      <div class="settings-segmented mcp-kinds" role="radiogroup" aria-label="连接方式" data-mcp-kind>
        <button type="button" role="radio" data-mcp-kind-value="stdio" aria-checked="true">${icon("terminal")}本地命令</button>
        <button type="button" role="radio" data-mcp-kind-value="http" aria-checked="false">${icon("globe")}远程地址</button>
        <button type="button" role="radio" data-mcp-kind-value="json" aria-checked="false">${icon("code")}粘贴 JSON</button>
      </div>
      <form class="mcp-form" data-mcp-form>
        <div class="mcp-field" data-mcp-only="stdio http">
          <label for="mcp-name">名称</label><small>工具名为 mcp__名称__工具</small>
          <input id="mcp-name" data-mcp-name placeholder="postgres" autocomplete="off" spellcheck="false">
        </div>
        <div class="mcp-row is-command" data-mcp-only="stdio">
          <div class="mcp-field">
            <label for="mcp-command">命令</label><small>一个可执行文件</small>
            <input id="mcp-command" data-mcp-command placeholder="npx" autocomplete="off" spellcheck="false">
          </div>
          <div class="mcp-field">
            <label for="mcp-args">参数</label><small>每行一个</small>
            <textarea id="mcp-args" data-mcp-args rows="2" placeholder="-y&#10;@modelcontextprotocol/server-postgres" spellcheck="false"></textarea>
          </div>
        </div>
        <div class="mcp-field" data-mcp-only="http">
          <label for="mcp-url">地址</label>
          <input id="mcp-url" data-mcp-url placeholder="https://example.com/mcp" autocomplete="off" spellcheck="false">
        </div>
        <div class="mcp-field" data-mcp-only="stdio http">
          <span class="mcp-field-label" data-mcp-pairs-label>环境变量</span><small>值可引用运行主机的环境变量</small>
          <div class="mcp-pairs" data-mcp-pairs></div>
          <button class="settings-link" type="button" data-mcp-pair-add>${icon("plus")}<span data-mcp-pair-add-label>添加变量</span></button>
        </div>
        <div class="mcp-row">
        <div class="mcp-field" data-mcp-only="stdio">
          <label for="mcp-cwd">工作目录</label><small>可选，默认是项目目录</small>
          <input id="mcp-cwd" data-mcp-cwd autocomplete="off" spellcheck="false">
        </div>
        <div class="mcp-field" data-mcp-only="stdio http">
          <span class="mcp-field-label">工具默认可见方式</span><span></span>
          <div class="settings-segmented" role="radiogroup" aria-label="工具默认可见方式" data-mcp-default-exposure>
            <button type="button" role="radio" data-mcp-default-value="direct" aria-checked="false">直接给模型</button>
            <button type="button" role="radio" data-mcp-default-value="deferred" aria-checked="true">按需搜索</button>
            <button type="button" role="radio" data-mcp-default-value="hidden" aria-checked="false">隐藏</button>
          </div>
        </div>
        </div>
        <div class="mcp-field" data-mcp-only="json">
          <label for="mcp-json">JSON</label><small>与其他客户端的 mcpServers 格式相同</small>
          <textarea id="mcp-json" data-mcp-json rows="10" spellcheck="false" placeholder='{"mcpServers": {"github": {"url": "https://api.githubcopilot.com/mcp/"}}}'></textarea>
          <label class="mcp-check"><input type="checkbox" data-mcp-replace><span>替换同名服务</span></label>
        </div>
      </form>
      <p class="mcp-test-result" data-mcp-test-result hidden></p>
      <p class="dialog-error" data-mcp-editor-error role="alert" hidden></p>
      <div class="modal-actions dialog-actions">
        <button class="app-button is-secondary" type="button" data-mcp-test>${icon("plug")}<span>测试连接</span></button>
        <span class="settings-group-spacer"></span>
        <button class="app-button is-secondary" type="button" data-mcp-editor-cancel>取消</button>
        <button class="app-button is-primary" type="button" data-mcp-save>保存</button>
      </div>
    </section>`;
  document.body.append(editorPanel);
  const editorModal = createModal(editorPanel, editorPanel.querySelector("[data-mcp-editor-cancel]"));
  editorPanel
    .querySelector("[data-mcp-editor-close]")
    .addEventListener("click", () => editorPanel.querySelector("[data-mcp-editor-cancel]").click());
  const editor = { kind: "stdio", previous: undefined, base: {}, exposure: "deferred", busy: false };
  const ed = (selector) => editorPanel.querySelector(selector);

  function editorError(message) {
    ed("[data-mcp-editor-error]").textContent = message;
    ed("[data-mcp-editor-error]").hidden = !message;
  }
  function testResult(text, ok) {
    const line = ed("[data-mcp-test-result]");
    line.textContent = text;
    line.hidden = !text;
    line.classList.toggle("is-ok", Boolean(ok));
  }

  function pairRow(key = "", value = "") {
    return `<div class="mcp-pair-row">
        <input data-mcp-pair-key aria-label="${esc(ui("名称"))}" value="${esc(key)}" autocomplete="off" spellcheck="false">
        <input data-mcp-pair-value aria-label="${esc(ui("值"))}" value="${esc(value)}" placeholder="\${API_KEY}" autocomplete="off" spellcheck="false">
        <button class="settings-icon-button" type="button" data-mcp-pair-remove aria-label="${esc(ui("移除"))}">${icon("close")}</button>
      </div>`;
  }

  function renderEditor() {
    for (const button of editorPanel.querySelectorAll("[data-mcp-kind-value]"))
      button.setAttribute("aria-checked", String(button.dataset.mcpKindValue === editor.kind));
    // Editing keeps the connection kind; only a new server can switch it or import.
    for (const button of editorPanel.querySelectorAll("[data-mcp-kind-value]"))
      button.disabled = Boolean(editor.previous) && button.dataset.mcpKindValue !== editor.kind;
    for (const field of editorPanel.querySelectorAll("[data-mcp-only]"))
      field.hidden = !field.dataset.mcpOnly.split(" ").includes(editor.kind);
    for (const button of editorPanel.querySelectorAll("[data-mcp-default-value]"))
      button.setAttribute("aria-checked", String(button.dataset.mcpDefaultValue === editor.exposure));
    ed("[data-mcp-pairs-label]").textContent = editor.kind === "http" ? ui("请求头") : ui("环境变量");
    ed("[data-mcp-pair-add-label]").textContent = editor.kind === "http" ? ui("添加请求头") : ui("添加变量");
    ed("[data-mcp-test]").hidden = editor.kind === "json";
    ed("[data-mcp-test]").disabled = editor.busy;
    ed("[data-mcp-save]").disabled = editor.busy;
    ed("[data-mcp-save]").textContent = editor.kind === "json" ? ui("导入") : ui("保存");
  }

  function setPairs(map) {
    ed("[data-mcp-pairs]").innerHTML = Object.entries(map ?? {})
      .map(([key, value]) => pairRow(key, value))
      .join("");
  }

  function openEditor(server, kind = "stdio") {
    editor.previous = server?.name;
    editor.kind = server ? server.kind : kind;
    const config = server?.config ?? {};
    editor.base = config;
    editor.exposure = config.exposure ?? "deferred";
    editor.busy = false;
    ed("[data-mcp-editor-title]").textContent = server ? ui`编辑 ${server.name}` : ui("新建 MCP 服务");
    ed("[data-mcp-name]").value = server?.name ?? "";
    ed("[data-mcp-command]").value = config.command ?? "";
    ed("[data-mcp-args]").value = (config.args ?? []).join("\n");
    ed("[data-mcp-url]").value = config.url ?? "";
    ed("[data-mcp-cwd]").value = config.cwd ?? "";
    ed("[data-mcp-json]").value = "";
    ed("[data-mcp-replace]").checked = false;
    setPairs(editor.kind === "http" ? config.headers : config.env);
    editorError("");
    testResult("");
    renderEditor();
    editorModal.open();
    ed(editor.kind === "json" ? "[data-mcp-json]" : "[data-mcp-name]").focus();
  }

  function draft() {
    const name = ed("[data-mcp-name]").value.trim();
    if (!name) throw new Error(ui("请填写名称"));
    const pairs = Object.fromEntries(
      [...editorPanel.querySelectorAll(".mcp-pair-row")]
        .map((row) => [
          row.querySelector("[data-mcp-pair-key]").value.trim(),
          row.querySelector("[data-mcp-pair-value]").value
        ])
        .filter(([key]) => key)
    );
    // Fields this form does not show (description, timeout, oauth, per-tool
    // exposure, enabled) are kept from the saved entry.
    const {
      command: _c,
      args: _a,
      env: _e,
      cwd: _w,
      url: _u,
      headers: _h,
      exposure: _x,
      type: _t,
      ...kept
    } = editor.base;
    const config = { ...kept };
    if (editor.kind === "http") {
      config.url = ed("[data-mcp-url]").value.trim();
      if (!config.url) throw new Error(ui("请填写地址"));
      if (Object.keys(pairs).length) config.headers = pairs;
    } else {
      config.command = ed("[data-mcp-command]").value.trim();
      if (!config.command) throw new Error(ui("请填写命令"));
      const args = ed("[data-mcp-args]")
        .value.split("\n")
        .map((arg) => arg.trim())
        .filter(Boolean);
      if (args.length) config.args = args;
      if (Object.keys(pairs).length) config.env = pairs;
      const cwd = ed("[data-mcp-cwd]").value.trim();
      if (cwd) config.cwd = cwd;
    }
    if (editor.exposure !== "deferred") config.exposure = editor.exposure;
    return { name, config };
  }

  async function testDraft() {
    editorError("");
    testResult("");
    let input;
    try {
      input = draft();
    } catch (error) {
      editorError(error.message);
      return;
    }
    editor.busy = true;
    renderEditor();
    testResult(ui("正在连接…"));
    try {
      const status = await post("/api/mcp/test", input);
      const seconds = ((status.durationMs ?? 0) / 1000).toFixed(1);
      if (status.state === "connected")
        testResult(ui`连接成功：${status.tools.length} 个工具，用时 ${seconds} 秒`, true);
      else if (status.state === "needs-auth") testResult(ui("可以连接，保存后需要登录"), true);
      else testResult(ui`连接失败：${status.error ?? ""}`);
    } catch (error) {
      testResult("");
      editorError(error?.message || ui("检查连接失败"));
    } finally {
      editor.busy = false;
      renderEditor();
    }
  }

  async function saveEditor() {
    editorError("");
    editor.busy = true;
    renderEditor();
    try {
      if (editor.kind === "json") {
        const text = ed("[data-mcp-json]").value.trim();
        if (!text) throw new Error(ui("请粘贴 JSON"));
        const result = await post("/api/mcp/import", { text, replace: ed("[data-mcp-replace]").checked });
        accept(result);
        view.selected = result.imported[0] ?? view.selected;
        showToast(ui`已导入 ${result.imported.length} 个服务`);
      } else {
        const input = draft();
        accept(
          await post("/api/mcp/save", {
            ...input,
            ...(editor.previous ? { previousName: editor.previous } : {})
          })
        );
        view.selected = input.name;
        showToast(ui("已保存"));
      }
      editorModal.close();
      render();
      void check();
    } catch (error) {
      editorError(error?.message || ui("保存未完成"));
    } finally {
      editor.busy = false;
      renderEditor();
    }
  }

  ed("[data-mcp-kind]").addEventListener("click", (event) => {
    const button = event.target.closest("[data-mcp-kind-value]");
    if (!button || button.disabled || button.dataset.mcpKindValue === editor.kind) return;
    editor.kind = button.dataset.mcpKindValue;
    setPairs({});
    editorError("");
    testResult("");
    renderEditor();
  });
  ed("[data-mcp-default-exposure]").addEventListener("click", (event) => {
    const button = event.target.closest("[data-mcp-default-value]");
    if (!button) return;
    editor.exposure = button.dataset.mcpDefaultValue;
    renderEditor();
  });
  ed("[data-mcp-pair-add]").addEventListener("click", () => {
    ed("[data-mcp-pairs]").insertAdjacentHTML("beforeend", pairRow());
    ed("[data-mcp-pairs] .mcp-pair-row:last-child [data-mcp-pair-key]").focus();
  });
  ed("[data-mcp-pairs]").addEventListener("click", (event) => {
    event.target.closest("[data-mcp-pair-remove]")?.closest(".mcp-pair-row")?.remove();
  });
  ed("[data-mcp-form]").addEventListener("submit", (event) => {
    event.preventDefault();
    void saveEditor();
  });
  ed("[data-mcp-test]").addEventListener("click", () => void testDraft());
  ed("[data-mcp-save]").addEventListener("click", () => void saveEditor());

  /* ---------------------------------------------------------------- wiring */

  $("[data-mcp-add]").addEventListener("click", () => openEditor(undefined, "stdio"));
  $("[data-mcp-import]").addEventListener("click", () => openEditor(undefined, "json"));
  $("[data-mcp-filters]").addEventListener("click", (event) => {
    const button = event.target.closest("[data-mcp-filter]");
    if (!button) return;
    view.filter = button.dataset.mcpFilter;
    view.page = 1;
    render();
  });
  $("[data-mcp-search]").addEventListener("input", (event) => {
    view.query = event.target.value;
    view.page = 1;
    render();
  });
  $("[data-mcp-list]").addEventListener("click", (event) => {
    const row = event.target.closest("[data-mcp-select]");
    if (!row) return;
    if (row.dataset.mcpSelect !== view.selected) view.toolsOpen = false;
    view.selected = row.dataset.mcpSelect;
    render();
  });
  $("[data-mcp-pager]").addEventListener("click", (event) => {
    const button = event.target.closest("[data-mcp-page]");
    if (!button) return;
    view.page += Number(button.dataset.mcpPage);
    render();
  });
  const detail = $("[data-mcp-detail]");
  detail.addEventListener("click", (event) => {
    const server = selectedServer();
    if (!server) return;
    const action = event.target.closest("[data-mcp-action]");
    if (action) return void act(action.dataset.mcpAction);
    if (event.target.closest("[data-mcp-tools-fold]")) {
      view.toolsOpen = !view.toolsOpen;
      renderDetail();
      detail.querySelector("[data-mcp-tools-fold]")?.focus();
      return;
    }
    if (event.target.closest("[data-mcp-enabled]"))
      return void change(
        "/api/mcp/enabled",
        { name: server.name, enabled: !server.enabled },
        server.enabled ? ui("已停用") : ui("已启用")
      ).then(() => (server.enabled ? undefined : check([server.name])));
    const exposure = event.target.closest("[data-mcp-exposure]");
    if (exposure && exposure.dataset.mcpExposure !== server.exposure)
      void change("/api/mcp/exposure", { name: server.name, exposure: exposure.dataset.mcpExposure });
  });
  detail.addEventListener("change", (event) => {
    const select = event.target.closest("[data-mcp-tool]");
    const server = selectedServer();
    if (!select || !server) return;
    void change("/api/mcp/exposure", {
      name: server.name,
      tools: { [select.dataset.mcpTool]: select.value || null }
    });
  });

  onSection("mcp", () => void load());

  return { refresh: load };
}
