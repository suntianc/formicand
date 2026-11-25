import { ui } from "../ui/language.js";
import { icon } from "../ui/icons.js";

/** Render host-owned updates without exposing paths, commands or download URLs to the page. */
export function installDesktopUpdates({ host } = {}) {
  const desktop = window.formicandDesktop;
  const section = document.querySelector("#profile-settings-about .desktop-updates");
  if (!desktop?.updateStatus || !desktop?.checkUpdates || !desktop?.applyUpdate || !section) return;
  const panel = document.querySelector("#settings-entry");
  const action = section.querySelector("[data-update-action]");
  action.hidden = false;
  const message = section.querySelector("[data-update-message]");
  const error = section.querySelector("[data-update-error]");
  const progress = section.querySelector("[data-update-progress]");
  const notice = document.createElement("button");
  notice.type = "button";
  notice.className = "desktop-update-notice";
  notice.dataset.updateNotice = "";
  notice.setAttribute("aria-controls", "settings-entry");
  notice.hidden = true;
  notice.innerHTML = icon("download");
  document.querySelector("#user-menu-button")?.before(notice);
  let state = { phase: "idle" };
  let pending = false;
  let applying = false;
  let revision = 0;
  let locked = false;
  let restoreInert = [];
  let disposed = false;

  function lockEditors(value) {
    if (locked === value) return;
    locked = value;
    if (value) {
      restoreInert = [...document.body.children]
        .filter((element) => element !== panel && !element.matches("script, svg, #toast"))
        .map((element) => [element, element.inert]);
      for (const [element] of restoreInert) element.inert = true;
    } else {
      for (const [element, previous] of restoreInert) element.inert = previous;
      restoreInert = [];
    }
    const back = document.querySelector("#settings-back");
    if (back) back.disabled = value;
  }

  function canApply() {
    return Boolean(state.available || (state.updated && state.error));
  }

  function render() {
    if (disposed) return;
    const busy = pending || state.busy === true;
    const source = state.mode === "source";
    const manual = state.installMethod === "manual";
    const preparing = applying || state.applying === true;
    const finished = Boolean(state.updated && !state.error);
    lockEditors(Boolean(finished || (source && (preparing || state.phase === "updating"))));
    section.querySelector("[data-update-version]").textContent = state.currentVersion
      ? ui`版本 ${state.currentVersion}${source ? ui(" · 源码开发版") : ""}`
      : ui("版本信息暂不可用");
    action.hidden = manual;
    action.disabled = manual || busy || finished;
    action.classList.toggle("is-primary", canApply());
    action.classList.toggle("is-secondary", !canApply());
    action.toggleAttribute("data-update-apply", canApply());
    action.toggleAttribute("data-update-check", !canApply());
    action.textContent = finished
      ? ui("正在重新打开…")
      : busy && state.phase === "checking"
        ? ui("检查中…")
        : busy && preparing
          ? ui("更新中…")
          : canApply()
            ? ui("更新并重启")
            : ui("检查更新");
    const labels = {
      manual: ui("请使用本地安装包手动升级。"),
      checking: ui("正在检查更新…"),
      "up-to-date": ui("已是最新版本。"),
      updating: ui("正在更新，完成后会重新打开 Formicand。"),
      ready: ui("更新完成，正在重新打开 Formicand…")
    };
    message.textContent =
      state.phase === "available"
        ? state.rebuildRequired
          ? ui("CLI 已更新，需要重新构建 App，可以更新并重启。")
          : ui("发现新的开发提交，可以更新并重启。")
        : labels[state.phase] || "";
    if (state.phase === "up-to-date" && state.message) message.textContent = state.message;
    message.hidden = !message.textContent;
    error.textContent =
      typeof state.error === "string"
        ? state.error.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
        : "";
    error.hidden = !error.textContent;
    progress.hidden = !busy || state.phase !== "updating";
    if (Number.isFinite(state.progress?.percent)) {
      progress.max = 100;
      progress.value = Math.min(100, Math.max(0, state.progress.percent));
    } else progress.removeAttribute("value");
    notice.hidden = !canApply() || busy || finished;
    const noticeLabel = ui("发现更新，查看 Formicand 更新");
    notice.setAttribute("aria-label", noticeLabel);
    notice.title = noticeLabel;
  }

  function reflect(value) {
    if (disposed || !value || typeof value !== "object") return;
    revision += 1;
    state = value;
    render();
  }

  async function operation(run, isApply = false) {
    if (disposed || pending || state.busy) return;
    pending = true;
    applying = isApply;
    state = { ...state, error: undefined };
    render();
    try {
      reflect(await run());
    } catch (failure) {
      state = {
        ...state,
        phase: "error",
        busy: false,
        applying: false,
        error: failure?.message || ui("更新暂时不可用，请稍后重试")
      };
    } finally {
      pending = false;
      applying = false;
      render();
    }
  }

  const runCheck = () => operation(() => desktop.checkUpdates({}));
  action.addEventListener("click", () => {
    if (canApply()) void operation(() => desktop.applyUpdate(), true);
    else void runCheck();
  });
  notice.addEventListener("click", () => {
    if (host) host.open();
    else document.querySelector("#user-menu-button")?.click();
    section.scrollIntoView({ block: "nearest" });
    action.focus({ preventScroll: true });
  });
  const preventClose = (event) => {
    if (locked && ((event.type === "click" && event.target === panel) || event.key === "Escape")) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  panel.addEventListener("click", preventClose, true);
  window.addEventListener("keydown", preventClose, true);
  const unsubscribe = desktop.onUpdateStatus?.(reflect);
  const initialRevision = revision;
  void desktop
    .updateStatus()
    .then(async (value) => {
      if (disposed) return;
      if (revision === initialRevision) reflect(value);
      if (state.installMethod !== "manual" && !state.busy && !state.updated) await runCheck();
    })
    .catch((failure) => {
      state = { ...state, error: failure?.message || ui("无法读取更新状态") };
      render();
    });
  window.addEventListener(
    "pagehide",
    () => {
      disposed = true;
      unsubscribe?.();
      window.removeEventListener("keydown", preventClose, true);
      panel.removeEventListener("click", preventClose, true);
      lockEditors(false);
    },
    { once: true }
  );
  render();
}
