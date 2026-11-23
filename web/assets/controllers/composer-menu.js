import { escapeHtml as esc } from "../ui/html.js";
import { icon } from "../ui/icons.js";
import {
  agentIcon,
  commandIcon,
  fileTypeIcon,
  promptIcon,
  resourceIcon,
  skillIcon
} from "../ui/reference-icons.js";
import { ui } from "../ui/language.js";
import { findReferences, referenceToken } from "../references.js";
import { createComposerRichEditor } from "./composer-rich.js";

/**
 * The composer's `/` and `@` menus. `/` offers skills (the message asks Main
 * to load one first), prompt templates (chosen, they become the words of the
 * draft) and commands; `@` offers project files, Agents and MCP resources. A
 * choice leaves its canonical word in the draft — `/skill`, `@path`, `@agent`,
 * `@server:uri` — rendered inline as a clean icon + name chip, and `references()`
 * turns the words back into what the message sends.
 */

const SOURCE_LABELS = {
  project: "项目",
  "project-agents": ".agents",
  global: "全局",
  "global-agents": "通用",
  bundled: "自带"
};
const PROMPT_SOURCES = { project: ".atria/prompts", global: "~/.atria/prompts" };
const SLASH_TTL_MS = 10_000;
const RESOURCE_TTL_MS = 60_000;
const GROUP_LIMIT = 8;
/** The word being typed at the caret, if it starts with `/` or `@`. */
const TRIGGER = /(^|[\s(（])([/@])([^\s]*)$/;

/** How well a name fits the query, lower first: starts with it, contains it, has its letters in order. */
function rank(value, query) {
  if (!query) return 0;
  const haystack = value.toLowerCase();
  const needle = query.toLowerCase();
  if (haystack.startsWith(needle)) return 0;
  if (haystack.includes(needle)) return 1;
  let at = 0;
  for (const char of needle) {
    at = haystack.indexOf(char, at) + 1;
    if (!at) return undefined;
  }
  return 2;
}

/** The entries that fit the query, best first, keeping their own order within a rank. */
function ranked(entries, key, query) {
  return entries
    .map((entry, index) => ({ entry, index, score: rank(key(entry), query) }))
    .filter((item) => item.score !== undefined)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((item) => item.entry);
}

/** The query's letters in bold where they first match, as the design shows `/pg`. */
function marked(label, query) {
  const at = query ? label.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return esc(label);
  return `${esc(label.slice(0, at))}<b>${esc(label.slice(at, at + query.length))}</b>${esc(label.slice(at + query.length))}`;
}

export function createComposerMenu({ input, container, api, getProjectId, commands, onError }) {
  const menu = document.createElement("div");
  menu.className = "composer-menu";
  menu.id = "composer-menu";
  menu.setAttribute("role", "listbox");
  menu.hidden = true;
  container.append(menu);
  input.setAttribute("aria-controls", menu.id);
  input.setAttribute("aria-autocomplete", "list");

  const known = { skills: new Set(), servers: new Set(), files: new Set(), agents: new Set() };
  const resourceNames = new Map();
  const agentCache = new Map();
  const slashCache = new Map();
  let resourceCache;
  let trigger;
  let items = [];
  let active = 0;
  let fileTimer;
  let generation = 0;

  function setAria(name, value) {
    for (const target of [input, editor.element]) {
      if (value === null) target.removeAttribute(name);
      else target.setAttribute(name, value);
    }
  }

  function handleMenuKeydown(event) {
    if (event.isComposing) return false;
    if (menu.hidden) {
      if (event.key === "Backspace" && !event.altKey && !event.metaKey && !event.ctrlKey) {
        return deleteWord(event);
      }
      return false;
    }
    const handled = () => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      handled();
      if (!items.length) return true;
      active = (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      syncActive();
      return true;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      if (!items.length) {
        if (event.key !== "Tab") close();
        return false;
      }
      handled();
      choose(active);
      return true;
    }
    if (event.key === "Escape") {
      handled();
      close();
      return true;
    }
    return false;
  }

  const editor = createComposerRichEditor({
    input,
    references: (text) => findReferences(text, known),
    resourceNames,
    onTriggerUpdate: update,
    onKeydown: handleMenuKeydown,
    onBlur: scheduleBlurClose
  });
  editor.element.setAttribute("aria-controls", menu.id);
  editor.element.setAttribute("aria-autocomplete", "list");

  function scheduleBlurClose() {
    setTimeout(() => {
      if (document.activeElement !== input && document.activeElement !== editor.element) close();
    }, 150);
  }

  async function slashData(projectId) {
    const key = projectId ?? "";
    const cached = slashCache.get(key);
    if (cached && Date.now() - cached.at < SLASH_TTL_MS) return cached.data;
    const data = api(`/api/composer/slash${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
    slashCache.set(key, { at: Date.now(), data });
    data.then(
      (value) => {
        value.skills.forEach((skill) => known.skills.add(skill.name));
        editor.refresh();
      },
      () => slashCache.delete(key)
    );
    return data;
  }

  async function agentData(projectId) {
    const key = projectId ?? "";
    const cached = agentCache.get(key);
    if (cached && Date.now() - cached.at < SLASH_TTL_MS) return cached.data;
    const data = api(`/api/composer/agents${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
    agentCache.set(key, { at: Date.now(), data });
    data.then(
      (value) => {
        value.agents.forEach((agent) => known.agents.add(agent.name));
        editor.refresh();
      },
      () => agentCache.delete(key)
    );
    return data;
  }

  async function resourceData() {
    if (resourceCache && Date.now() - resourceCache.at < RESOURCE_TTL_MS) return resourceCache.data;
    const data = api("/api/composer/resources");
    resourceCache = { at: Date.now(), data };
    data.then(
      (value) => {
        value.resources.forEach((resource) => {
          known.servers.add(resource.server);
          if (resource.name) resourceNames.set(`${resource.server}:${resource.uri}`, resource.name);
        });
        editor.refresh();
      },
      () => (resourceCache = undefined)
    );
    return data;
  }

  function close() {
    generation += 1;
    clearTimeout(fileTimer);
    trigger = undefined;
    items = [];
    menu.hidden = true;
    menu.innerHTML = "";
    setAria("aria-expanded", "false");
    setAria("aria-activedescendant", null);
  }

  function syncActive() {
    if (!items.length) {
      setAria("aria-activedescendant", null);
      return;
    }
    const previous = menu.querySelector(".composer-menu-item.is-active");
    if (previous) {
      previous.classList.remove("is-active");
      previous.setAttribute("aria-selected", "false");
    }
    const current = menu.querySelector(`#composer-menu-${active}`);
    if (current) {
      current.classList.add("is-active");
      current.setAttribute("aria-selected", "true");
      current.scrollIntoView({ block: "nearest" });
    }
    setAria("aria-activedescendant", `composer-menu-${active}`);
  }

  function render() {
    if (!trigger) return;
    if (!items.length) {
      menu.innerHTML = `<div class="composer-menu-empty">${esc(trigger.kind === "/" ? ui("没有匹配的技能、模板或命令") : ui("没有匹配的文件、Agent 或资源"))}</div>`;
    } else {
      let group;
      const rows = items
        .map((item, index) => {
          const header =
            item.group !== group
              ? `<div class="composer-menu-group" role="presentation">${esc(item.group)}</div>`
              : "";
          group = item.group;
          const itemIcon = item.iconHtml ?? icon(item.icon);
          return `${header}<div class="composer-menu-item${index === active ? " is-active" : ""}" role="option" id="composer-menu-${index}" data-menu-index="${index}" aria-selected="${index === active}"><span class="composer-menu-icon${item.iconTone ? ` is-${item.iconTone}` : ""}" aria-hidden="true">${itemIcon}</span><span class="composer-menu-main"><span class="composer-menu-label">${marked(item.label, trigger.query)}</span>${item.detail ? `<span class="composer-menu-detail">${esc(item.detail)}</span>` : ""}</span>${item.badge ? `<span class="composer-menu-badge">${esc(item.badge)}</span>` : ""}</div>`;
        })
        .join("");
      menu.innerHTML =
        `<div class="composer-menu-list" role="presentation">${rows}</div>` +
        `<div class="composer-menu-keys" aria-hidden="true"><span>${esc(ui("↑↓ 选择"))}</span><span>${esc(trigger.kind === "/" ? ui("↩ 插入") : ui("↩ 引用"))}</span><span>${esc(ui("Tab 补全"))}</span><span>${esc(ui("Esc 关闭"))}</span></div>`;
    }
    menu.hidden = false;
    setAria("aria-expanded", "true");
    if (items.length) {
      setAria("aria-activedescendant", `composer-menu-${active}`);
      menu.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
    } else {
      setAria("aria-activedescendant", null);
    }
  }

  function slashItems(data, query) {
    const skills = ranked(data.skills, (skill) => skill.name, query)
      .slice(0, GROUP_LIMIT)
      .map((skill) => ({
        group: ui("技能"),
        iconHtml: skillIcon(),
        iconTone: "ref",
        label: `/${skill.name}`,
        detail: skill.description,
        badge: ui(SOURCE_LABELS[skill.source] ?? skill.source),
        insert: `/${skill.name} `
      }));
    const prompts = ranked(data.prompts, (prompt) => prompt.name, query)
      .slice(0, GROUP_LIMIT)
      .map((prompt) => ({
        group: ui("指令模板"),
        iconHtml: promptIcon(),
        label: `/${prompt.name}`,
        detail: prompt.description,
        badge: PROMPT_SOURCES[prompt.source],
        insert: prompt.body
      }));
    const actions = ranked(commands, (command) => command.name, query).map((command) => ({
      group: ui("命令"),
      iconHtml: command.icon ? icon(command.icon) : commandIcon(),
      label: `/${command.name}`,
      detail: command.description,
      run: command.run
    }));
    return [...skills, ...prompts, ...actions];
  }

  function atItems(files, agents, resources, query) {
    const fileItems = files.map((path) => {
      const slash = path.lastIndexOf("/");
      return {
        group: ui("文件"),
        iconHtml: fileTypeIcon(path),
        iconTone: "ref",
        label: path.slice(slash + 1),
        detail: slash >= 0 ? path.slice(0, slash + 1) : "",
        insert: `@${path} `,
        file: path
      };
    });
    const resourceItems = ranked(
      resources,
      (resource) => `${resource.name} ${resource.uri} ${resource.server}`,
      query
    )
      .slice(0, GROUP_LIMIT)
      .map((resource) => ({
        group: ui("MCP 资源"),
        iconHtml: resourceIcon(),
        iconTone: "ref",
        label: `${resource.server} · ${resource.name}`,
        detail: resource.uri,
        badge: resource.server,
        insert: `${referenceToken({ kind: "mcp_resource", ...resource })} `
      }));
    const agentItems = ranked(agents, (agent) => agent.name, query)
      .slice(0, GROUP_LIMIT)
      .map((agent) => ({
        group: "Agent",
        iconHtml: agentIcon(),
        iconTone: "ref",
        label: agent.name,
        detail: agent.description,
        badge: agent.permission === "write" ? ui("可写") : ui("只读"),
        insert: `@${agent.name} `
      }));
    return [...fileItems, ...agentItems, ...resourceItems];
  }

  async function refresh() {
    const current = trigger;
    if (!current) return;
    const ticket = ++generation;
    try {
      if (current.kind === "/") {
        const data = await slashData(getProjectId());
        if (ticket !== generation) return;
        items = slashItems(data, current.query);
      } else {
        const projectId = getProjectId();
        // MCP servers can take seconds to list resources; files and Agents show first.
        const resources = resourceData().then(
          (value) => value.resources,
          (error) => {
            onError(ui`MCP 资源读取失败：${error.message}`);
            return [];
          }
        );
        let listed;
        void resources.then((found) => (listed = found));
        const [files, agents] = await Promise.all([
          projectId
            ? api(
                `/api/composer/files?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(current.query)}`
              )
            : { files: [] },
          agentData(projectId)
        ]);
        if (ticket !== generation) return;
        items = atItems(files.files, agents.agents, listed ?? [], current.query);
        if (!listed)
          void resources.then((found) => {
            if (ticket !== generation || !found.length) return;
            items = atItems(files.files, agents.agents, found, current.query);
            active = Math.min(active, Math.max(items.length - 1, 0));
            render();
          });
      }
      active = Math.min(active, Math.max(items.length - 1, 0));
      render();
    } catch (error) {
      if (ticket !== generation) return;
      close();
      onError(ui`菜单加载失败：${error.message}`);
    }
  }

  function update() {
    const sel = editor.getSelection();
    if (sel.start !== sel.end || input.readOnly) return close();
    const before = editor.getValue().slice(0, sel.start);
    const match = TRIGGER.exec(before);
    if (!match) return close();
    const next = { kind: match[2], query: match[3], start: before.length - match[3].length - 1 };
    const changed = !trigger || trigger.kind !== next.kind || trigger.start !== next.start;
    if (!changed && trigger.query === next.query) return;
    active = 0;
    trigger = next;
    clearTimeout(fileTimer);
    // File search runs on the backend; a short pause keeps one request per word, not per letter.
    if (next.kind === "@" && !changed) fileTimer = setTimeout(() => void refresh(), 120);
    else void refresh();
  }

  function choose(index) {
    const item = items[index];
    const current = trigger;
    if (!item || !current) return;
    const end = current.start + 1 + current.query.length;
    const text = editor.getValue();
    const after = text.slice(end);
    close();
    if (item.run) {
      const stripSpace = after.startsWith(" ") ? 1 : 0;
      editor.replaceRange(current.start, end + stripSpace, "", { focus: true, commitAll: false });
      item.run();
      return;
    }
    if (item.file) known.files.add(item.file);
    editor.replaceRange(current.start, end, item.insert, { focus: true, commitAll: true });
  }

  /** Backspace right after a referenced word takes the whole word, as it would a chip. */
  function deleteWord(event) {
    const sel = editor.getSelection();
    if (sel.start !== sel.end || !sel.start) return false;
    const before = editor.getValue().slice(0, sel.start);
    const match = /(^|\s)([/@][^\s]+) ?$/.exec(before);
    if (!match || !findReferences(match[2], known).length) return false;
    event.preventDefault();
    const start = before.length - match[0].length + match[1].length;
    editor.replaceRange(start, sel.start, "", { focus: true, commitAll: false });
    return true;
  }

  // Capture runs before the composer's own Enter-to-send handler on the same element.
  input.addEventListener("keydown", (event) => handleMenuKeydown(event), true);
  input.addEventListener("input", update);
  input.addEventListener("click", update);
  input.addEventListener("blur", scheduleBlurClose);
  menu.addEventListener("mousedown", (event) => event.preventDefault());
  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-menu-index]");
    if (option) choose(Number(option.dataset.menuIndex));
  });

  return {
    close,
    get open() {
      return !menu.hidden;
    },
    /** What the draft references, by the words in it. */
    references(text) {
      return findReferences(text, known);
    },
    /** Learn the skill names and MCP servers before a restored draft is sent. */
    async prepare() {
      await Promise.all([slashData(getProjectId()), agentData(getProjectId()), resourceData()]);
    }
  };
}
