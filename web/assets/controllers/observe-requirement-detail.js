import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../ui/html.js";
import {
  changesMarkup,
  criteriaMarkup,
  foldedRows,
  phaseMarkup,
  sectionHead,
  shortCommit,
  ticketsMarkup
} from "./requirement-sections.js";

/**
 * The observation detail: one requirement's recorded facts, drawn with the
 * work entry's requirement panel parts so the two read alike. Observation is
 * read-only, so the change lists files without opening a diff or a file.
 */

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
const DEVELOPMENT_STATUS = { active: "进行中", paused: "已暂停", merged: "已合入", withdrawn: "已撤回" };
export { shortCommit };

const section = (name, inner) => `<section class="rp-section" data-or-section="${name}">${inner}</section>`;

function tagValues(row) {
  const values = [];
  if (row.source) values.push(ui(row.source));
  const route = row.view?.development?.route;
  if (route) values.push(ui(ROUTE_LABELS[route] ?? route));
  return values;
}

const factRow = (key, value, { mono = false } = {}) =>
  `<div class="or-fact"><span class="or-fact-key">${esc(ui(key))}</span><span class="or-fact-value${
    mono ? " is-mono" : ""
  }" title="${esc(value || "")}">${esc(value || "—")}</span></div>`;

function factsSection(row) {
  const merge = row.merge;
  return `<div class="or-facts">${factRow("处理会话", row.session)}${factRow("归属人", row.owner)}${factRow(
    "合入",
    merge ? [merge.branch, shortCommit(merge.commit)].filter(Boolean).join(" · ") : "—",
    { mono: Boolean(merge?.commit) }
  )}${factRow("台账", `v${row.revision} · ${ui(LEDGER_STATUS[row.status] ?? row.status ?? "")}`)}</div>`;
}

/** The feature as the ledger keeps it: its summary and other names, read once the detail opens. */
function ledgerSection(entry) {
  if (!entry) return "";
  if (entry.failed) return `<p class="rp-error" role="alert">${esc(entry.failed)}</p>`;
  const requirement = entry.context?.requirement;
  if (!requirement) return "";
  const aliases = requirement.aliases ?? [];
  return `${
    requirement.summary
      ? section("summary", `${sectionHead(ui("现状"))}<p class="or-summary">${esc(requirement.summary)}</p>`)
      : ""
  }${
    aliases.length
      ? section(
          "aliases",
          `${sectionHead(ui("别名"))}<div class="rp-tags">${aliases
            .map((alias) => `<span class="rp-tag or-alias">${esc(alias.alias)}</span>`)
            .join("")}</div>`
        )
      : ""
  }`;
}

function reviewSection(row, unfolded) {
  const review = [...(row.facts.reviews ?? [])].at(-1);
  if (!review) return "";
  const findings = review.findings ?? [];
  const report = row.view?.reviewReport ?? { dismissed: [], approaches: [], suggestions: [] };
  const where = (entry) => (entry.ticketId ? `${entry.ticketId} · ` : "");
  const item = (state, title, label, detail) =>
    `<li data-finding-state="${esc(state)}"${detail ? ` title="${esc(detail)}"` : ""}><span class="or-finding-title">${esc(
      title
    )}</span><span class="rp-spacer"></span><span class="or-finding-state">${esc(ui(label))}</span></li>`;
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
  const open = unfolded.has("review");
  const conclusion = `${icon("shield-check")}<span class="or-review-text">${esc(
    ui(REVIEW_LABEL[review.state] ?? review.state)
  )}</span>`;
  const head = items.length
    ? `<button type="button" class="or-review" data-unfold="review" data-observe-review aria-expanded="${open}" aria-controls="or-review-findings">${conclusion}<span class="rp-spacer"></span>${
        counts.length ? `<span class="or-review-findings">${esc(counts.join(" · "))}</span>` : ""
      }${icon(open ? "chevron-up" : "chevron-down", "or-chevron")}</button>`
    : `<div class="or-review">${conclusion}</div>`;
  const list = items.length
    ? `<ul class="or-findings" id="or-review-findings"${open ? "" : " hidden"}>${items.join("")}</ul>`
    : "";
  return section("review", `${sectionHead(ui("审查"))}<div class="rp-diff-card">${head}${list}</div>`);
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

/** What each development changed, and every development of this feature, newest first. */
function pastSection(context, unfolded) {
  if (!context) return "";
  const history = [...(context.history ?? [])].reverse();
  const developments = context.developments ?? [];
  const lines = foldedRows(unfolded, "history", history);
  const runs = foldedRows(unfolded, "developments", developments);
  return `${
    history.length
      ? section(
          "history",
          `${sectionHead(
            ui("历史"),
            context.historyTotal > history.length
              ? `${history.length} / ${context.historyTotal}`
              : String(history.length)
          )}<ul class="or-history">${lines.shown
            .map(
              (line) =>
                `<li title="${esc(line.text)}"><span class="or-history-day">${esc(line.day)}</span><span class="or-history-text">${esc(
                  line.text
                )}</span></li>`
            )
            .join("")}</ul>${lines.fold}`
        )
      : ""
  }${
    developments.length
      ? section(
          "developments",
          `${sectionHead(ui("历次开发"), String(developments.length))}<ul class="or-developments">${runs.shown
            .map(
              (development) =>
                `<li data-status="${esc(development.status)}"><span class="or-development-goal" title="${esc(
                  development.goal
                )}">${esc(development.goal.split("\n")[0])}</span><span class="rp-spacer"></span>${developmentLinks(
                  development,
                  developments
                )}<span class="or-development-state"${
                  development.reason ? ` title="${esc(development.reason)}"` : ""
                }>${esc(
                  development.merged
                    ? `${ui("已合入")} · ${shortCommit(development.merged.commit)}`
                    : ui(DEVELOPMENT_STATUS[development.status] ?? development.status)
                )}</span></li>`
            )
            .join("")}</ul>${runs.fold}`
        )
      : ""
  }`;
}

/** The detail's fixed header; the body below it scrolls on its own. */
export function requirementDetailShell() {
  return `<header class="requirement-panel-head or-detail-head"><h2 class="or-crumb">${esc(
    ui("需求详情")
  )}</h2><button type="button" class="or-close" data-observe-detail-close aria-label="${esc(
    ui("关闭需求详情")
  )}" title="${esc(ui("关闭需求详情"))}">${icon("close")}</button></header><div class="requirement-panel-body or-detail-body"></div>`;
}

/** The body of one requirement's detail; `unfolded` holds the lists the reader opened. */
export function requirementDetailMarkup(row, entry, unfolded = new Set()) {
  const description = entry?.context?.requirement.description;
  const tags = tagValues(row);
  return `<div class="rp-identity"><h3 class="rp-title or-detail-title" title="${esc(row.title)}">${esc(
    row.title
  )}</h3>${description ? `<p class="or-description">${esc(description)}</p>` : ""}${
    tags.length
      ? `<div class="rp-tags">${tags.map((value) => `<span class="rp-tag or-tag">${esc(value)}</span>`).join("")}</div>`
      : ""
  }</div>${phaseMarkup(row.progress)}${factsSection(row)}${ledgerSection(entry)}${criteriaMarkup(
    row.progress.criteria,
    unfolded,
    ' data-or-section="criteria"'
  )}${ticketsMarkup(row.facts.tickets, { order: true, attributes: ' data-or-section="tickets"' })}${reviewSection(
    row,
    unfolded
  )}${changesMarkup({
    files: row.view?.diff?.files ?? [],
    commit: shortCommit(row.view?.diff?.candidateCommit),
    unfolded,
    open: false,
    attributes: ' data-or-section="change"'
  })}${pastSection(entry?.context, unfolded)}`;
}
