import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../ui/html.js";
import { providerLogo } from "./model-provider-display.js";

export function createAgentModelMenu({ currentDraft, models, modelFallback, onPick, focusTrigger }) {
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
    const draft = currentDraft();
    if (!draft) return;
    const current = draft.profileId ?? "";
    const query = menuQuery.toLowerCase();
    const groups = new Map();
    for (const entry of models()) {
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
    if (!pick || !currentDraft()) return;
    closeMenu();
    onPick(pick.dataset.agentPick);
    focusTrigger();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !event.target.closest("[data-agent-model]"))
      closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      closeMenu();
      focusTrigger();
    }
  });

  return {
    toggle(button) {
      if (menu.hidden) openMenu(button);
      else closeMenu();
    }
  };
}
