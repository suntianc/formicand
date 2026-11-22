import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../ui/html.js";
import { agentIcon } from "./agent-settings-editor.js";

export function renderAgentProjectBar($, { scope, projects: list, projectId, project }) {
  const bar = $("[data-agent-project]");
  bar.hidden = scope !== "project";
  if (bar.hidden) return;
  const select = $("[data-agent-project-select]");
  select.innerHTML = list.length
    ? list
        .map(
          (project) =>
            `<option value="${esc(project.projectId)}"${project.projectId === projectId ? " selected" : ""}>${esc(project.projectName || project.projectDirectory)}</option>`
        )
        .join("")
    : `<option value="">${ui("还没有项目")}</option>`;
  select.disabled = !list.length;
  const chosen = list.find((project) => project.projectId === projectId);
  $("[data-agent-project-name]").textContent = chosen
    ? chosen.projectName || chosen.projectDirectory
    : ui("还没有项目");
  const shown = project && project.projectId === projectId;
  $("[data-agent-project-dir]").textContent = shown ? project.displayDirectory : "";
  const trust = $("[data-agent-trust]");
  if (!shown) {
    trust.innerHTML = "";
    return;
  }
  trust.innerHTML =
    project.trust === "trusted"
      ? ui`<span class="is-ok">${icon("shield-check")}</span><span>已信任此项目</span><button class="settings-link" type="button" data-agent-trust-set="untrusted">撤销</button>`
      : ui`<span class="is-alert">${icon("triangle-alert")}</span><span>${project.trust === "untrusted" ? ui("未信任") : ui("尚未决定是否信任")}</span><button class="app-button is-secondary" type="button" data-agent-trust-set="trusted">信任此项目</button>`;
}

export function agentListMarkup(shown, { scope, agents, selected, keyOf, summary, emptyText }) {
  let group;
  return shown.length
    ? shown
        .map(({ agent, group: next }) => {
          const header =
            next.source !== group
              ? `<li class="agent-group" role="presentation"><span>${esc(next.title)}</span>${next.note ? `<span class="is-mono">${esc(next.note)}</span>` : ""}</li>`
              : "";
          group = next.source;
          const off = agent.error || agent.shadowedBy || agent.definition?.enabled === false;
          const tag =
            agent.problems.length || agent.error
              ? `<span class="skill-tag is-warn">${esc(ui("引用失效"))}</span>`
              : agent.source === "builtin"
                ? `<span class="skill-tag has-icon">${icon("lock")}${esc(ui("内置"))}</span>`
                : scope === "project" &&
                    agent.source === "project" &&
                    agents.some(
                      (other) => other.source === "global" && other.shadowedBy && other.name === agent.name
                    )
                  ? `<span class="skill-tag is-warn">${esc(ui("覆盖全局"))}</span>`
                  : scope === "project" && agent.source === "global"
                    ? `<span class="skill-tag">${esc(ui("全局"))}</span>`
                    : "";
          return `${header}<li><button type="button" class="skill-row${off ? " is-muted" : ""}" data-agent-select="${esc(keyOf(agent))}" aria-current="${keyOf(agent) === selected}">
            <span class="settings-icon-box">${icon(agentIcon(agent.definition))}</span>
            <span class="skill-row-text"><span class="skill-row-name">${esc(agent.name)}</span><span class="skill-row-desc">${esc(summary(agent))}</span></span>
            ${tag}
          </button></li>`;
        })
        .join("")
    : `<li class="skill-empty">${esc(emptyText())}</li>`;
}
