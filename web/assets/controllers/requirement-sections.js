import { requirementTickets } from "../requirement-stages.js";
import { fileIcon } from "../ui/file-icons.js";
import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../ui/html.js";

/**
 * The parts of a requirement both the work entry's panel and the observation
 * detail draw: the phase, completion criteria, tickets, the change and the
 * row that folds a long list. Each list folds by a key the caller keeps in
 * `unfolded`, and a `[data-unfold]` press toggles that key.
 */

// A list longer than this shows its first few rows and folds the rest.
export const FLAT_LIMIT = 5;
export const FOLDED_ROWS = 3;

export const shortCommit = (commit) => (typeof commit === "string" ? commit.slice(0, 8) : "");

/** A step's ring cut into one arc per ticket; finished tickets' arcs are green. */
function segmentRing({ done, total }) {
  const radius = 8.25;
  const circumference = 2 * Math.PI * radius;
  const gap = total > 8 ? 1.2 : 2.4;
  const length = circumference / total - gap;
  const arcs = Array.from(
    { length: total },
    (_, index) =>
      `<circle class="rp-arc${index < done ? " is-done" : ""}" cx="9" cy="9" r="${radius}" stroke-dasharray="${length.toFixed(
        2
      )} ${(circumference - length).toFixed(2)}" stroke-dashoffset="${(-(index * circumference) / total - gap / 2).toFixed(2)}"/>`
  ).join("");
  return `<svg class="rp-ring" viewBox="0 0 18 18" aria-hidden="true">${arcs}</svg>`;
}

/** The phase in words over a row of dots, one per step. */
export function phaseMarkup(progress) {
  const current = progress.steps.find((step) => step.state === "current" || step.state === "blocked");
  const tone = progress.paused ? "paused" : progress.waiting ? "waiting" : (current?.state ?? "settled");
  const meta = current?.meta ?? "";
  const status = `<div class="rp-status" data-tone="${esc(tone)}"><span class="rp-status-dot" aria-hidden="true"></span><span class="rp-status-label">${esc(
    ui(progress.label)
  )}</span>${meta ? `<span class="rp-status-meta" title="${esc(meta)}">${esc(meta)}</span>` : ""}</div>`;
  return `<div class="rp-phase">${status}<ol class="rp-stepper" data-stage="${esc(progress.stage)}"${
    progress.paused ? ' data-paused="true"' : ""
  } aria-label="${ui("需求阶段")}">${progress.steps
    .map((step) => {
      const ring = step.segments && step.state !== "done" ? segmentRing(step.segments) : "";
      const node =
        step.state === "done"
          ? `<span class="rp-node">${icon("check")}</span>`
          : step.state === "pending"
            ? `<span class="rp-node is-pending${ring ? " is-segmented" : ""}">${ring}</span>`
            : `<span class="rp-node is-current${ring ? " is-segmented" : ""}">${ring}<span class="rp-pulse"></span></span>`;
      const active = step.state === "current" || step.state === "blocked";
      const label = ui(step.label);
      return `<li class="rp-step" data-step="${esc(step.id)}" data-state="${esc(step.state)}"${
        active ? ' aria-current="step"' : ""
      } title="${esc(
        [label, step.segments ? ui`票 ${step.segments.done}/${step.segments.total}` : "", step.meta]
          .filter(Boolean)
          .join(" · ")
      )}">${node}<span class="rp-step-label">${esc(
        label
      )}</span><span class="rp-step-meta">${esc(step.meta)}</span></li>`;
    })
    .join("")}</ol></div>`;
}

/** The row that unfolds the rest of a list. */
export function foldRow(unfolded, key, label, hidden) {
  const open = unfolded.has(key);
  return `<button type="button" class="rp-fold" data-unfold="${esc(key)}" aria-expanded="${open}">${icon(
    open ? "chevron-up" : "chevron-down"
  )}<span>${esc(open ? ui("收起") : label.replace("{count}", String(hidden)))}</span></button>`;
}

/** A list's rows as shown: all of a short list, the first `keep` of a long folded one. */
export function foldedRows(unfolded, key, rows, keep = FLAT_LIMIT, label = ui("其余 {count} 条")) {
  if (rows.length <= FLAT_LIMIT) return { shown: rows, fold: "" };
  const open = unfolded.has(key);
  return {
    shown: open ? rows : rows.slice(0, keep),
    fold: foldRow(unfolded, key, label, rows.length - keep)
  };
}

/** The section heading, with an optional count at its end. */
export function sectionHead(label, count = "", { end = false, done = false } = {}) {
  return `<div class="rp-section-head"><h3 class="rp-label">${esc(label)}</h3>${
    count === ""
      ? ""
      : `<span class="rp-count${end ? " is-end" : ""}${done ? " is-done" : ""}">${esc(count)}</span>`
  }</div>`;
}

export function criteriaMarkup(criteria, unfolded, attributes = "") {
  if (!criteria.length) return "";
  const met = criteria.filter((entry) => entry.checked).length;
  const { shown, fold } = foldedRows(unfolded, "criteria", criteria);
  return `<section class="rp-section"${attributes}>${sectionHead(
    ui("完成标准"),
    `${met} / ${criteria.length}`,
    {
      end: true,
      done: met === criteria.length
    }
  )}<ul class="rp-checks">${shown
    .map(
      (entry) =>
        `<li class="rp-check" data-checked="${entry.checked}" title="${esc(entry.text)}">${icon(
          "circle-check"
        )}<span>${esc(entry.text)}</span></li>`
    )
    .join("")}</ul>${fold}</section>`;
}

/** The tickets and their state; `order` also names the tickets each one waits for. */
export function ticketsMarkup(tickets, { order = false, attributes = "" } = {}) {
  const { rows, merged } = requirementTickets(tickets);
  if (!rows.length) return "";
  return `<section class="rp-section"${attributes}><h3 class="rp-label">${ui`票 ${merged}/${rows.length} 已并入`}</h3><ul class="rp-tickets">${rows
    .map(
      (ticket) =>
        `<li class="rp-ticket" data-ticket-state="${esc(ticket.state)}"><span class="rp-ticket-id">${esc(
          ticket.ticketId
        )}</span><span class="rp-ticket-title" title="${esc(ticket.title)}">${esc(
          ticket.title
        )}</span><span class="rp-spacer"></span>${
          order && ticket.dependsOn.length
            ? `<span class="rp-ticket-after">${esc(ui`在 ${ticket.dependsOn.join("、")} 之后`)}</span>`
            : ""
        }<span class="rp-ticket-state">${esc(ui(ticket.label))}</span></li>`
    )
    .join("")}</ul></section>`;
}

/**
 * The candidate commit and its files. A long change leads with the files that
 * changed most. Where `open` is false the rows are read-only: no diff, no file.
 */
export function changesMarkup({ files = [], commit = "", unfolded, open = true, attributes = "" }) {
  if (!files.length && !commit) return "";
  const long = files.length > FLAT_LIMIT;
  const shown =
    long && !unfolded.has("diff")
      ? [...files]
          .sort(
            (a, b) => Number(b.additions) + Number(b.deletions) - (Number(a.additions) + Number(a.deletions))
          )
          .slice(0, FOLDED_ROWS)
      : files;
  const tag = open ? "button" : "div";
  return `<section class="rp-section"${attributes}>${sectionHead(
    ui("改动"),
    files.length ? String(files.length) : ""
  )}<div class="rp-diff-card">${
    commit
      ? `<div class="rp-diff-commit">${icon("git-commit")}<span>${ui`候选 ${commit}`}</span><span class="rp-spacer"></span>${
          open && files.length
            ? `<button type="button" class="rp-link" data-open-diff>${ui("查看 diff")}</button>`
            : ""
        }</div>`
      : ""
  }${shown
    .map(
      (file) =>
        `<${tag}${open ? ` type="button" data-open-file="${esc(file.path)}"` : ""} class="rp-diff-file${
          open ? "" : " is-static"
        }" title="${esc(file.path)}"><span class="rp-file">${fileIcon(file.path)}<span class="rp-file-name">${esc(
          file.path
        )}</span></span><span class="rp-spacer"></span><span class="rp-add">+${
          Number(file.additions) || 0
        }</span><span class="rp-del">−${Number(file.deletions) || 0}</span></${tag}>`
    )
    .join(
      ""
    )}${long ? foldRow(unfolded, "diff", ui("其余 {count} 个"), files.length - FOLDED_ROWS) : ""}</div></section>`;
}
