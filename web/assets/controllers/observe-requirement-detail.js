import { requirementTickets } from "../requirement-stages.js";
import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../ui/html.js";

const ROUTE_LABELS = { quick: "快速", direct: "直接", full: "Full" };
const REVIEW_LABEL = {
  in_review: "审查中",
  passed: "独立审查通过",
  failed: "审查未通过",
  drifted: "候选已变化"
};
const FINDING_LABEL = {
  open: "待处理",
  suggestion: "建议",
  fix_claimed: "已声明修复",
  fixed: "已修复",
  reopened: "未修好",
  dismissed: "已放行"
};
const DISMISS_LABEL = { false_positive: "误报", out_of_scope: "范围外", deferred: "推迟", other: "其他" };
const APPROACH_LABEL = {
  fresh_executor: "换执行者",
  revised_ticket: "改票",
  new_plan: "重新规划",
  deliver_partial: "先交付已完成部分"
};
const LEDGER_STATUS = { active: "在用", retired: "停用" };
export const shortCommit = (value) => (typeof value === "string" ? value.slice(0, 8) : "");

function detailTags(row) {
  const values = [row.progress.label];
  if (row.source) values.push(row.source);
  if (row.view?.development?.route)
    values.push(ROUTE_LABELS[row.view.development.route] ?? row.view.development.route);
  return values
    .map(
      (value, index) =>
        `<span class="or-tag"${
          index
            ? ""
            : ` data-stage="${esc(row.progress.stage)}"${row.progress.waiting ? ' data-waiting="true"' : ""}${
                row.progress.paused ? ' data-paused="true"' : ""
              }`
        }>${esc(ui(value))}</span>`
    )
    .join("");
}

/** The five steps with the connector between each pair, as the design draws them. */
function stepperMarkup(row) {
  return `<div class="or-stepper" role="list" data-stage="${esc(row.progress.stage)}"${
    row.progress.paused ? ' data-paused="true"' : ""
  } aria-label="${esc(ui("需求阶段"))}">${row.progress.steps
    .map((step, index) => {
      const node =
        step.state === "done"
          ? `<span class="or-step-node is-done">${icon("check")}</span>`
          : step.state === "pending"
            ? '<span class="or-step-node is-pending"></span>'
            : `<span class="or-step-node is-current"${step.state === "blocked" ? ' data-blocked="true"' : ""}></span>`;
      const connector =
        index === row.progress.steps.length - 1
          ? ""
          : `<span class="or-step-connector" aria-hidden="true"><span class="or-step-line" data-state="${esc(
              step.state
            )}"></span></span>`;
      return `<div class="or-step" role="listitem" data-step="${esc(step.id)}" data-state="${esc(step.state)}"${
        step.state === "current" || step.state === "blocked" ? ' aria-current="step"' : ""
      }><span class="or-step-rail">${node}</span><span class="or-step-label">${esc(ui(step.label))}</span></div>${connector}`;
    })
    .join("")}</div>`;
}

function factRow(key, value, { mono = false } = {}) {
  return `<div class="or-fact"><span class="or-fact-key">${esc(ui(key))}</span><span class="or-fact-value${
    mono ? " is-mono" : ""
  }">${esc(value || "—")}</span></div>`;
}

/** The feature as the ledger keeps it: its summary and other names, read once the detail opens. */
function ledgerSection(entry) {
  if (!entry) return "";
  if (entry.failed) return `<p class="or-ledger-error" role="alert">${esc(entry.failed)}</p>`;
  const requirement = entry.context?.requirement;
  if (!requirement) return "";
  const aliases = requirement.aliases ?? [];
  return `${
    requirement.summary
      ? `<section class="or-section" data-or-section="summary"><h3 class="or-label">${esc(
          ui("现状")
        )}</h3><p class="or-summary">${esc(requirement.summary)}</p></section>`
      : ""
  }${
    aliases.length
      ? `<section class="or-section" data-or-section="aliases"><h3 class="or-label">${esc(
          ui("别名")
        )}</h3><div class="or-aliases">${aliases
          .map((alias) => `<span class="or-alias">${esc(alias.alias)}</span>`)
          .join("")}</div></section>`
      : ""
  }`;
}

const DEVELOPMENT_STATUS = { active: "进行中", paused: "已暂停", merged: "已合入", withdrawn: "已撤回" };

/** What each development changed, and every development of this feature, newest first. */
function pastSection(context) {
  if (!context) return "";
  const history = context.history ?? [];
  const developments = context.developments ?? [];
  return `${
    history.length
      ? `<section class="or-section" data-or-section="history"><h3 class="or-label">${esc(
          context.historyTotal > history.length
            ? ui`历史 最近 ${history.length} / ${context.historyTotal}`
            : ui("历史")
        )}</h3><ul class="or-history">${[...history]
          .reverse()
          .map(
            (line) =>
              `<li><span class="or-history-day">${esc(line.day)}</span><span>${esc(line.text)}</span></li>`
          )
          .join("")}</ul></section>`
      : ""
  }${
    developments.length
      ? `<section class="or-section" data-or-section="developments"><h3 class="or-label">${esc(
          ui`历次开发 ${developments.length}`
        )}</h3><ul class="or-developments">${developments
          .map(
            (development) =>
              `<li data-status="${esc(development.status)}"><span class="or-development-goal" title="${esc(
                development.goal
              )}">${esc(development.goal.split("\n")[0])}</span><span class="or-spacer"></span><span class="or-development-state"${
                development.reason ? ` title="${esc(development.reason)}"` : ""
              }>${esc(
                development.merged
                  ? `${ui("已合入")} · ${shortCommit(development.merged.commit)}`
                  : ui(DEVELOPMENT_STATUS[development.status] ?? development.status)
              )}</span>${developmentLinks(development, developments)}</li>`
          )
          .join("")}</ul></section>`
      : ""
  }`;
}

/**
 * A development that picks up a withdrawn one, and the withdrawn one picked up
 * later, name each other, so the two halves of the same work read as one.
 */
function developmentLinks(development, developments) {
  const links = [];
  if (development.continues) links.push(ui("接续撤回的开发"));
  if (developments.some((entry) => entry.continues === development.developmentId)) links.push(ui("已被接续"));
  return links.map((text) => `<span class="or-development-link">${esc(text)}</span>`).join("");
}

function criteriaSection(row) {
  const criteria = row.progress.criteria;
  if (!criteria.length) return "";
  const checked = criteria.filter((entry) => entry.checked).length;
  return `<section class="or-section" data-or-section="criteria"><h3 class="or-label">${esc(
    ui`完成标准 ${checked}/${criteria.length}`
  )}</h3><ul class="or-checks">${criteria
    .map(
      (entry) =>
        `<li data-checked="${entry.checked}">${icon("circle-check")}<span>${esc(entry.text)}</span></li>`
    )
    .join("")}</ul></section>`;
}

function ticketSection(row) {
  const { rows, merged } = requirementTickets(row.facts.tickets);
  if (!rows.length) return "";
  return `<section class="or-section" data-or-section="tickets"><h3 class="or-label">${esc(
    ui`票 ${merged}/${rows.length} 已并入`
  )}</h3><ul class="or-tickets">${rows
    .map(
      (ticket) =>
        `<li data-ticket-state="${esc(ticket.state)}"><span class="or-ticket-id">${esc(
          ticket.ticketId
        )}</span><span class="or-ticket-title">${esc(ticket.title)}</span><span class="or-spacer"></span>${
          ticket.dependsOn.length
            ? `<span class="or-ticket-after">${esc(ui`在 ${ticket.dependsOn.join("、")} 之后`)}</span>`
            : ""
        }<span class="or-ticket-state">${esc(ui(ticket.label))}</span></li>`
    )
    .join("")}</ul></section>`;
}

function reviewSection(row) {
  const review = [...(row.facts.reviews ?? [])].at(-1);
  if (!review) return "";
  const findings = review.findings ?? [];
  const report = row.view?.reviewReport ?? { dismissed: [], approaches: [], suggestions: [] };
  const where = (entry) => (entry.ticketId ? `${entry.ticketId} · ` : "");
  const item = (state, title, label, detail) =>
    `<li data-finding-state="${esc(state)}"${detail ? ` title="${esc(detail)}"` : ""}><span>${esc(
      title
    )}</span><span class="or-spacer"></span><span class="or-finding-state">${esc(ui(label))}</span></li>`;
  const items = [
    ...findings
      .filter((finding) => finding.blocking !== false)
      .map((finding) =>
        item(
          finding.state,
          finding.title,
          FINDING_LABEL[finding.state] ?? finding.state,
          finding.ruling?.basis
        )
      ),
    ...report.approaches.map((entry) =>
      item(
        "approach",
        `${where(entry)}${ui(APPROACH_LABEL[entry.kind] ?? entry.kind)}`,
        "换办法",
        entry.basis
      )
    ),
    ...report.dismissed
      .filter((entry) => entry.reviewId !== review.reviewId)
      .map((entry) =>
        item(
          "dismissed",
          `${where(entry)}${entry.title}`,
          DISMISS_LABEL[entry.category] ?? entry.category,
          entry.basis
        )
      ),
    ...report.suggestions.map((entry) =>
      item(
        entry.picked ? "fix_claimed" : "suggestion",
        `${where(entry)}${entry.title}`,
        entry.picked ? "已采纳" : "建议",
        entry.location
      )
    )
  ];
  const counts = [
    report.dismissed.length ? ui`放行 ${report.dismissed.length}` : "",
    report.approaches.length ? ui`换办法 ${report.approaches.length}` : "",
    report.suggestions.length ? ui`建议 ${report.suggestions.length}` : ""
  ].filter(Boolean);
  const conclusion = `<span class="or-review-text">${esc(ui(REVIEW_LABEL[review.state] ?? review.state))}</span>`;
  const head = items.length
    ? `<button type="button" class="or-review" data-observe-review aria-expanded="false" aria-controls="or-review-findings">${icon(
        "shield-check"
      )}${conclusion}<span class="or-spacer"></span>${
        counts.length ? `<span class="or-review-findings">${esc(counts.join(" · "))}</span>` : ""
      }${icon("chevron-right", "or-chevron")}</button>`
    : `<div class="or-review">${icon("shield-check")}${conclusion}</div>`;
  const list = items.length
    ? `<ul class="or-findings" id="or-review-findings" hidden>${items.join("")}</ul>`
    : "";
  return `<section class="or-section" data-or-section="review"><h3 class="or-label">${esc(
    ui("审查")
  )}</h3>${head}${list}</section>`;
}

function changeSection(row) {
  const files = row.view?.diff?.files;
  if (!files?.length) return "";
  return `<section class="or-section" data-or-section="change"><h3 class="or-label">${esc(
    ui("改动")
  )}</h3>${files
    .map(
      (file) =>
        `<div class="or-file">${icon("file-code")}<span class="or-file-name" title="${esc(file.path)}">${esc(
          file.path
        )}</span><span class="or-spacer"></span><span class="or-add">+${
          Number(file.additions) || 0
        }</span><span class="or-del">−${Number(file.deletions) || 0}</span></div>`
    )
    .join("")}</section>`;
}

export function requirementDetailMarkup(row, entry) {
  const merge = row.merge;
  const description = entry?.context?.requirement.description;
  return `<header class="or-detail-head"><span class="or-crumb">${esc(
    ui("需求详情")
  )}</span><span class="or-spacer"></span><button type="button" class="or-close" data-observe-detail-close aria-label="${esc(
    ui("关闭需求详情")
  )}">${icon("close")}</button></header>
    <div class="or-detail-body">
      <section class="or-identity">
        <h2 class="or-detail-title">${esc(row.title)}</h2>
        ${description ? `<p class="or-description">${esc(description)}</p>` : ""}
        <div class="or-tags">${detailTags(row)}</div>
      </section>
      ${stepperMarkup(row)}
      <div class="or-facts">
        ${factRow("处理会话", row.session)}
        ${factRow("归属人", row.owner)}
        ${factRow(
          "合入",
          merge ? [merge.branch, shortCommit(merge.commit)].filter(Boolean).join(" · ") : "—",
          {
            mono: Boolean(merge?.commit)
          }
        )}
        ${factRow("台账", `v${row.revision} · ${ui(LEDGER_STATUS[row.status] ?? row.status ?? "")}`)}
      </div>
      ${ledgerSection(entry)}
      ${criteriaSection(row)}
      ${ticketSection(row)}
      ${reviewSection(row)}
      ${changeSection(row)}
      ${pastSection(entry?.context)}
    </div>`;
}
