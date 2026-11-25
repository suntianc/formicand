import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../ui/html.js";
import { createModal } from "../ui/modal.js";

/**
 * The trust question in the work view.
 *
 * A project that carries its own Agents (`.formicand/agents`) or skills
 * (`.formicand/skills`, `.agents/skills`) is asked about the first time it is
 * opened: until the user says yes, none of it reaches Main or a Subagent.
 * Only names are read to ask. An answer not remembered holds for this page.
 */
export function createProjectTrustPrompt({ api, getProjectId, showToast = () => {} }) {
  const asked = new Set();
  let current;

  const panel = document.createElement("div");
  panel.className = "modal-backdrop app-dialog-backdrop";
  panel.hidden = true;
  panel.innerHTML = ui`<section class="modal-card app-dialog trust-dialog" role="dialog" aria-modal="true" aria-labelledby="trust-title" aria-describedby="trust-copy" tabindex="-1">
      <div class="trust-head">
        <span class="trust-mark">${icon("shield-check")}</span>
        <div class="trust-head-text"><h2 id="trust-title" data-trust-title></h2><p class="trust-path is-mono" data-trust-path></p></div>
      </div>
      <p class="trust-copy" id="trust-copy">信任后，项目自带的 Agent 和技能会交给 Main 和子 Agent 使用，技能里的脚本也可能运行。不信任则全部忽略。</p>
      <div class="trust-groups" data-trust-groups></div>
      <div class="trust-foot">
        <label class="trust-remember"><input type="checkbox" data-trust-remember checked><span>记住选择，可在设置里撤销</span></label>
        <div class="trust-actions">
          <button class="app-button is-secondary" type="button" data-trust-no>不信任</button>
          <button class="app-button is-primary" type="button" data-trust-yes>信任</button>
        </div>
      </div>
    </section>`;
  document.body.append(panel);
  const modal = createModal(panel, panel.querySelector("[data-trust-no]"));
  const $ = (selector) => panel.querySelector(selector);

  /** One kind of thing the project brings: a count, where it lives, and each name. */
  function group(iconName, title, where, list, { override, note }) {
    const names = list
      .map((entry) =>
        entry.overrides
          ? `<li class="is-override" title="${esc(override)}">${esc(entry.name)}</li>`
          : `<li>${esc(entry.name)}</li>`
      )
      .join("");
    const noteLine = list.some((entry) => entry.overrides)
      ? `<p class="trust-override-note">${esc(note)}</p>`
      : "";
    return `<section class="trust-group">
        <div class="trust-group-head">${icon(iconName)}<strong>${esc(title)}</strong><span class="is-mono">${esc(where)}</span></div>
        <ul class="trust-names">${names}</ul>${noteLine}
      </section>`;
  }

  function show(preview) {
    current = preview.project.projectId;
    $("[data-trust-title]").textContent = ui`信任项目 ${preview.project.projectName}？`;
    $("[data-trust-path]").textContent = preview.project.displayDirectory;
    $("[data-trust-groups]").innerHTML = [
      preview.agents.length
        ? group("bot", ui`${preview.agents.length} 个 Agent`, ".formicand/agents/", preview.agents, {
            override: ui("覆盖同名全局 Agent"),
            note: ui("标黄的会覆盖同名全局 Agent")
          })
        : "",
      preview.skills.length
        ? group(
            "book-open",
            ui`${preview.skills.length} 个技能`,
            ".formicand/skills/ · .agents/skills/",
            preview.skills,
            { override: ui("覆盖同名全局技能"), note: ui("标黄的会覆盖同名全局技能") }
          )
        : ""
    ].join("");
    $("[data-trust-remember]").checked = true;
    modal.open();
    // Focus the card, not a button: Enter must not answer a trust question by accident.
    $(".trust-dialog").focus();
  }

  async function answer(trust) {
    const projectId = current;
    current = undefined;
    modal.close();
    if (!projectId) return;
    // Not remembered: nothing is written, so a trusted answer cannot load anything either.
    if (!$("[data-trust-remember]").checked) return;
    try {
      await api("/api/agents/trust", { method: "POST", json: { projectId, trust } });
      if (trust === "trusted") showToast(ui("已信任此项目，下一轮起生效"));
    } catch (error) {
      showToast(error?.message || ui("操作未完成"));
    }
  }

  $("[data-trust-yes]").addEventListener("click", () => void answer("trusted"));
  $("[data-trust-no]").addEventListener("click", () => void answer("untrusted"));

  return {
    /** Ask about the draft's project once per page when it has something to trust and no answer yet. */
    async check() {
      const projectId = getProjectId();
      if (!projectId || asked.has(projectId) || current) return;
      asked.add(projectId);
      let preview;
      try {
        preview = await api(`/api/agents/trust-preview?projectId=${encodeURIComponent(projectId)}`);
        // eslint-disable-next-line no-restricted-syntax -- 读不到就不问；项目内容在信任前本来就不会被读取
      } catch {
        return;
      }
      if (preview.project.trust || (!preview.agents.length && !preview.skills.length)) return;
      if (getProjectId() === projectId) show(preview);
    }
  };
}
