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

export function humanAnswer(request, draft = {}) {
  const choice = Number.isInteger(draft.choice) ? request.options?.[draft.choice] : undefined;
  const text = String(draft.text || "").trim();
  return choice && text ? ui`${choice}\n\n补充说明：${text}` : choice || text;
}

const PROPOSAL_SCOPE = { global: "全局", project: "项目" };
const PROPOSAL_PERMISSION = { write: "可写", read: "只读" };

/**
 * A change Main asks the user to approve: the whole Agent definition, then
 * confirm, reject, or edit it in settings. Typed changes go back to Main.
 */
function renderAgentProposal(request, draft, { busy, error, index, total }) {
  const { proposal } = request;
  const definition = proposal.definition;
  const chips = (list) =>
    list.map((name) => `<span class="proposal-chip">${esc(name)}</span>`).join("") || esc(ui("无"));
  const rows = [
    [ui("范围"), `${esc(ui(PROPOSAL_SCOPE[proposal.scope]))}`],
    [ui("使用说明"), esc(definition.description)],
    [ui("权限"), esc(ui(PROPOSAL_PERMISSION[definition.permission]))],
    [ui("模型"), esc(definition.model || ui("沿用角色的模型"))],
    [ui("工具"), definition.tools ? chips(definition.tools) : esc(ui("按权限的默认工具"))],
    [ui("技能"), definition.skills ? chips(definition.skills) : esc(ui("全部技能"))],
    ["MCP", chips(definition.mcp ?? [])],
    ...(definition.prompt
      ? [[ui("附加提示词"), `<span class="proposal-prompt">${esc(definition.prompt)}</span>`]]
      : [])
  ];
  const confirm = request.options?.[0] ?? ui("确认");
  return ui`<form class="human-question-form agent-proposal"><div class="human-card-heading"><span class="human-waiting-dot"></span><strong>等你确认</strong>${total > 1 ? ui`<div class="human-question-pages"><button type="button" data-human-page="-1" aria-label="上一个问题" ${index === 0 ? "disabled" : ""}>‹</button><span>${index + 1} / ${total}</span><button type="button" data-human-page="1" aria-label="下一个问题" ${index === total - 1 ? "disabled" : ""}>›</button></div>` : ""}</div>
    <div class="human-card-body"><h3 id="human-question-title">${esc(request.question)}</h3><p class="proposal-path">写入 ${esc(proposal.path)}</p>
    <dl class="proposal-facts">${rows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("")}</dl>
    <fieldset ${busy ? "disabled" : ""}><legend class="sr-only">修改意见</legend><label class="human-text-label" for="human-answer-text">也可以直接写修改意见，比如「改成只读」</label><textarea id="human-answer-text" name="human-text" rows="2">${esc(draft.text || "")}</textarea></fieldset></div>
    <div class="human-card-footer"><p class="human-error" role="status">${esc(error)}</p><span class="proposal-note">确认后下一次派单即可使用</span>
    <button class="human-secondary" type="button" data-human-answer="${esc(request.options?.[1] ?? ui("拒绝"))}" ${busy ? "disabled" : ""}>拒绝</button>
    <button class="human-secondary" type="button" data-human-edit ${busy ? "disabled" : ""}>在设置里修改</button>
    <button class="human-secondary" type="submit" ${busy || !String(draft.text || "").trim() ? "disabled" : ""}>发送修改意见</button>
    <button class="human-submit" type="button" data-human-answer="${esc(confirm)}" ${busy ? "disabled" : ""}>${esc(confirm)}</button></div></form>`;
}

export function renderHumanQuestion(
  request,
  draft = {},
  { busy = false, error = "", index = 0, total = 1 } = {}
) {
  if (request.proposal?.kind === "agent")
    return renderAgentProposal(request, draft, { busy, error, index, total });
  return ui`<form class="human-question-form"><div class="human-card-heading"><span class="human-waiting-dot"></span><strong>需要你的回复</strong>${total > 1 ? ui`<div class="human-question-pages"><button type="button" data-human-page="-1" aria-label="上一个问题" ${index === 0 ? "disabled" : ""}>‹</button><span>${index + 1} / ${total}</span><button type="button" data-human-page="1" aria-label="下一个问题" ${index === total - 1 ? "disabled" : ""}>›</button></div>` : ""}</div>
    <div class="human-card-body"><h3 id="human-question-title">${esc(request.question)}</h3>${request.context ? `<p class="human-question-context">${esc(request.context)}</p>` : ""}
    <fieldset ${busy ? "disabled" : ""}><legend class="sr-only">你的回答</legend>${request.options?.length ? ui`<div class="human-options" role="radiogroup" aria-label="回答选项">${request.options.map((option, index) => `<label class="human-option${index === request.recommended ? " is-recommended" : ""}"><input type="radio" name="human-choice" value="${index}" ${draft.choice === index ? "checked" : ""}/><span>${esc(option)}</span>${index === request.recommended ? ui('<em class="human-option-mark" title="没有回复时 Formicand 会按这个继续">推荐</em>') : ""}</label>`).join("")}</div>` : ""}
    <label class="human-text-label" for="human-answer-text">${request.options?.length ? ui("其他回答或补充说明") : ui("你的回答")}</label><textarea id="human-answer-text" name="human-text" rows="2">${esc(draft.text || "")}</textarea></fieldset></div>
    <div class="human-card-footer"><p class="human-error" role="status">${esc(error)}</p><button class="human-submit" type="submit" ${busy || !humanAnswer(request, draft) ? "disabled" : ""}>${busy ? ui("正在提交…") : ui("提交并继续")}</button></div></form>`;
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
    `atria.human.v1:${encodeURIComponent(taskId)}:${encodeURIComponent(requestId)}`;
  const storageMessage = ui("人工回复草稿暂时无法保存，请保留当前窗口");
  function persist(key, draft) {
    pendingStorage.set(key, draft);
    try {
      if (draft === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(draft));
      window.bookmanDesktop?.saveComposerDrafts?.();
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
        if (saved && typeof saved.text === "string") {
          draft = { text: saved.text };
          if (Number.isSafeInteger(saved.choice) && saved.choice >= 0) draft.choice = saved.choice;
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
    else if (active.matches('input[name="human-choice"]')) selector = `input[value="${active.value}"]`;
    else if (active.matches("[data-human-page]"))
      selector = `[data-human-page="${active.dataset.humanPage}"]`;
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
    const saveDraft = () => {
      const checked = form.querySelector('input[name="human-choice"]:checked');
      const draft = { text: form.querySelector("textarea").value };
      if (checked) draft.choice = Number(checked.value);
      drafts.set(key, draft);
      persist(key, draft);
      form.querySelector(".human-error").textContent =
        errors.get(key) || (storageErrors.has(key) ? storageMessage : "");
      form.querySelector('[type="submit"]').disabled = busy.has(key) || !humanAnswer(request, draft);
    };
    form.addEventListener("input", saveDraft);
    form.addEventListener("change", saveDraft);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void send(taskId, key, request);
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
    restoreFocus(key, ownedFocus);
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
