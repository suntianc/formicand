import { createMenu } from "../ui/menu.js";
import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../ui/html.js";

const CHOICE_KEY = "coworkos.open-with.";

/** The file type a remembered choice belongs to: its extension, or its whole name. */
function fileType(path) {
  const name = String(path).split("/").at(-1) || "";
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(dot + 1) : name).toLowerCase();
}

function remembered(path) {
  try {
    return localStorage.getItem(CHOICE_KEY + fileType(path));
    // eslint-disable-next-line no-restricted-syntax -- storage can be blocked; the default application is used instead
  } catch {
    return null;
  }
}

function remember(path, appId) {
  try {
    localStorage.setItem(CHOICE_KEY + fileType(path), appId);
    // eslint-disable-next-line no-restricted-syntax -- storage can be blocked; the choice is then only not kept
  } catch {
    /* the next open starts from the default application again */
  }
}

/**
 * The preview's "Open" split button, desktop only: the main half opens the
 * file with the application last chosen for its type (the system default at
 * first), the arrow lists the applications installed on this Mac that can
 * open it. The page names only the session, source and path; the host
 * resolves the file and accepts only an application it listed for it.
 */
export function createOpenWith({ bridge, showToast, onChange }) {
  const lists = new Map();
  let menu, panel, current;

  function key(taskId, target) {
    return JSON.stringify([taskId, target.source, target.path, target.developmentId ?? ""]);
  }

  /** The listed applications, loading them once per file. */
  function apps(taskId, target) {
    const id = key(taskId, target);
    const entry = lists.get(id);
    if (entry) return entry;
    const pending = { status: "loading", apps: [] };
    lists.set(id, pending);
    bridge
      .apps(taskId, target)
      .then((result) => {
        if (lists.get(id) !== pending) return;
        lists.set(id, { status: "ready", apps: Array.isArray(result?.apps) ? result.apps : [] });
        onChange();
      })
      // eslint-disable-next-line no-restricted-syntax -- without a list the main button still opens with the default application, and opening reports its own failure
      .catch(() => {
        if (lists.get(id) !== pending) return;
        lists.set(id, { status: "error", apps: [] });
        onChange();
      });
    return pending;
  }

  /** The application the main button uses: the remembered one while it is still listed. */
  function chosen(target, listed) {
    const saved = remembered(target.path);
    return (
      (saved ? listed.find((entry) => entry.id === saved && entry.kind !== "default") : undefined) ??
      listed.find((entry) => entry.kind === "default")
    );
  }

  function appIcon(entry) {
    return entry?.icon
      ? `<img class="open-with-icon" src="${esc(entry.icon)}" alt="" draggable="false" />`
      : icon("open-app");
  }

  /** The split button, or nothing outside the desktop or without a file. */
  function markup(taskId, target) {
    if (!bridge || !target) return "";
    const listed = apps(taskId, target);
    const app = chosen(target, listed.apps);
    const label = app ? `${ui("打开")} · ${app.name}` : ui("用系统默认应用打开");
    return `<div class="drawer-open-with"><button type="button" class="drawer-action drawer-open-main" data-open-main title="${esc(
      label
    )}" aria-label="${esc(label)}">${appIcon(app)}<span>${ui("打开")}</span></button><button type="button" class="drawer-action is-icon drawer-open-more" data-open-more aria-haspopup="menu" aria-expanded="false" aria-label="${ui(
      "选择打开方式"
    )}" title="${ui("选择打开方式")}"${listed.status === "ready" && listed.apps.length ? "" : " disabled"}>${icon(
      "chevron-down"
    )}</button></div>`;
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
      remember(target.path, appId);
      onChange();
      void open(taskId, target, appId);
    });
  }

  /** Wires the button rendered by `markup` inside `container`. */
  function bind(container, taskId, target) {
    if (!bridge || !target) return;
    container.querySelector("[data-open-main]")?.addEventListener("click", () => {
      const listed = lists.get(key(taskId, target));
      void open(taskId, target, appIdOf(chosen(target, listed?.apps ?? [])));
    });
    const more = container.querySelector("[data-open-more]");
    more?.addEventListener("click", () => {
      const listed = lists.get(key(taskId, target));
      if (!listed?.apps.length) return;
      ensureMenu(more);
      if (!panel.hidden) return menu.close(true);
      current = { taskId, target };
      fill(listed.apps);
      menu.open();
      const anchor = more.getBoundingClientRect(),
        { width, height } = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))}px`;
      panel.style.top = `${Math.max(8, Math.min(anchor.bottom + 4, innerHeight - height - 8))}px`;
    });
  }

  return {
    markup,
    bind,
    /** A stable mark of what the button shows, for the drawer's repaint check. */
    signature(taskId, target) {
      if (!bridge || !target) return "";
      const listed = lists.get(key(taskId, target));
      return JSON.stringify([listed?.status, chosen(target, listed?.apps ?? [])?.id]);
    },
    clear() {
      lists.clear();
      menu?.close();
    }
  };
}
