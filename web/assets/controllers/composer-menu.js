import { escapeHtml as esc } from "../ui/html.js";
import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { findReferences, referenceToken } from "../references.js";

/**
 * The composer's `/` and `@` menus. `/` offers skills (the message asks Main
 * to load one first), prompt templates (chosen, they become the words of the
 * draft) and commands; `@` offers project files and MCP resources. A choice
 * leaves its word in the draft — `/skill`, `@path`, `@server:uri` — and
 * `references()` turns the words back into what the message sends.
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

  const known = { skills: new Set(), servers: new Set(), files: new Set() };
  const slashCache = new Map();
  let resourceCache;
  let trigger;
  let items = [];
  let active = 0;
  let fileTimer;
  let generation = 0;

  async function slashData(projectId) {
    const key = projectId ?? "";
    const cached = slashCache.get(key);
    if (cached && Date.now() - cached.at < SLASH_TTL_MS) return cached.data;
    const data = api(`/api/composer/slash${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
    slashCache.set(key, { at: Date.now(), data });
    data.then(
      (value) => value.skills.forEach((skill) => known.skills.add(skill.name)),
      () => slashCache.delete(key)
    );
    return data;
  }

  async function resourceData() {
    if (resourceCache && Date.now() - resourceCache.at < RESOURCE_TTL_MS) return resourceCache.data;
    const data = api("/api/composer/resources");
    resourceCache = { at: Date.now(), data };
    data.then(
      (value) => value.resources.forEach((resource) => known.servers.add(resource.server)),
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
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function render() {
    if (!trigger) return;
    if (!items.length) {
      menu.innerHTML = `<div class="composer-menu-empty">${esc(trigger.kind === "/" ? ui("没有匹配的技能、模板或命令") : ui("没有匹配的文件或资源"))}</div>`;
    } else {
      let group;
      menu.innerHTML =
        items
          .map((item, index) => {
            const header =
              item.group !== group
                ? `<div class="composer-menu-group" role="presentation">${esc(item.group)}</div>`
                : "";
            group = item.group;
            return `${header}<div class="composer-menu-item${index === active ? " is-active" : ""}" role="option" id="composer-menu-${index}" data-menu-index="${index}" aria-selected="${index === active}">${icon(item.icon)}<span class="composer-menu-main"><span class="composer-menu-label">${marked(item.label, trigger.query)}</span>${item.detail ? `<span class="composer-menu-detail">${esc(item.detail)}</span>` : ""}</span>${item.badge ? `<span class="composer-menu-badge">${esc(item.badge)}</span>` : ""}</div>`;
          })
          .join("") +
        `<div class="composer-menu-keys" aria-hidden="true"><span>${esc(ui("↑↓ 选择"))}</span><span>${esc(trigger.kind === "/" ? ui("↩ 插入") : ui("↩ 引用"))}</span><span>${esc(ui("Tab 补全"))}</span><span>${esc(ui("Esc 关闭"))}</span></div>`;
    }
    menu.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (items.length) input.setAttribute("aria-activedescendant", `composer-menu-${active}`);
    else input.removeAttribute("aria-activedescendant");
    menu.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }

  function slashItems(data, query) {
    const skills = ranked(data.skills, (skill) => skill.name, query)
      .slice(0, GROUP_LIMIT)
      .map((skill) => ({
        group: ui("技能"),
        icon: "sparkles",
        label: `/${skill.name}`,
        detail: skill.description,
        badge: ui(SOURCE_LABELS[skill.source] ?? skill.source),
        insert: `/${skill.name} `
      }));
    const prompts = ranked(data.prompts, (prompt) => prompt.name, query)
      .slice(0, GROUP_LIMIT)
      .map((prompt) => ({
        group: ui("指令模板"),
        icon: "text",
        label: `/${prompt.name}`,
        detail: prompt.description,
        badge: PROMPT_SOURCES[prompt.source],
        insert: prompt.body
      }));
    const actions = ranked(commands, (command) => command.name, query).map((command) => ({
      group: ui("命令"),
      icon: "command",
      label: `/${command.name}`,
      detail: command.description,
      run: command.run
    }));
    return [...skills, ...prompts, ...actions];
  }

  function atItems(files, resources, query) {
    const fileItems = files.map((path) => {
      const slash = path.lastIndexOf("/");
      return {
        group: ui("文件"),
        icon: "file",
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
        icon: "database",
        label: `${resource.server} · ${resource.name}`,
        detail: resource.uri,
        badge: resource.server,
        insert: `${referenceToken({ kind: "mcp_resource", ...resource })} `
      }));
    return [...fileItems, ...resourceItems];
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
        const [files, resources] = await Promise.all([
          projectId
            ? api(
                `/api/composer/files?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(current.query)}`
              )
            : { files: [] },
          resourceData()
        ]);
        if (ticket !== generation) return;
        items = atItems(files.files, resources.resources, current.query);
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
    if (input.selectionStart !== input.selectionEnd || input.readOnly) return close();
    const before = input.value.slice(0, input.selectionStart);
    const match = TRIGGER.exec(before);
    if (!match) return close();
    const next = { kind: match[2], query: match[3], start: before.length - match[3].length - 1 };
    const changed = !trigger || trigger.kind !== next.kind || trigger.start !== next.start;
    if (!changed && trigger.query === next.query) return;
    if (changed) active = 0;
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
    const before = input.value.slice(0, current.start);
    const after = input.value.slice(end);
    close();
    if (item.run) {
      input.value = before + after.replace(/^ /, "");
      input.setSelectionRange(before.length, before.length);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      item.run();
      return;
    }
    if (item.file) known.files.add(item.file);
    input.value = before + item.insert + after;
    const caret = before.length + item.insert.length;
    input.setSelectionRange(caret, caret);
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Backspace right after a referenced word takes the whole word, as it would a chip. */
  function deleteWord(event) {
    if (input.selectionStart !== input.selectionEnd || !input.selectionStart) return;
    const before = input.value.slice(0, input.selectionStart);
    const match = /(^|\s)([/@][^\s]+) ?$/.exec(before);
    if (!match || !findReferences(match[2], known).length) return;
    event.preventDefault();
    const start = before.length - match[0].length + match[1].length;
    input.value = input.value.slice(0, start) + input.value.slice(input.selectionStart);
    input.setSelectionRange(start, start);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Capture runs before the composer's own Enter-to-send handler on the same element.
  input.addEventListener(
    "keydown",
    (event) => {
      if (event.isComposing) return;
      if (menu.hidden) {
        if (event.key === "Backspace" && !event.altKey && !event.metaKey && !event.ctrlKey) deleteWord(event);
        return;
      }
      const handled = () => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        handled();
        if (!items.length) return;
        active = (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        render();
      } else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        if (!items.length) return event.key === "Tab" ? undefined : close();
        handled();
        choose(active);
      } else if (event.key === "Escape") {
        handled();
        close();
      }
    },
    true
  );
  input.addEventListener("input", update);
  input.addEventListener("click", update);
  input.addEventListener("blur", () => setTimeout(() => document.activeElement !== input && close(), 150));
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
      await Promise.all([slashData(getProjectId()), resourceData()]);
    }
  };
}
