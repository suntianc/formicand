import { createMenu } from "../ui/menu.js";
import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../ui/html.js";

const FINDER_ID = "finder";

/**
 * Crisp inline macOS Finder squircle icon. Rendering inline SVG keeps the main
 * Open button completely fixed across file switches with zero IPC wait or image
 * decode flicker, while per-file apps load quietly in the background for the menu.
 */
function finderIcon() {
  return (
    '<svg class="open-with-icon open-with-finder" viewBox="0 0 18 18" fill="none" aria-hidden="true" focusable="false">' +
    '<rect x="1" y="1" width="16" height="16" rx="4" fill="#2B93F7"/>' +
    '<path d="M9.6 1H13a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H9.4c-1.15-2.6-1.45-5.35-.75-7.75h1.55C9.45 6.45 9.35 3.65 9.6 1Z" fill="#EAF4FF"/>' +
    '<path d="M9.55 1.15c-.25 2.5-.15 5.25.6 8.05H8.6c-.7 2.4-.4 5.15.75 7.65" stroke="#1B6FD0" stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M5.75 5.9v1.85M12.25 5.9v1.85" stroke="#183A63" stroke-width="1.35" stroke-linecap="round"/>' +
    '<path d="M5.35 11.45c1.1 1.1 2.35 1.65 3.65 1.65s2.55-.55 3.65-1.65" stroke="#183A63" stroke-width="1.25" stroke-linecap="round"/>' +
    "</svg>"
  );
}

/**
 * The preview's "Open" split button, desktop only: the main half is fixed to
 * Finder (revealing the file without flickering across file switches), and the
 * arrow lists the applications installed on this Mac that can open it, loaded
 * quietly in the background.
 */
export function createOpenWith({ bridge, showToast }) {
  const lists = new Map();
  let menu, panel, current;
  let openTicket = 0;

  function key(taskId, target) {
    return JSON.stringify([taskId, target.source, target.path, target.developmentId ?? ""]);
  }

  /** Starts loading the file's applications once in the background without redrawing the button. */
  function loadApps(taskId, target) {
    const id = key(taskId, target);
    const existing = lists.get(id);
    if (existing && existing.status !== "error") return existing;
    const entry = { status: "loading", apps: [], promise: null };
    entry.promise = bridge
      .apps(taskId, target)
      .then((result) => {
        const ready = { status: "ready", apps: Array.isArray(result?.apps) ? result.apps : [] };
        if (lists.get(id) === entry) lists.set(id, ready);
        return ready;
      })
      // eslint-disable-next-line no-restricted-syntax -- a failed lookup still lets Finder open the file and retries on the next menu click
      .catch(() => {
        const failed = { status: "error", apps: [] };
        if (lists.get(id) === entry) lists.set(id, failed);
        return failed;
      });
    lists.set(id, entry);
    return entry;
  }

  function appIcon(entry) {
    return entry?.icon
      ? `<img class="open-with-icon" src="${esc(entry.icon)}" alt="" decoding="sync" draggable="false" />`
      : icon("open-app");
  }

  /** The split button, or nothing outside the desktop or without a file. */
  function markup(taskId, target) {
    if (!bridge || !target) return "";
    // Warm the app list in the background so opening the menu is instant.
    loadApps(taskId, target);
    const label = ui("在访达中显示");
    return `<div class="drawer-open-with"><button type="button" class="drawer-action drawer-open-main" data-open-main title="${esc(
      label
    )}" aria-label="${esc(label)}">${finderIcon()}<span>${ui("打开")}</span></button><button type="button" class="drawer-action is-icon drawer-open-more" data-open-more aria-haspopup="menu" aria-expanded="false" aria-label="${ui(
      "选择打开方式"
    )}" title="${ui("选择打开方式")}">${icon("chevron-down")}</button></div>`;
  }

  async function open(taskId, target, appId) {
    try {
      await bridge.open(taskId, target, appId || undefined);
    } catch (error) {
      showToast(error.message);
    }
  }

  /** The system's own choice goes through the system, not by application path. */
  function appIdOf(entry) {
    return entry && entry.kind !== "default" ? entry.id : "";
  }

  function item(entry) {
    const name = entry.kind === "default" ? ui("默认应用") : entry.name;
    return `<button type="button" role="menuitem" data-open-app="${esc(appIdOf(entry))}" title="${esc(entry.name)}">${appIcon(
      entry
    )}<span data-menu-label>${esc(name)}</span></button>`;
  }

  function fill(listed) {
    const main = listed.filter((entry) => entry.kind !== "app");
    const others = listed.filter((entry) => entry.kind === "app");
    const head = main.filter((entry) => entry.kind !== "terminal");
    const terminals = main.filter((entry) => entry.kind === "terminal");
    panel.innerHTML = `<div class="session-menu-main">${head.map(item).join("")}${
      others.length
        ? `<button type="button" role="menuitem" data-open-others aria-expanded="false">${icon(
            "apps"
          )}<span data-menu-label>${ui("其他应用")}</span>${icon("chevron-right", "open-with-more")}</button><div class="open-with-others" hidden>${others
            .map(item)
            .join("")}</div>`
        : ""
    }${terminals.length ? `<div class="session-menu-separator" role="separator"></div>${terminals.map(item).join("")}` : ""}</div>`;
  }

  function ensureMenu(trigger) {
    if (panel) return menu.setTrigger(trigger);
    panel = document.createElement("div");
    panel.className = "session-menu conversation-context-menu open-with-menu";
    panel.setAttribute("role", "menu");
    panel.setAttribute("aria-label", ui("选择打开方式"));
    panel.hidden = true;
    document.body.append(panel);
    menu = createMenu(trigger, panel, { toggleOnClick: false, closeOnSelect: false });
    panel.addEventListener("click", (event) => {
      const others = event.target.closest("[data-open-others]");
      if (others) {
        const group = panel.querySelector(".open-with-others");
        group.hidden = !group.hidden;
        others.setAttribute("aria-expanded", String(!group.hidden));
        if (!group.hidden) group.querySelector("button")?.focus();
        return;
      }
      const appId = event.target.closest("[data-open-app]")?.dataset.openApp;
      if (appId === undefined || !current) return;
      const { taskId, target } = current;
      menu.close(true);
      void open(taskId, target, appId);
    });
  }

  function showMenu(trigger, taskId, target, appsList) {
    ensureMenu(trigger);
    current = { taskId, target };
    fill(appsList);
    menu.open();
    const anchor = trigger.getBoundingClientRect(),
      { width, height } = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(anchor.bottom + 4, innerHeight - height - 8))}px`;
  }

  /** Wires the button rendered by `markup` inside `container`. */
  function bind(container, taskId, target) {
    if (!bridge || !target) return;
    container.querySelector("[data-open-main]")?.addEventListener("click", () => {
      void open(taskId, target, FINDER_ID);
    });
    const more = container.querySelector("[data-open-more]");
    more?.addEventListener("click", async () => {
      if (panel && !panel.hidden) {
        openTicket += 1;
        menu.close(true);
        return;
      }
      const ticket = ++openTicket;
      const loaded = loadApps(taskId, target);
      const resolved = loaded.status === "loading" ? await loaded.promise : loaded;
      if (ticket !== openTicket || !more.isConnected || !resolved.apps.length) return;
      showMenu(more, taskId, target, resolved.apps);
    });
  }

  return {
    markup,
    bind,
    /** Fixed button state: background app loading never forces a drawer repaint. */
    signature(taskId, target) {
      return bridge && target ? FINDER_ID : "";
    },
    clear() {
      openTicket += 1;
      lists.clear();
      menu?.close();
    }
  };
}
