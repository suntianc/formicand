import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../ui/html.js";
import { animate, motionDuration } from "../ui/motion.js";

/**
 * The empty work pane for a conversation that does not exist yet.
 *
 * One question over the composer, nothing else; the project choice sits on
 * the composer so sending a message creates the session where the person
 * expects it.
 */
export function createNewSessionView({ state, $, onSelectProject = () => {}, onAddProject = () => {} }) {
  let rendered = "";
  let menuOpen = false;
  let placed = false;
  const newSessionPlaceholder = ui("描述需求，例如：给 summarize.sh 增加 --avg 参数…");
  const defaultPlaceholder = $("#composer-input").placeholder;
  const currentProject = () =>
    (state.projects || []).find((project) => project.projectId === state.selectedProjectId);
  function render() {
    if (state.selected) return;
    const conversation = $("#conversation");
    const markup = ui`<div class="new-session-start"><h2 class="new-session-title">想在哪个项目里做什么？</h2></div>`;
    // A conversation or a catalog re-render can replace this container; the
    // cached string alone does not prove the start surface is still mounted.
    if (markup === rendered && conversation.querySelector(".new-session-start")) return;
    rendered = markup;
    conversation.innerHTML = markup;
  }
  function renderMenu() {
    const projects = state.projects || [];
    const selected = state.selectedProjectId;
    $("#composer-project-menu").innerHTML = ui`${projects
      .map(
        (project) =>
          `<button class="composer-project-option" type="button" role="option" data-project-choice="${esc(project.projectId)}" aria-selected="${project.projectId === selected}">${icon("folder")}<span>${esc(project.projectName)}</span>${project.projectId === selected ? `<span class="composer-project-check">${icon("check")}</span>` : ""}</button>`
      )
      .join(
        ""
      )}<div class="composer-project-divider" role="separator"></div><button class="composer-project-option is-add" type="button" data-add-project>${icon("plus")}<span>添加项目…</span></button>`;
  }
  function closeMenu({ focus = false } = {}) {
    if (!menuOpen) return;
    menuOpen = false;
    $("#composer-project-menu").hidden = true;
    $("#composer-project").setAttribute("aria-expanded", "false");
    if (focus) $("#composer-project").focus();
  }
  function openMenu() {
    if (state.selected) return;
    renderMenu();
    menuOpen = true;
    $("#composer-project-menu").hidden = false;
    $("#composer-project").setAttribute("aria-expanded", "true");
    $("#composer-project-menu").querySelector('[role="option"][aria-selected="true"]')?.focus();
  }
  /**
   * A new session centres the composer; the first message sends it to the
   * pane's foot. The composer glides between the two places instead of jumping.
   */
  function placeComposer(composing) {
    const pane = $("#conversation-pane");
    const first = !placed;
    placed = true;
    if (pane.classList.contains("is-new-session") === composing) return;
    if (first) {
      pane.classList.toggle("is-new-session", composing);
      return;
    }
    const composer = pane.querySelector(".composer-wrap");
    const before = composer?.getBoundingClientRect();
    pane.classList.toggle("is-new-session", composing);
    if (!composer || !before?.height) return;
    const shift = before.top - composer.getBoundingClientRect().top;
    if (Math.abs(shift) < 2) return;
    animate(composer, [{ transform: `translateY(${shift}px)` }, { transform: "none" }], {
      duration: motionDuration("--motion-layout", 240),
      easing:
        getComputedStyle(document.documentElement).getPropertyValue("--ease-standard").trim() || "ease-out"
    });
  }
  function sync() {
    const composing = !state.selected;
    placeComposer(composing);
    $("#new-conversation").classList.toggle("is-current", composing);
    const input = $("#composer-input");
    if (composing) input.placeholder = newSessionPlaceholder;
    else if (input.placeholder === newSessionPlaceholder) input.placeholder = defaultPlaceholder;
    const chip = $("#composer-project");
    chip.hidden = !composing;
    if (!composing) return closeMenu();
    const project = currentProject();
    $(".composer-project-name").textContent = project?.projectName || ui("选择项目");
    chip.title = project ? ui`会话项目：${project.projectName}` : ui("选择项目");
  }
  $("#composer-project").addEventListener("click", () => {
    if (menuOpen) return closeMenu();
    openMenu();
  });
  $("#composer-project").addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    openMenu();
  });
  $("#composer-project-menu").addEventListener("click", (event) => {
    const option = event.target.closest("[data-project-choice]");
    if (option) {
      closeMenu();
      onSelectProject(option.dataset.projectChoice);
      return;
    }
    if (event.target.closest("[data-add-project]")) {
      closeMenu();
      onAddProject();
    }
  });
  $("#composer-project-menu").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu({ focus: true });
    }
  });
  document.addEventListener("click", (event) => {
    if (!menuOpen) return;
    if (event.target.closest("#composer-project, #composer-project-menu")) return;
    closeMenu();
  });
  return {
    render,
    sync,
    closeMenu,
    isMenuOpen: () => menuOpen
  };
}
