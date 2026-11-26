import { icon } from "./ui/icons.js";
import { ui } from "./ui/language.js";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
  );

/**
 * The turn the Dashboard resumes a run with after a question is answered.
 *
 * The model needs the answer as an ordinary user turn — that is how the run
 * continues — but it is not something the person typed into the composer, and
 * showing it as one made their own transcript read as if they had said it
 * twice. Written here so the shape the Dashboard produces and the shape the
 * transcript recognises cannot drift apart.
 */
export const humanAnswerTurn = (question, answer) => ui`关于“${question}”，我的回答是：\n${answer}`;

/**
 * Whether a user turn is a submitted answer rather than something typed.
 *
 * Matched against the answered requests the Task already reports, not by
 * pattern alone: a person who happens to type the same words is still saying
 * it themselves.
 */
export function answeredRequestFor(message, humanRequests = []) {
  const text =
    typeof message?.content === "string"
      ? message.content
      : (message?.content || []).map((part) => part?.text || "").join("");
  if (!text.trim()) return undefined;
  return humanRequests.find(
    (request) =>
      request.status === "answered" &&
      request.answer &&
      text.trim() === humanAnswerTurn(request.question, request.answer).trim()
  );
}

/** Every question in a request, in the order they are answered. */
export const questionsOf = (request) => request.questions ?? [request];

function partAnswer(question, part = {}) {
  const choice = (part.choices ?? [])
    .map((index) => question.options?.[index])
    .filter(Boolean)
    .join("、");
  const text = String(part.text || "").trim();
  return choice && text ? ui`${choice}\n\n补充说明：${text}` : choice || text;
}

/**
 * The one answer a request gets: a proposal's typed change, or every
 * question's choices and words, numbered when there are several. Empty until
 * each question has an answer.
 */
export function humanAnswer(request, draft = {}) {
  if (request.proposal) return String(draft.text || "").trim();
  const questions = questionsOf(request);
  const answers = questions.map((question, index) => partAnswer(question, draft.parts?.[index]));
  if (answers.some((answer) => !answer)) return "";
  if (answers.length === 1) return answers[0];
  return answers.map((answer, index) => `${index + 1}. ${questions[index].question}\n${answer}`).join("\n\n");
}

const pagesFor = (index, total) =>
  total > 1
    ? ui`<span class="human-question-pages"><button type="button" data-human-page="-1" aria-label="上一个问题" ${index === 0 ? "disabled" : ""}>${icon("chevron-left")}</button><span>${index + 1} / ${total}</span><button type="button" data-human-page="1" aria-label="下一个问题" ${index === total - 1 ? "disabled" : ""}>${icon("chevron-right")}</button></span>`
    : "";

/** How long until Main proceeds without an answer; the controller ticks it. */
function countdown(request) {
  if (!request.expiresAt) return "";
  const recommended = questionsOf(request).some((question) => question.recommended?.length);
  const settled = request.status === "unanswered";
  return `<span class="human-countdown" data-expires="${esc(request.expiresAt)}" data-recommended="${recommended ? 1 : 0}" data-settled="${settled ? 1 : 0}"></span>`;
}

export function countdownText(expiresAt, recommended, settled, at = Date.now()) {
  const left = Math.ceil((Date.parse(expiresAt) - at) / 1000);
  if (settled || !(left > 0)) return recommended ? ui("已按推荐继续") : ui("Main 已自行决定");
  const pad = (value) => String(value).padStart(2, "0");
  const minutes = Math.floor(left / 60);
  const time =
    minutes >= 60
      ? `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(left % 60)}`
      : `${minutes}:${pad(left % 60)}`;
  return recommended ? ui`${time} 后按推荐继续` : ui`${time} 后 Main 自行决定`;
}

const feedbackField = (draft, busy, placeholder) =>
  `<label class="sr-only" for="human-answer-text">${esc(ui("修改意见"))}</label><textarea id="human-answer-text" class="human-feedback" name="human-text" rows="1" placeholder="${esc(placeholder)}" ${busy ? "disabled" : ""}>${esc(draft.text || "")}</textarea>`;

/** The footer every confirmation shares: a typed change, reject, confirm. */
function confirmFooter(request, draft, { busy, error }, extra = "") {
  const confirm = request.options?.[0] ?? ui("确认");
  const reject = request.options?.[1] ?? ui("拒绝");
  const typed = String(draft.text || "").trim();
  return ui`<div class="human-card-footer"><p class="human-error" role="status">${esc(error)}</p>${extra}
    <button class="human-secondary" type="button" data-human-answer="${esc(reject)}" ${busy ? "disabled" : ""}>${esc(reject)}</button>
    <button class="human-secondary" type="submit" data-human-feedback ${typed ? "" : "hidden"} ${busy ? "disabled" : ""}>发送修改意见</button>
    <button class="human-submit" type="button" data-human-answer="${esc(confirm)}" ${busy ? "disabled" : ""}>${icon("check")}<span>${esc(confirm)}</span></button></div>`;
}

const confirmHead = (mark, label, index, total) =>
  ui`<div class="human-confirm-head">${icon(mark)}<span>${esc(label)}</span>${pagesFor(index, total)}<span class="proposal-waiting">${icon("circle-alert")}等你确认</span></div>`;

const AGENT_ACTION = {
  create: "创建 Agent",
  update: "修改 Agent",
  disable: "停用 Agent",
  enable: "启用 Agent"
};

/**
 * A change Main asks the user to approve: the Agent's name and file, what it
 * may use in two rows, its prompt folded. Typed changes go back to Main.
 */
function renderAgentProposal(request, draft, { busy, error, index, total }) {
  const { proposal } = request;
  const definition = proposal.definition;
  const chips = (list, mark = "", tone = "") =>
    list
      .map((name) => `<span class="proposal-chip${tone}">${mark ? icon(mark) : ""}${esc(name)}</span>`)
      .join("") || `<span class="proposal-plain">${esc(ui("无"))}</span>`;
  const fact = (label, value) =>
    `<span class="proposal-fact"><span class="proposal-key">${label}</span>${value}</span>`;
  const plain = (text) => `<span class="proposal-plain">${esc(text)}</span>`;
  const tag = (mark, label) => `<span class="proposal-tag">${icon(mark)}${esc(label)}</span>`;
  return ui`<form class="human-question-form human-confirm agent-proposal" aria-labelledby="human-question-title">
    ${confirmHead("bot", ui(AGENT_ACTION[proposal.action] ?? "Agent"), index, total)}
    <div class="human-card-body"><div class="proposal-title"><h3 id="human-question-title" class="is-mono">${esc(definition.name)}</h3><span class="proposal-summary">${esc(definition.description)}</span><span class="proposal-path" title="${esc(proposal.displayPath ?? proposal.path)}">${esc(proposal.displayPath ?? proposal.path)}</span></div>
    <div class="proposal-facts">${fact(ui("范围"), proposal.scope === "project" ? tag("folder", ui("项目")) : tag("globe", ui("全局")))}${fact(ui("权限"), definition.permission === "read" ? tag("eye", ui("只读")) : tag("pencil", ui("可写")))}${fact(ui("模型"), plain(definition.model || ui("沿用角色的模型")))}</div>
    <div class="proposal-facts">${fact(ui("工具"), definition.tools ? chips(definition.tools) : plain(ui("按权限的默认工具")))}${fact("MCP", chips(definition.mcp ?? [], "", " is-ok"))}${fact(ui("技能"), definition.skills ? chips(definition.skills) : plain(ui("全部技能")))}</div>
    ${definition.prompt ? ui`<details class="proposal-prompt"><summary><span class="proposal-key">提示词</span><span class="proposal-prompt-preview">${esc(definition.prompt)}</span>${icon("chevron-down")}</summary><p>${esc(definition.prompt)}</p></details>` : ""}</div>
    ${confirmFooter(request, draft, { busy, error }, `${feedbackField(draft, busy, ui("写修改意见，比如「改成只读」"))}<button class="human-secondary" type="button" data-human-edit ${busy ? "disabled" : ""}>${ui("在设置里修改")}</button>`)}</form>`;
}

/** The order tickets can run in: each step after the ones it depends on. */
export function ticketFlow(tickets) {
  const depth = new Map();
  const level = (ticket, seen = new Set()) => {
    if (depth.has(ticket.ticketId)) return depth.get(ticket.ticketId);
    if (seen.has(ticket.ticketId)) return 0;
    seen.add(ticket.ticketId);
    const parents = (ticket.dependsOn ?? [])
      .map((id) => tickets.find((entry) => entry.ticketId === id))
      .filter(Boolean);
    const value = parents.length ? 1 + Math.max(...parents.map((parent) => level(parent, seen))) : 0;
    depth.set(ticket.ticketId, value);
    return value;
  };
  const steps = [];
  for (const ticket of tickets) (steps[level(ticket)] ??= []).push(ticket.ticketId);
  return steps.filter(Boolean);
}

/**
 * Tickets Main asks the user to confirm before their acceptance criteria are
 * frozen, or one change to a frozen ticket with the reason for it: the order
 * they run in, then each ticket folded to its scope until opened.
 */
function renderTicketProposal(request, draft, { busy, error, index, total }) {
  const { proposal } = request;
  const previous = proposal.previous;
  const none = `<span class="proposal-plain">${esc(ui("无"))}</span>`;
  const lines = (items) =>
    items?.length
      ? `<ul class="ticket-lines">${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`
      : none;
  const chips = (items) =>
    items?.length ? items.map((item) => `<span class="proposal-chip">${esc(item)}</span>`).join("") : none;
  const criteria = (items) =>
    `<ol class="ticket-lines">${(items ?? [])
      .map(
        (item) =>
          `<li>${esc(item.text)}<span class="ticket-check">${
            item.check?.command
              ? `<code>${esc(item.check.command)}</code>`
              : esc(ui`人工检查：${item.check?.manual ?? ""}`)
          }</span></li>`
      )
      .join("")}</ol>`;
  const changed = (field) =>
    previous && JSON.stringify(previous[field]) !== JSON.stringify(proposal.tickets[0]?.[field]);
  const mark = (field) => (changed(field) ? ` <span class="proposal-tag">${esc(ui("已修改"))}</span>` : "");
  const row = (field, label, value) => `<dt>${label}${mark(field)}</dt><dd>${value}</dd>`;
  const scope = (items = []) =>
    items
      .slice(0, 2)
      .map((item) => `<span class="proposal-chip">${icon("folder")}${esc(item)}</span>`)
      .join("") + (items.length > 2 ? `<span class="proposal-plain">+${items.length - 2}</span>` : "");
  const ticket = (entry, position) => `<details class="ticket-card" ${position === 0 ? "open" : ""}>
    <summary>${icon("chevron-right")}<span class="proposal-chip">${esc(entry.ticketId)}</span><span class="ticket-title">${esc(entry.title)}</span><span class="ticket-scope">${scope(entry.scope)}</span><span class="ticket-count">${esc(ui`${(entry.criteria ?? []).length} 条验收`)}</span></summary>
    <dl class="ticket-detail">${[
      row("criteria", ui("验收标准"), criteria(entry.criteria)),
      // The folded row already shows up to two paths.
      ...((entry.scope ?? []).length > 2 || changed("scope")
        ? [row("scope", ui("改动范围"), chips(entry.scope))]
        : []),
      row("preserve", ui("保留不变"), lines(entry.preserve)),
      row("outOfScope", ui("本次不做"), lines(entry.outOfScope)),
      ...(entry.dependsOn?.length || changed("dependsOn")
        ? [row("dependsOn", ui("先完成"), chips(entry.dependsOn))]
        : [])
    ].join("")}</dl></details>`;
  const steps = ticketFlow(proposal.tickets);
  const flow =
    proposal.tickets.length > 1
      ? `<span class="ticket-flow" title="${esc(ui("箭头前的先做，加号连着的可以同时做"))}">${steps
          .map((group) =>
            group.map((id) => `<span class="proposal-chip">${esc(id)}</span>`).join("<span>+</span>")
          )
          .join(icon("arrow-right"))}</span>`
      : "";
  return ui`<form class="human-question-form human-confirm ticket-proposal" aria-labelledby="human-question-title">
    ${confirmHead("list-checks", proposal.action === "revise" ? ui("修改已确认的票") : ui("确认要做的票"), index, total)}
    <div class="human-card-body"><div class="proposal-title"><h3 id="human-question-title">${esc(proposal.requirementTitle)}</h3>${flow}</div>
    ${proposal.reason ? `<p class="human-question-context">${esc(ui`修改理由：${proposal.reason}`)}</p>` : ""}<div class="ticket-list">${proposal.tickets.map(ticket).join("")}</div></div>
    ${confirmFooter(request, draft, { busy, error }, feedbackField(draft, busy, ui("写修改意见，比如「02 和 03 合成一张」")))}</form>`;
}

/**
 * Main's own questions: numbered options the keyboard can pick, the last row
 * typed, and when there are several, steps answered one after another and
 * sent together.
 */
function renderAsk(request, draft, { busy, error, index, total }) {
  const questions = questionsOf(request);
  const step = Math.min(Math.max(0, draft.step ?? 0), questions.length - 1);
  const question = questions[step];
  const part = draft.parts?.[step] ?? {};
  const options = question.options ?? [];
  const many = questions.length > 1;
  const last = step === questions.length - 1;
  const kind = question.multiple ? "checkbox" : "radio";
  const steps = many
    ? `<div class="human-steps" role="tablist" aria-label="${esc(ui("问题"))}">${questions
        .map((entry, at) => {
          const answer = partAnswer(entry, draft.parts?.[at]);
          const state = at === step ? "is-current" : answer ? "is-answered" : "";
          return `<button type="button" role="tab" class="human-step ${state}" data-human-step="${at}" aria-selected="${at === step}"><span class="human-step-mark">${answer && at !== step ? icon("check") : at + 1}</span><span class="human-step-label">${esc(entry.label || entry.question)}</span>${answer && at !== step ? `<span class="human-step-answer">${esc(answer.split("\n")[0])}</span>` : ""}</button>`;
        })
        .join("")}</div>`
    : "";
  const option = (text, at) => {
    const recommended = question.recommended?.includes(at);
    const checked = part.choices?.includes(at);
    return `<label class="human-option${checked ? " is-checked" : ""}"><kbd aria-hidden="true">${at + 1}</kbd><input type="${kind}" name="human-choice" value="${at}" ${checked ? "checked" : ""}/><span class="human-option-text">${esc(text)}</span>${recommended ? ui('<em class="human-option-mark">推荐</em>') : ""}<span class="human-option-box" aria-hidden="true">${kind === "checkbox" ? icon("check") : ""}</span></label>`;
  };
  const count = (part.choices ?? []).length;
  const hint = options.length
    ? question.multiple
      ? ui("数字键勾选")
      : ui("数字键选择")
    : ui("Shift+回车换行");
  const forward = many && !last;
  return ui`<form class="human-question-form human-ask" aria-labelledby="human-question-title">${steps}
    <div class="human-card-body"><div class="human-ask-title"><h3 id="human-question-title">${esc(question.question)}</h3>${question.multiple ? ui('<span class="proposal-tag">可多选</span>') : ""}<span class="human-ask-aside">${pagesFor(index, total)}${countdown(request)}</span></div>
    ${question.context ? `<p class="human-question-context">${esc(question.context)}</p>` : ""}
    <fieldset ${busy ? "disabled" : ""}><legend class="sr-only">你的回答</legend><div class="human-options" role="${question.multiple ? "group" : "radiogroup"}" aria-labelledby="human-question-title">${options.map(option).join("")}
    <label class="human-option human-option-other">${options.length ? `<kbd aria-hidden="true">${options.length + 1}</kbd>` : ""}<textarea id="human-answer-text" name="human-text" rows="1" aria-label="${esc(options.length ? ui("其他回答或补充说明") : ui("你的回答"))}" placeholder="${esc(options.length ? ui("其他回答，或补充说明…") : ui("你的回答"))}">${esc(part.text || "")}</textarea></label></div></fieldset></div>
    <div class="human-card-footer"><span class="human-hint">${esc(hint)} · ${esc(forward ? ui("回车下一个") : ui("回车发送"))}</span><p class="human-error" role="status">${esc(error)}</p>${question.multiple ? `<span class="human-count" data-human-count>${esc(ui`已选 ${count} 项`)}</span>` : ""}
    ${many ? `<button class="human-secondary" type="button" data-human-move="-1" ${step === 0 || busy ? "disabled" : ""}>${icon("arrow-left")}<span>${esc(ui("上一个"))}</span></button>` : ""}
    ${forward ? `<button class="human-submit" type="button" data-human-move="1" ${busy ? "disabled" : ""}><span>${esc(ui("下一个"))}</span>${icon("arrow-right")}</button>` : `<button class="human-submit" type="submit" ${busy || !humanAnswer(request, draft) ? "disabled" : ""}>${busy ? esc(ui("正在提交…")) : `${icon("arrow-up")}<span>${esc(ui("发送"))}</span>`}</button>`}</div></form>`;
}

export function renderHumanQuestion(
  request,
  draft = {},
  { busy = false, error = "", index = 0, total = 1 } = {}
) {
  if (request.proposal?.kind === "agent")
    return renderAgentProposal(request, draft, { busy, error, index, total });
  if (request.proposal?.kind === "tickets")
    return renderTicketProposal(request, draft, { busy, error, index, total });
  return renderAsk(request, draft, { busy, error, index, total });
}

/** Keep form DOM and drafts stable across polling, navigation and restarts. */
export function createHumanQuestions(root, { submit, resume, onVisibility, onError, onEditProposal }) {
  const drafts = new Map();
  const pendingStorage = new Map();
  const storageErrors = new Set();
  const errors = new Map();
  const busy = new Set();
  const selected = new Map();
  const retainedFocus = new Map();
  let detail;
  let signature;
  let displayedKey;
  let displayedTaskId;
  const keyFor = (taskId, requestId) =>
    `formicand.human.v1:${encodeURIComponent(taskId)}:${encodeURIComponent(requestId)}`;
  const storageMessage = ui("人工回复草稿暂时无法保存，请保留当前窗口");
  function persist(key, draft) {
    pendingStorage.set(key, draft);
    try {
      if (draft === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(draft));
      window.formicandDesktop?.saveComposerDrafts?.();
      pendingStorage.delete(key);
      storageErrors.delete(key);
      // eslint-disable-next-line no-restricted-syntax -- localStorage 被禁用或配额耗尽时写入抛出，草稿留在内存并由 onError 提示一次
    } catch {
      if (!storageErrors.has(key)) onError?.(storageMessage);
      storageErrors.add(key);
    }
  }
  function draftFor(key) {
    if (!drafts.has(key)) {
      let draft = {};
      try {
        const saved = JSON.parse(localStorage.getItem(key) ?? "null");
        const index = (value) => Number.isSafeInteger(value) && value >= 0;
        if (saved && typeof saved === "object") {
          if (typeof saved.text === "string") draft.text = saved.text;
          if (index(saved.step)) draft.step = saved.step;
          if (Array.isArray(saved.parts))
            draft.parts = saved.parts.map((part) => ({
              choices: Array.isArray(part?.choices) ? part.choices.filter(index) : [],
              text: typeof part?.text === "string" ? part.text : ""
            }));
        }
        // eslint-disable-next-line no-restricted-syntax -- 存储被禁用或草稿 JSON 损坏时读取与解析都会抛出，此时不预选任何答案
      } catch {
        /* An unreadable draft does not preselect an answer. */
      }
      drafts.set(key, draft);
    }
    return drafts.get(key);
  }
  function rememberFocus(key) {
    const active = document.activeElement;
    if (!root.contains(active) || active === root) return;
    let selector;
    if (active.matches("textarea")) selector = "textarea";
    else if (active.matches('input[name="human-choice"]'))
      selector = `input[name="human-choice"][value="${active.value}"]`;
    else if (active.matches("[data-human-page]"))
      selector = `[data-human-page="${active.dataset.humanPage}"]`;
    else if (active.matches("[data-human-step]"))
      selector = `[data-human-step="${active.dataset.humanStep}"]`;
    else if (active.matches("[data-human-move]")) selector = ".human-card-footer .human-submit";
    else if (active.matches(".human-submit")) selector = ".human-submit";
    if (!selector) return;
    retainedFocus.set(key, {
      selector,
      start: active.selectionStart,
      end: active.selectionEnd,
      direction: active.selectionDirection,
      scroll: root.querySelector(".human-card-body")?.scrollTop ?? 0
    });
  }
  function restoreFocus(key, ownedFocus) {
    if (!ownedFocus || key !== displayedKey) return;
    const saved = retainedFocus.get(key);
    const target = saved && root.querySelector(saved.selector);
    if (target && !target.matches(":disabled")) {
      target.focus({ preventScroll: true });
      if (target.matches("textarea") && Number.isInteger(saved.start))
        target.setSelectionRange(saved.start, saved.end, saved.direction);
      const body = root.querySelector(".human-card-body");
      if (body) body.scrollTop = saved.scroll;
    } else if (saved) {
      // A submitting form is disabled. Keep focus here so a failed submission
      // can restore its initiating control without taking focus from elsewhere.
      root.tabIndex = -1;
      root.focus({ preventScroll: true });
    }
  }
  function render() {
    const taskId = detail?.task?.taskId;
    // Late answers still reach Main after it has proceeded on the recommendation.
    const pending =
      detail?.task?.status === "cancelled"
        ? []
        : (detail?.humanRequests || []).filter(
            (request) => request.status === "pending" || request.status === "unanswered"
          );
    const resumeNeeded = Boolean(detail?.humanResumePending);
    const visible = pending.length > 0 || resumeNeeded;
    const index = Math.max(
      0,
      pending.findIndex((request) => request.requestId === selected.get(taskId))
    );
    const request = pending[index];
    const key = keyFor(taskId, request?.requestId || "resume");
    const draft = request ? draftFor(key) : undefined;
    const error = errors.get(key) || (storageErrors.has(key) ? storageMessage : "");
    const next = JSON.stringify([taskId, pending, resumeNeeded, index, busy.has(key), error]);
    const ownedFocus = displayedKey === key && root.contains(document.activeElement);
    // A newly shown card hides the composer; unless the person is typing
    // elsewhere, its first answer control takes focus so Enter answers it.
    const active = document.activeElement;
    const takeFocus =
      displayedKey !== key && (!active || active === document.body || Boolean(active.closest(".composer")));
    const leavingQuestion = !visible && displayedTaskId === taskId && root.contains(document.activeElement);
    if (signature !== next) rememberFocus(displayedKey);
    root.hidden = !visible;
    onVisibility(visible, pending.length);
    if (signature === next) return;
    signature = next;
    displayedKey = key;
    displayedTaskId = taskId;
    if (!visible) {
      root.innerHTML = "";
      if (leavingQuestion) document.querySelector("#composer-input")?.focus({ preventScroll: true });
      return;
    }
    if (!request) {
      root.innerHTML = ui`<div class="human-card-heading"><strong>回答已保存</strong></div><p class="human-question-context">Formicand 尚未继续运行，可以重试。</p><div class="human-card-footer"><p class="human-error" role="status">${esc(error)}</p><button class="human-submit" data-human-resume ${busy.has(key) ? "disabled" : ""}>${busy.has(key) ? ui("正在继续…") : ui("继续运行")}</button></div>`;
      root.querySelector("[data-human-resume]").addEventListener("click", () => void send(taskId, key));
      restoreFocus(key, ownedFocus);
      return;
    }
    root.innerHTML = renderHumanQuestion(request, draft, {
      busy: busy.has(key),
      error,
      index,
      total: pending.length
    });
    root.querySelectorAll("[data-human-page]").forEach((button) =>
      button.addEventListener("click", () => {
        selected.set(taskId, pending[index + Number(button.dataset.humanPage)].requestId);
        render();
      })
    );
    const form = root.querySelector("form");
    const steps = request.proposal ? 1 : questionsOf(request).length;
    const goTo = (step) => {
      const current = draftFor(key);
      const next = { ...current, step: Math.min(Math.max(0, step), steps - 1) };
      drafts.set(key, next);
      persist(key, next);
      signature = undefined;
      render();
      root.querySelector('input[name="human-choice"], textarea')?.focus({ preventScroll: true });
    };
    const saveDraft = () => {
      const current = draftFor(key);
      const text = form.querySelector("textarea")?.value ?? "";
      let draft;
      if (request.proposal) draft = { text };
      else {
        const step = Math.min(current.step ?? 0, steps - 1);
        const parts = Array.from(
          { length: steps },
          (_, at) => current.parts?.[at] ?? { choices: [], text: "" }
        );
        const choices = [...form.querySelectorAll('input[name="human-choice"]:checked')].map((input) =>
          Number(input.value)
        );
        parts[step] = { choices, text };
        draft = { step, parts };
        form
          .querySelectorAll(".human-option")
          .forEach((label) =>
            label.classList.toggle("is-checked", Boolean(label.querySelector("input:checked")))
          );
        const count = form.querySelector("[data-human-count]");
        if (count) count.textContent = ui`已选 ${choices.length} 项`;
      }
      drafts.set(key, draft);
      persist(key, draft);
      form.querySelector(".human-error").textContent =
        errors.get(key) || (storageErrors.has(key) ? storageMessage : "");
      const submit = form.querySelector('.human-submit[type="submit"]');
      if (submit) submit.disabled = busy.has(key) || !humanAnswer(request, draft);
      const feedback = form.querySelector("[data-human-feedback]");
      if (feedback) feedback.hidden = !text.trim();
    };
    form.addEventListener("input", saveDraft);
    form.addEventListener("change", saveDraft);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (humanAnswer(request, draftFor(key))) void send(taskId, key, request);
    });
    form
      .querySelectorAll("[data-human-step]")
      .forEach((button) => button.addEventListener("click", () => goTo(Number(button.dataset.humanStep))));
    form
      .querySelectorAll("[data-human-move]")
      .forEach((button) =>
        button.addEventListener("click", () =>
          goTo((draftFor(key).step ?? 0) + Number(button.dataset.humanMove))
        )
      );
    // Numbers pick an option (the one after the last is the typed answer);
    // Enter moves on or sends, Shift+Enter is a new line.
    form.addEventListener("keydown", (event) => {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      const typing = event.target.matches("textarea");
      const choices = [...form.querySelectorAll('input[name="human-choice"]')];
      if (!typing && /^[1-9]$/.test(event.key) && choices.length) {
        const at = Number(event.key) - 1;
        if (at < choices.length) {
          event.preventDefault();
          choices[at].click();
          choices[at].focus({ preventScroll: true });
        } else if (at === choices.length) {
          event.preventDefault();
          form.querySelector("textarea")?.focus();
        }
        return;
      }
      if (event.key !== "Enter" || event.shiftKey || event.target.matches("button, summary")) return;
      event.preventDefault();
      const forward = form.querySelector('[data-human-move="1"]');
      if (forward) forward.click();
      // A proposal with nothing typed has one answer to Enter: confirm it.
      else if (request.proposal && !humanAnswer(request, draftFor(key)))
        form.querySelector(".human-submit[data-human-answer]")?.click();
      else form.requestSubmit();
    });
    // A proposal's buttons answer directly: confirm, reject, or edit it in settings.
    form
      .querySelectorAll("[data-human-answer]")
      .forEach((button) =>
        button.addEventListener("click", () => void send(taskId, key, request, button.dataset.humanAnswer))
      );
    form.querySelector("[data-human-edit]")?.addEventListener("click", () => {
      void send(taskId, key, request, ui("我会在设置里自己修改，这次不要保存"));
      onEditProposal?.(request.proposal);
    });
    tick();
    restoreFocus(key, ownedFocus);
    if (takeFocus)
      (request.proposal
        ? form.querySelector(".human-submit[data-human-answer]")
        : form.querySelector('input[name="human-choice"]:checked, input[name="human-choice"], textarea')
      )?.focus({ preventScroll: true });
  }
  async function send(taskId, key, request, chosen) {
    if (busy.has(key)) return;
    const answer = request && (chosen ?? humanAnswer(request, draftFor(key)));
    if (request && !answer) return;
    busy.add(key);
    errors.delete(key);
    render();
    try {
      const result = request ? await submit(taskId, request.requestId, answer) : await resume(taskId);
      const outcome = result.resume || result;
      if (outcome.status === "error")
        errors.set(keyFor(taskId, "resume"), outcome.error || ui("继续运行失败，请重试。"));
      if (request) {
        drafts.delete(key);
        persist(key, null);
      }
    } catch (error) {
      errors.set(key, error.message || ui("提交失败，请重试。"));
    } finally {
      busy.delete(key);
      render();
    }
  }
  const tick = () => {
    if (root.hidden) return;
    for (const node of root.querySelectorAll("[data-expires]"))
      node.textContent = countdownText(
        node.dataset.expires,
        node.dataset.recommended === "1",
        node.dataset.settled === "1"
      );
  };
  setInterval(tick, 1000);
  return {
    update(value) {
      detail = value;
      render();
    },
    flushDrafts() {
      for (const [key, draft] of [...pendingStorage]) persist(key, draft);
      render();
      return pendingStorage.size === 0;
    }
  };
}
