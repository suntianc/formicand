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
  panel.innerHTML = ui`<section class="modal-card app-dialog trust-dialog" role="dialog" aria-modal="true" aria-labelledby="trust-title" aria-describedby="trust-copy">
      <div class="trust-head">
        <span class="trust-mark">${icon("shield-check")}</span>
        <div class="trust-head-text"><h2 id="trust-title" data-trust-title></h2><p class="trust-path is-mono" data-trust-path></p></div>
      </div>
      <p class="trust-copy" id="trust-copy">这个项目里带了 Agent 和技能。信任后它们会进入 Main 和子 Agent 的上下文，技能里的脚本可能被运行。只信任你了解的项目。</p>
      <ul class="trust-list" data-trust-list></ul>
      <label class="settings-checkbox trust-remember"><input type="checkbox" data-trust-remember checked><span>记住我的选择（可在设置 · Agent · 项目中撤销）</span></label>
      <div class="modal-actions dialog-actions">
        <button class="app-button is-secondary" type="button" data-trust-no>不信任，忽略这些配置</button>
        <button class="app-button is-primary" type="button" data-trust-yes>${icon("shield-check")}<span>信任</span></button>
      </div>
    </section>`;
  document.body.append(panel);
  const modal = createModal(panel, panel.querySelector("[data-trust-no]"));
  const $ = (selector) => panel.querySelector(selector);

  function agentLine(list) {
    const shown = list.map((entry) => entry.name).join("、");
    return list.some((entry) => entry.overrides)
      ? ui`${list.length} 个 Agent：${shown}（覆盖同名全局 Agent）`
      : ui`${list.length} 个 Agent：${shown}`;
  }

  function skillLine(list) {
    const shown = list.map((entry) => entry.name).join("、");
    return list.some((entry) => entry.overrides)
      ? ui`${list.length} 个技能：${shown}（覆盖同名全局技能）`
      : ui`${list.length} 个技能：${shown}`;
  }

  function show(preview) {
    current = preview.project.projectId;
    $("[data-trust-title]").textContent = ui`信任项目 ${preview.project.projectName}？`;
    $("[data-trust-path]").textContent = preview.project.displayDirectory;
    $("[data-trust-list]").innerHTML = [
      preview.agents.length
        ? `<li>${icon("bot")}<span class="is-mono">.formicand/agents/</span><span>${esc(agentLine(preview.agents))}</span></li>`
        : "",
      preview.skills.length
        ? `<li>${icon("book-open")}<span class="is-mono">.formicand/skills/ · .agents/skills/</span><span>${esc(skillLine(preview.skills))}</span></li>`
        : ""
    ].join("");
    $("[data-trust-remember]").checked = true;
    modal.open();
    $("[data-trust-yes]").focus();
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
