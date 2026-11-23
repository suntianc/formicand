import { atConversationEnd } from "./conversation-layout.js";
import { createConversationActivityView, liveClockText } from "./conversation-activity-view.js";
import { language, ui } from "../ui/language.js";
import { confirmCopied, copyText } from "../ui/code-blocks.js";
import { createConversationProjection } from "./conversation-projection.js";
import { splitUploadedFiles } from "../uploaded-files.js";
import { markReferences, splitReferences } from "../references.js";
import { modelErrorDiagnostic, modelPolicyRejection, requestErrorMessage } from "../request-error.js";
import { assistantDisplayContent } from "../activity.js";
import { finalAnswerIndex, isMachineTurn, exchangeExecutionState } from "../conversation.js";
import { answeredRequestFor } from "../human-questions.js";
import { renderMarkdown } from "../markdown.js";
import { resolveArtifactLink } from "../artifacts.js";
import { escapeHtml as esc } from "../ui/html.js";
import { icon } from "../ui/icons.js";
import { executionElapsedMs } from "../execution-time.js";
import { reconcileParts } from "../ui/reconcile.js";
import { animate } from "../ui/motion.js";
import { createStreamReveal } from "../ui/stream-reveal.js";
import { contextWindowDividers } from "../ui/context-window.js";

const reducedMotion = () => {
  const preference = globalThis.window?.atriaPreferences?.motion?.();
  if (preference === "on") return true;
  if (preference === "off") return false;
  return Boolean(globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
};

const replyClock = new Intl.DateTimeFormat(language, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});
const replyDay = new Intl.DateTimeFormat(language, { month: "short", day: "numeric" });
const replyFull = new Intl.DateTimeFormat(language, {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "long",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

/** 18:50 today; the day too once it is not today. */
function replyTime(timestamp, now = new Date()) {
  const when = new Date(timestamp);
  const today = when.toDateString() === now.toDateString();
  return {
    short: today ? replyClock.format(when) : `${replyDay.format(when)} ${replyClock.format(when)}`,
    full: replyFull.format(when),
    iso: when.toISOString()
  };
}

function latestModelRetry(events) {
  const retry = events
    .map((record) => (record?.type === "runtime_event" ? record.payload : record))
    .findLast((event) => ["auto_retry_start", "auto_retry_end"].includes(event?.type));
  return retry && Number.isInteger(retry.attempt) && retry.attempt > 0 ? retry : undefined;
}

/**
 * What the person typed, shown as typed. Read as Markdown, a pasted list with
 * indented, hard-wrapped items turned every number into "1." and split
 * sentences into paragraphs; like Codex, the prompt keeps its own lines.
 */
function typedTextOf(text, references = []) {
  const shown = text.replace(/\s+$/, "");
  return shown ? `<div class="user-text">${markReferences(shown, references, esc)}</div>` : "";
}

/**
 * A sent message's parts: the typed words for the bubble, and its uploads,
 * which sit above the bubble as cards (an image as its thumbnail), as Codex
 * shows a prompt with files.
 */
function renderUserText(source, markdown) {
  // `/` and `@` words are marked where they stand; the manifest in front is for Main.
  const { text, references } = splitReferences(source);
  const typedText = (words) => typedTextOf(words, references);
  const uploaded = splitUploadedFiles(text);
  if (uploaded.files.length)
    return {
      body: typedText(uploaded.text),
      uploads: `<div class="message-attachments message-uploads">${uploaded.files
        .map(
          (file) =>
            `<button type="button" class="${file.kind === "image" ? "upload-card is-image" : "upload-card"}" data-upload-preview="${esc(file.uploadId)}" title="${esc(file.name)}">${file.kind === "image" ? `<img data-upload-src="${esc(file.uploadId)}" alt="" />` : icon("paperclip")}<span>${esc(file.name)}</span></button>`
        )
        .join("")}</div>`
    };

  const marker = "\n\nAttached files:\n";
  const boundary = text.indexOf(marker);
  if (boundary < 0) return { body: typedText(text), uploads: "" };
  const attachments = text.slice(boundary + marker.length);
  return {
    body: ui`${typedText(text.slice(0, boundary))}<details class="message-attachments"><summary>查看附件内容</summary>${markdown(attachments)}</details>`,
    uploads: ""
  };
}

function stoppedRequestFailure(task, detail, exchange, submitting) {
  // A paused step aborts its model operation by design; that terminal error is
  // the pause boundary, not a failure the person can retry from a card.
  if (task.status === "paused") return;
  if (detail?.runtime?.active || submitting || ["completed", "cancelled"].includes(task.status)) return;
  const persisted = exchange?.messages.findLast((message) => message.role === "assistant");
  const streamed = exchange?.events
    .map((record) => (record?.type === "runtime_event" ? record.payload : record))
    .findLast(
      (event) =>
        ["message_start", "message_end", "turn_end"].includes(event?.type) &&
        event.message?.role === "assistant"
    )?.message;
  const latest =
    persisted &&
    streamed &&
    Number.isFinite(persisted.timestamp) &&
    Number.isFinite(streamed.timestamp) &&
    persisted.timestamp > streamed.timestamp
      ? persisted
      : streamed || persisted;
  if (task.status !== "failed" && latest?.stopReason !== "error") return;
  const terminal =
    task.activeRunId && Array.isArray(detail?.events)
      ? detail.events.findLast(
          (event) => event?.runId === task.activeRunId && event.type === "main.run_failed"
        )
      : undefined;
  const failureKind = terminal?.payload?.failure?.kind;
  if (failureKind === "main_process")
    return {
      title: ui("执行进程退出"),
      message: ui("本次执行进程未能正常结束。")
    };
  const raw = String((task.status === "failed" && task.lastError) || latest?.errorMessage || "");
  const errorType = modelErrorDiagnostic(raw, terminal?.payload?.failure?.httpStatus);
  const policy = modelPolicyRejection(raw);
  if (policy)
    return {
      title: ui("模型服务安全策略拒绝"),
      errorType,
      message: policy,
      suggestRetry: false
    };
  const httpStatus = terminal?.payload?.failure?.httpStatus;
  const modelStatus =
    failureKind === "model_request" && Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599
      ? httpStatus
      : undefined;
  // A status in the typed terminal event is evidence. Digits inside a raw
  // provider identifier or URL are not an HTTP status by themselves.
  const diagnostic =
    failureKind === "model_request" && !modelStatus
      ? raw.replace(/\b[45]\d{2}\b/g, "")
      : modelStatus
        ? String(modelStatus)
        : raw;
  const classified =
    modelStatus === 400
      ? ui("模型服务拒绝了本次请求（HTTP 400），请检查模型及请求参数后重试。")
      : modelStatus === 403
        ? ui("模型服务拒绝访问（HTTP 403），请检查当前连接的访问权限。")
        : modelStatus === 404
          ? terminal?.payload?.failure?.providerCode === "model_not_found"
            ? ui(
                "当前 API 账号或分组无法使用此模型（HTTP 404），请确认服务商的模型权限及可用状态，或选择可用的模型后重试。"
              )
            : ui("模型接口或模型未找到（HTTP 404），请检查 API 地址、模型 ID 及服务商的模型可用状态。")
          : modelStatus && ![401, 429, 500, 502, 503, 504].includes(modelStatus)
            ? ui`模型服务返回错误（HTTP ${modelStatus}），本次请求未能完成。`
            : requestErrorMessage(diagnostic);
  const interrupted =
    /连接已中断/.test(classified) ||
    (classified === diagnostic &&
      /upstream|HTTP\/2|stream.*fail|Failed to fetch|NetworkError|fetch failed|ECONN|ETIMEDOUT|socket|connection.*(?:reset|closed|failed)/i.test(
        raw
      ));
  const retry = latestModelRetry(exchange?.events || []);
  const exhausted = retry?.type === "auto_retry_end" && retry.success === false;
  return {
    retryCount: retry?.attempt ?? 0,
    title: interrupted
      ? ui("模型连接中断")
      : failureKind === "model_request"
        ? ui("模型请求未完成")
        : ui("任务失败"),
    errorType: errorType || (interrupted ? ui("连接中断") : ui("原因未确定")),
    // Unknown provider errors can contain URLs, headers or keys. Only known
    // classifications reach the UI; durable logs retain the original error.
    message:
      (exhausted ? ui`已自动重试 ${retry.attempt} 次，本次请求仍未完成。` : "") +
      (classified !== diagnostic
        ? classified
        : interrupted
          ? ui("本次请求未能完成。")
          : failureKind === "model_request"
            ? ui("本次模型请求未能完成，原因尚未确定。")
            : ui("本次运行未能完成，请检查模型连接后重试。"))
  };
}

/** Renders conversation history; networking and application windows are supplied by the page. */
export function createConversationView({
  state,
  $,
  textContent,
  retry,
  edit,
  messageEdit,
  openArtifact,
  fork,
  resolveFile,
  showToast = () => {}
}) {
  const streamReveal = createStreamReveal();
  const activityStates = new Map();
  const markdown = (source, options = {}) =>
    renderMarkdown(source, {
      resolveLocalLink: (path) => resolveArtifactLink(state.detail, path),
      resolveFile,
      ...options
    });
  const hasOpenActivity = (prefix) => {
    const match = `${prefix}:`;
    for (const [key, entry] of activityStates) if (entry?.open && key.startsWith(match)) return true;
    return false;
  };
  const isHistoryOpenFor = (key) => {
    if (state.executionHistoryOpen.has(key)) return Boolean(state.executionHistoryOpen.get(key));
    return hasOpenActivity(key);
  };
  const { renderLiveActivity, renderThinkingPlaceholder } = createConversationActivityView({
    markdown,
    activityContext: () => ({ taskId: state.selected, detail: state.detail }),
    isHistoryOpen: isHistoryOpenFor,
    isActivityOpen: (key) => Boolean(activityStates.get(key)?.open)
  });
  const visibleText = (content) =>
    Array.isArray(content)
      ? content
          .map((part) => (typeof part === "string" ? part : part?.type === "text" ? part.text || "" : ""))
          .join("")
      : String(textContent(content) || "");
  /**
   * The bar under a settled reply: copy its Markdown, fork the conversation
   * from it, and when it was written. The latest reply keeps it in full view;
   * earlier ones show it faintly until the reply is hovered.
   */
  // Under a sent message, as Codex shows it: when it was sent, copy, and edit
  // for the one message that can still be edited.
  const userActions = (message, editable) => {
    const time = Number.isFinite(message.timestamp) ? replyTime(message.timestamp) : undefined;
    return `<div class="user-message-actions" role="toolbar" aria-label="${ui("消息操作")}">${
      time
        ? `<time class="user-message-time" datetime="${esc(time.iso)}" title="${esc(time.full)}">${esc(time.short)}</time>`
        : ""
    }<button type="button" class="app-button" data-user-copy aria-label="${ui("复制消息")}" title="${ui("复制消息")}">${icon("copy")}</button>${
      editable
        ? `<button type="button" class="app-button" data-edit-message="${esc(message.id)}" aria-label="${ui("编辑消息")}" title="${ui("编辑消息")}">${icon("pencil")}</button>`
        : ""
    }</div>`;
  };
  const replyActions = (message, latest) => {
    const time = Number.isFinite(message.timestamp) ? replyTime(message.timestamp) : undefined;
    return `<div class="reply-actions${latest ? " is-latest" : ""}" role="toolbar" aria-label="${ui("回复操作")}"><button type="button" class="reply-action" data-reply-copy title="${ui("复制回复")}" aria-label="${ui("复制回复")}">${icon("copy")}</button>${
      message.id && fork
        ? `<button type="button" class="reply-action" data-reply-fork="${esc(message.id)}" title="${ui("从这条回复 Fork 出新会话")}">${icon("git-branch")}<span>Fork</span></button>`
        : ""
    }${
      time
        ? `<span class="reply-time" tabindex="0"><time datetime="${esc(time.iso)}">${esc(time.short)}</time><span class="reply-time-full" role="tooltip">${esc(time.full)}</span></span>`
        : ""
    }</div>`;
  };
  const errorDetailsOpen = new Set();
  const boundNodes = new WeakSet();
  let lastRenderArgs;
  // What the conversation's children were built from: one markup string per
  // exchange, how many top-level nodes each became, and the trailing parts.
  let lastRender;
  // The messages already on screen for the conversation shown, so only a
  // message that arrives while it is open slides in. Opening a conversation
  // fades it in as a whole instead of replaying every message.
  let shownMessages = { taskId: undefined, keys: new Set(), count: 0 };
  function animateArrivals(scroll, taskId) {
    const articles = [...scroll.querySelectorAll(".chat-message[data-view-key]")];
    const keys = articles.map((article) => article.dataset.viewKey);
    const opened = shownMessages.taskId !== taskId;
    const grew = !opened && articles.length > shownMessages.count;
    const arrived = opened
      ? []
      : articles.filter((article) => !shownMessages.keys.has(article.dataset.viewKey));
    shownMessages = { taskId, keys: new Set(keys), count: articles.length };
    if (reducedMotion()) return;
    if (opened && articles.length)
      animate(scroll, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
    // A message whose key changed in place (a local message confirmed by the
    // server) does not add to the count and stays still.
    if (grew)
      for (const article of arrived)
        animate(
          article,
          [
            { opacity: 0, transform: "translateY(6px)" },
            { opacity: 1, transform: "none" }
          ],
          { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }
        );
  }
  let historyMarkup = new Map();
  let renderedEditTask;
  // The newest message sent from this page that the view has already scrolled
  // to. Sending scrolls to the end once; after that the reader's position
  // decides, so scrolling up while a reply streams is not pulled back (#24).
  let followedLocal;
  const thinkingStartedAt = new Map();
  const resumeThinkingAnimations = (scroll) => {
    const activeKeys = new Set();
    const now = performance.now();
    for (const node of scroll.querySelectorAll("[data-thinking-key]")) {
      const key = node.dataset.thinkingKey;
      activeKeys.add(key);
      const startedAt = thinkingStartedAt.get(key) ?? now;
      thinkingStartedAt.set(key, startedAt);
      // innerHTML replaces the spinner on new deltas. Reuse its elapsed time
      // without adding style attributes that would invalidate markup equality.
      for (const animation of node.getAnimations?.({ subtree: true }) || [])
        animation.currentTime = now - startedAt;
    }
    for (const key of thinkingStartedAt.keys()) if (!activeKeys.has(key)) thinkingStartedAt.delete(key);
  };
  const detailsOpen = (node) => (typeof node.open === "boolean" ? node.open : node.hasAttribute("open"));
  const readable = (node) => {
    if (!detailsOpen(node)) return false;
    for (let parent = node.parentElement; parent; parent = parent.parentElement)
      if (parent.tagName === "DETAILS" && !detailsOpen(parent)) return false;
    return true;
  };
  const readingCopies = (node) =>
    [...node.querySelectorAll(".reasoning-copy, .tool-copy, .activity-raw-copy")].filter(
      (copy) => copy.closest("details[data-activity-key]") === node
    );
  const restoreReadingPosition = (node) => {
    const saved = activityStates.get(node.dataset.activityKey);
    if (!saved || !readable(node)) return;
    for (const [index, copy] of readingCopies(node).entries()) {
      const position = saved.positions?.[copy.dataset.readingKey || index];
      if (!position) continue;
      copy.scrollTop = position.scrollTop;
      copy.scrollLeft = position.scrollLeft;
    }
  };
  const rememberActivity = (node) => {
    const saved = activityStates.get(node.dataset.activityKey);
    const copies = readable(node) ? readingCopies(node) : [];
    activityStates.set(node.dataset.activityKey, {
      open: detailsOpen(node),
      positions: copies.length
        ? Object.fromEntries(
            copies.map((copy, index) => [
              copy.dataset.readingKey || index,
              {
                scrollTop: copy.scrollTop || 0,
                scrollLeft: copy.scrollLeft || 0
              }
            ])
          )
        : saved?.positions || {}
    });
  };
  const isLazyDisclosure = (node) =>
    node.classList.contains("execution-history") ||
    node.classList.contains("process-segment") ||
    node.classList.contains("tool-details") ||
    node.classList.contains("subagent-step") ||
    node.classList.contains("reasoning-details") ||
    node.classList.contains("activity-raw");
  const hasLazyBody = (node) => {
    if (node.classList.contains("execution-history"))
      return Boolean(node.querySelector(":scope > .execution-timeline"));
    if (node.classList.contains("process-segment"))
      return Boolean(node.querySelector(":scope > .live-workflow"));
    if (node.classList.contains("tool-details") || node.classList.contains("subagent-step"))
      return Boolean(node.querySelector(":scope > .tool-details-body"));
    if (node.classList.contains("reasoning-details"))
      return Boolean(node.querySelector(":scope > .reasoning-copy"));
    if (node.classList.contains("activity-raw"))
      return Boolean(node.querySelector(":scope > .activity-raw-copy"));
    return true;
  };
  const hasOpenHistory = (cacheKey) => isHistoryOpenFor(cacheKey);
  const rerenderForToggle = (node) => {
    if (!isLazyDisclosure(node) || !lastRenderArgs) return;
    if (state.selected !== lastRenderArgs.task?.taskId) return;
    if (detailsOpen(node) === hasLazyBody(node)) return;
    renderConversation(lastRenderArgs.messages, lastRenderArgs.task, { preserveScroll: true });
  };
  const normalizeMessages = (messages) => {
    // Presentation repair applies only to assistant output. Original messages
    // remain durable and user-authored Markdown/code is never normalized.
    return (messages || []).map((message) =>
      message.role === "assistant"
        ? { ...message, content: assistantDisplayContent(message.content, { includeRaw: true }) }
        : message
    );
  };
  const projectExchanges = createConversationProjection(normalizeMessages);
  $("#conversation")?.addEventListener("click", async (event) => {
    const userCopy = event.target.closest?.("[data-user-copy]");
    if (userCopy) {
      const typed = userCopy.closest(".chat-message.user")?.querySelector(".user-text")?.textContent ?? "";
      if (await copyText(typed)) confirmCopied(userCopy);
      else showToast(ui("当前环境不支持复制"));
      return;
    }
    const button = event.target.closest?.("[data-reply-copy], [data-reply-fork]");
    const article = button?.closest(".chat-message.main");
    if (!article) return;
    const messageId = article.dataset.messageId;
    if (button.hasAttribute("data-reply-fork")) {
      if (button.disabled) return;
      button.disabled = true;
      try {
        await fork?.(state.selected, button.dataset.replyFork);
      } finally {
        if (button.isConnected) button.disabled = false;
      }
      return;
    }
    const message = messageId && state.detail?.messages?.find((entry) => entry.id === messageId);
    const source = message
      ? visibleText(message.content).trim()
      : article.querySelector(".markdown-body")?.innerText || "";
    if (await copyText(source)) confirmCopied(button);
    else showToast(ui("当前环境不支持复制"));
  });

  function renderFailure(task, failure) {
    const open = errorDetailsOpen.has(task.taskId);
    return ui`<div class="request-error" role="alert" data-recovery-task="${esc(task.taskId)}">
      <div class="run-error-head">${icon("circle-alert")}<strong>${esc(failure.title)}</strong>${failure.retryCount ? ui`<span class="run-error-retry">${ui("已自动重试 ")}${failure.retryCount}${ui("次")}</span>` : ""}</div>
      <div class="request-error-actions">
        <button data-retry-request type="button" title="${ui("从中断的步骤继续")}">${icon("rotate-ccw")}<span>重试</span></button>
        <button data-error-details type="button" aria-expanded="${open}">${icon("chevron-down")}<span>查看详情</span></button>
      </div>
      <div class="run-error-detail" data-error-detail ${open ? "" : "hidden"}>
        ${failure.errorType ? ui`<p data-error-type>错误类型：${esc(failure.errorType)}</p>` : ""}
        <p>${esc(failure.message)} ${allPreservedMessage(task)}${failure.suggestRetry === false ? "" : ui("可以手动重试继续。")}</p>
      </div>
    </div>`;
  }
  function allPreservedMessage(task) {
    return task.taskId && state.detail?.messages?.length ? ui("你发送的内容和已有过程已保留。") : "";
  }
  // Running Subagent rows count their own time between renders.
  let liveClockTimer;
  function syncLiveClocks(scroll) {
    const tick = () => {
      const clocks = scroll.querySelectorAll("[data-live-since]");
      if (!clocks.length) {
        clearInterval(liveClockTimer);
        liveClockTimer = undefined;
        return;
      }
      for (const clock of clocks)
        clock.textContent = liveClockText(clock.dataset.liveLabel, Number(clock.dataset.liveSince));
    };
    if (liveClockTimer === undefined && scroll.querySelector("[data-live-since]"))
      liveClockTimer = setInterval(tick, 1000);
  }

  function renderConversation(messages, task, { preserveScroll: keepScroll = false } = {}) {
    lastRenderArgs = { messages, task };
    const scroll = $("#conversation");
    // Capture live blocks as well as saved history, including before an empty
    // conversation replaces this task. Keys include the task and request.
    for (const history of scroll.querySelectorAll(".execution-history"))
      state.executionHistoryOpen.set(history.dataset.historyKey, detailsOpen(history));
    for (const node of scroll.querySelectorAll("details[data-activity-key]")) rememberActivity(node);
    const focused = scroll.ownerDocument.activeElement;
    const focusedDetail = focused?.tagName === "SUMMARY" ? focused.parentElement : undefined;
    let focusedActivityKey = focusedDetail?.dataset.activityKey;
    let focusedHistoryKey = focusedDetail?.dataset.historyKey;
    const focusedRecovery =
      focused?.closest?.("[data-recovery-task]")?.dataset.recoveryTask === task.taskId
        ? focused?.hasAttribute?.("data-retry-request")
          ? "[data-retry-request]"
          : undefined
        : undefined;
    const all = [
      ...(messages || []).filter(
        (message) =>
          !isMachineTurn(message) &&
          (message.role === "user" ||
            (message.role === "assistant" &&
              (message.stopReason !== "toolUse" || visibleText(message.content).trim())))
      ),
      ...state.localMessages
    ];
    const exchanges = projectExchanges(
      messages || [],
      state.localMessages,
      state.detail?.runtimeEvents || [],
      state.detail?.conversationVersion
    );
    // While a sent user message is still local, its exchange key is positional
    // ("position:N"). Once persistence confirms the message's real key, carry
    // over any disclosures and focus the reader already opened during the run.
    for (const [exchangeIndex, exchange] of exchanges.entries()) {
      const provisional = `${task.taskId}:position:${exchangeIndex}`;
      const actual = `${task.taskId}:${exchange.key}`;
      if (provisional === actual) continue;
      if (state.executionHistoryOpen.has(provisional)) {
        if (!state.executionHistoryOpen.has(actual))
          state.executionHistoryOpen.set(actual, state.executionHistoryOpen.get(provisional));
        state.executionHistoryOpen.delete(provisional);
      }
      const prefix = `${provisional}:`;
      for (const [key, value] of [...activityStates]) {
        if (!key.startsWith(prefix)) continue;
        const migrated = `${actual}:${key.slice(prefix.length)}`;
        if (!activityStates.has(migrated)) activityStates.set(migrated, value);
        activityStates.delete(key);
      }
      if (focusedHistoryKey === provisional) focusedHistoryKey = actual;
      if (focusedActivityKey?.startsWith(prefix))
        focusedActivityKey = `${actual}:${focusedActivityKey.slice(prefix.length)}`;
    }
    const currentExchangeIndex = exchanges.findLastIndex((exchange) => !exchange.awaitingDelivery);
    const windows = state.detail?.contextWindows ?? [];
    const windowDividers = contextWindowDividers(windows, exchanges);
    const failure = stoppedRequestFailure(
      task,
      state.detail,
      exchanges[currentExchangeIndex],
      state.submittingTaskId === task.taskId
    );
    const paused = task.status === "paused" ? task.pause || {} : undefined;
    if (!all.length && !failure && !paused && !messageEdit?.editingMessageId) {
      if (state.detail?.loading) {
        $("#conversation").replaceChildren();
        lastRender = undefined;
        historyMarkup.clear();
        return;
      }
      $("#conversation").innerHTML = ui(
        `<div class="welcome-empty"><div class="welcome-symbol"><svg class="welcome-mark" aria-hidden="true"><use href="#i-formicand-mark" /></svg></div><h2>有什么可以帮忙的？</h2></div>`
      );
      thinkingStartedAt.clear();
      lastRender = undefined;
      historyMarkup.clear();
      renderedEditTask = undefined;
      return;
    }
    const wasAtEnd = atConversationEnd(scroll);
    const editing = Boolean(messageEdit?.editingMessageId && state.selected === task.taskId);
    const preserveScroll =
      keepScroll ||
      (state.selected === task.taskId &&
        (editing || (renderedEditTask === task.taskId && !state.detail?.runtime?.active)));
    const previousScrollTop = scroll.scrollTop || 0;
    let inlineEditorRendered = false;
    const nextHistoryMarkup = new Map();
    // Only settled historical exchanges can be reused. Current/retry/edit state
    // remains live, and replaced history is checked by value, not array identity.
    const historyContext = JSON.stringify([
      task.taskId,
      state.detail?.conversationVersion,
      state.detail?.storageRoot,
      state.detail?.workspaceRoot,
      state.detail?.artifacts,
      state.detail?.humanRequests,
      state.detail?.editableMessage,
      state.detail?.coordination,
      state.detail?.progress,
      state.detail?.jobs,
      windows.map((window) => window.id),
      state.detail?.runtimeEvents?.filter(
        (record) =>
          (record.type === "runtime_event" ? record.payload : record)?.message?.customType ===
          "cowork-callback"
      )
    ]);
    const parts = exchanges.map((exchange, exchangeIndex) => {
      const isCurrent = exchangeIndex === currentExchangeIndex;
      const cacheKey = `${task.taskId}:${exchange.key}`;
      const historyOpen = hasOpenHistory(cacheKey);
      const cacheable =
        !isCurrent && !editing && !exchange.awaitingDelivery && !exchange.continued && !historyOpen;
      const elapsed = cacheable ? executionElapsedMs(exchange.events, state.detail?.events) : undefined;
      const cached = historyMarkup.get(cacheKey);
      // The append-only projector retains historical exchange identities.
      // Avoid serializing their unchanged events on every streamed delta.
      if (
        cacheable &&
        cached?.context === historyContext &&
        cached.exchange === exchange &&
        cached.open === historyOpen &&
        cached.elapsed === elapsed
      ) {
        nextHistoryMarkup.set(cacheKey, cached);
        return cached.markup;
      }
      const signature = cacheable ? JSON.stringify([exchange, elapsed, historyOpen]) : undefined;
      if (cacheable && cached?.context === historyContext && cached.signature === signature) {
        nextHistoryMarkup.set(cacheKey, { ...cached, exchange });
        return cached.markup;
      }
      const active =
        Boolean(state.detail?.runtime?.active || state.submittingTaskId === task.taskId) && isCurrent;
      const execution = exchangeExecutionState(exchange.events);
      const interrupted = ["cancelled", "failed", "paused", "waiting"].includes(execution.terminal);
      const waiting = execution.terminal === "waiting" && task.status === "waiting";
      const finalIndex =
        interrupted || exchange.continued ? -1 : finalAnswerIndex(exchange.messages, state.detail, isCurrent);
      const finalText = finalIndex >= 0 ? visibleText(exchange.messages[finalIndex].content).trim() : "";
      const historyKey = `${task.taskId}:${exchange.key}`;
      const { markup: workflow } = renderLiveActivity(
        exchange.events,
        active,
        finalIndex >= 0,
        finalText,
        historyOpen,
        historyKey,
        (interrupted && !waiting && !paused) || (isCurrent && Boolean(failure)),
        isCurrent,
        execution.stopped ?? (execution.terminal === "cancelled" && !(isCurrent && failure) ? {} : undefined)
      );
      const workflowIndex = !active && finalIndex >= 0 ? finalIndex : -1;
      const rendered =
        exchange.messages
          .map((message, index) => {
            const user = message.role === "user";
            const text = visibleText(message.content);
            if (!text.trim()) return "";
            if (user) {
              if (message.delivery === "followUp" && message.pending) return "";
              // An answer the person gave to Formicand's own question is not a new
              // request. It has to travel to the model as a user turn for the run to
              // continue, but showing it as one made the transcript read as if they
              // had asked for something twice. It is rendered where it belongs:
              // attached to the question it answers.
              const answered = answeredRequestFor(message, state.detail?.humanRequests);
              if (answered) {
                const key = `${task.taskId}:human-answer:${answered.requestId}`;
                return ui`<article class="chat-message human-answer" data-view-key="${esc(key)}"><div class="message-copy"><details class="human-answer-details" data-activity-key="${esc(key)}"><summary title="已回答，点击查看问题和回复">${icon("help")}<span>回答问题</span>${icon("check", "human-answer-check")}<span class="sr-only">已回答</span></summary><div class="human-answer-content"><div class="human-answer-question">${esc(answered.question)}</div><div class="human-answer-value markdown-body">${markdown(answered.answer)}</div></div></details></div></article>`;
              }
              const editor = messageEdit?.markup(task.taskId, message.id) || "";
              if (editor) inlineEditorRendered = true;
              const editable = message.id && message.id === state.detail?.editableMessage?.messageId;
              const typed = renderUserText(text, markdown);
              // An attachment-only message has no words, so no empty bubble under its cards.
              const bubble = editor
                ? `<div class="markdown-body">${typed.body}</div>${editor}${messageEdit.actions?.(task.taskId, message.id) || ""}`
                : typed.body && `<div class="markdown-body">${typed.body}</div>`;
              return `<article class="chat-message user${editor ? " is-editing" : ""}" data-view-key="${esc(`${historyKey}:user:${message.id || index}`)}"><div class="message-copy">${editor ? "" : typed.uploads}${bubble ? `<div class="user-message-bubble">${bubble}</div>` : ""}${editor ? "" : userActions(message, editable)}</div></article>`;
            }
            if (index !== finalIndex) return "";
            return `${index === workflowIndex ? workflow : ""}<article class="chat-message main" data-answer-kind="final"${message.id ? ` data-message-id="${esc(message.id)}"` : ""}><div class="message-copy"><div class="markdown-body">${markdown(text)}</div>${active ? "" : replyActions(message, isCurrent)}</div></article>`;
          })
          .map((markup, index) => markup + (windowDividers.get(exchange.messages[index]) ?? ""))
          .join("") +
        (workflowIndex < 0
          ? active || exchange.continued
            ? `<article class="chat-message main" data-view-key="${esc(`${historyKey}:response`)}" data-answer-kind="${active ? "pending" : "continuation"}"${active ? ' aria-busy="true"' : ""}><div class="message-copy">${workflow || (active ? renderThinkingPlaceholder(historyKey) : "")}</div></article>`
            : workflow
          : "");
      if (cacheable)
        nextHistoryMarkup.set(cacheKey, {
          context: historyContext,
          signature,
          markup: rendered,
          exchange,
          open: historyOpen,
          elapsed
        });
      return rendered;
    });
    historyMarkup = nextHistoryMarkup;
    if (windowDividers.has(undefined)) parts.unshift(windowDividers.get(undefined));
    // A restored edit can outlive its message after another window branches
    // the conversation. Keep its draft reachable for cancellation or recovery.
    const restoredEditor = inlineEditorRendered
      ? ""
      : messageEdit?.markup(task.taskId, messageEdit.editingMessageId) || "";
    parts.push(
      (restoredEditor
        ? `<article class="chat-message user is-editing" data-view-key="${esc(`${task.taskId}:restored-edit`)}"><div class="message-copy"><div class="user-message-bubble">${restoredEditor}${messageEdit.actions?.(task.taskId, messageEdit.editingMessageId) || ""}</div></div></article>`
        : "") + (failure ? renderFailure(task, failure) : "")
    );
    // A streamed delta changes the last exchange only. Patch from the first
    // part that differs; everything before it stays as it is in the page.
    // Anything else that touched the list (another task, an empty state)
    // shows as a node count that no longer adds up, and gets a full patch.
    const previous =
      lastRender?.taskId === task.taskId &&
      scroll.childNodes.length === lastRender.counts.reduce((sum, count) => sum + count, 0)
        ? lastRender
        : undefined;
    let first = 0;
    if (previous)
      while (first < parts.length && first < previous.parts.length && parts[first] === previous.parts[first])
        first += 1;
    if (!previous || first < parts.length || parts.length !== previous.parts.length) {
      const kept = previous ? previous.counts.slice(0, first) : [];
      const offset = kept.reduce((sum, count) => sum + count, 0);
      const counts = reconcileParts(scroll, parts.slice(kept.length), scroll.childNodes[offset] ?? null);
      lastRender = { taskId: task.taskId, parts, counts: [...kept, ...counts] };
      animateArrivals(scroll, task.taskId);
      streamReveal.apply(scroll);
      syncLiveClocks(scroll);
      const ownsRecovery = () => state.selected === task.taskId && state.detail?.task?.taskId === task.taskId;
      for (const [selector, action] of [
        ["[data-edit-message]", () => edit?.(task.taskId, state.detail?.editableMessage)],
        ["[data-retry-request]", () => retry?.(task.taskId)]
      ]) {
        const node = scroll.querySelector(selector);
        if (!node || boundNodes.has(node)) continue;
        boundNodes.add(node);
        node.addEventListener("click", () => {
          if (ownsRecovery()) action();
        });
      }
      const detailsButton = scroll.querySelector("[data-error-details]");
      if (detailsButton && !boundNodes.has(detailsButton)) {
        boundNodes.add(detailsButton);
        detailsButton.addEventListener("click", () => {
          const panel = scroll.querySelector("[data-error-detail]");
          if (!panel) return;
          const expanded = detailsButton.getAttribute("aria-expanded") !== "true";
          detailsButton.setAttribute("aria-expanded", String(expanded));
          panel.hidden = !expanded;
          if (expanded) errorDetailsOpen.add(task.taskId);
          else errorDetailsOpen.delete(task.taskId);
        });
      }
      scroll.querySelectorAll("[data-message-artifact]").forEach((link) => {
        if (boundNodes.has(link)) return;
        boundNodes.add(link);
        link.addEventListener("click", (event) => {
          if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          const path = link.dataset.messageArtifact;
          const taskId = link.dataset.messageTask;
          if (
            state.selected === taskId &&
            state.detail?.task?.taskId === taskId &&
            state.detail.artifacts?.some(
              (artifact) => artifact.taskId === taskId && artifact.relativePath === path
            )
          )
            openArtifact?.(path);
        });
      });
      scroll.querySelectorAll("details[data-activity-key]").forEach((node) => {
        const saved = activityStates.get(node.dataset.activityKey);
        if (saved) {
          node.open = saved.open;
          restoreReadingPosition(node);
        }
        const remember = () => {
          if (node.isConnected) rememberActivity(node);
        };
        if (!boundNodes.has(node)) {
          boundNodes.add(node);
          node.addEventListener("toggle", () => {
            remember();
            if (node.isConnected) {
              rerenderForToggle(node);
              restoreReadingPosition(node);
            }
          });
        }
        readingCopies(node).forEach((copy) => {
          if (boundNodes.has(copy)) return;
          boundNodes.add(copy);
          copy.addEventListener("scroll", remember, { passive: true });
        });
        if (node.dataset.activityKey === focusedActivityKey) {
          const history = node.closest(".execution-history");
          (history && !history.open ? history : node)
            .querySelector("summary")
            ?.focus?.({ preventScroll: true });
        }
      });
      scroll.querySelectorAll(".execution-history").forEach((history) => {
        const savedOpen = isHistoryOpenFor(history.dataset.historyKey);
        history.open = savedOpen;
        if (!boundNodes.has(history)) {
          boundNodes.add(history);
          history.addEventListener("toggle", () => {
            if (history.isConnected) {
              state.executionHistoryOpen.set(history.dataset.historyKey, detailsOpen(history));
              rerenderForToggle(history);
              if (detailsOpen(history))
                history.querySelectorAll("details[data-activity-key]").forEach(restoreReadingPosition);
            }
          });
        }
        if (history.dataset.historyKey === focusedHistoryKey)
          history.querySelector("summary")?.focus?.({ preventScroll: true });
      });
      if (focusedRecovery) scroll.querySelector(focusedRecovery)?.focus?.({ preventScroll: true });
      const latestLocal = state.localMessages.at(-1);
      const sent = Boolean(latestLocal) && latestLocal !== followedLocal;
      followedLocal = latestLocal;
      if (!preserveScroll && (wasAtEnd || sent)) scroll.scrollTop = scroll.scrollHeight;
    }
    messageEdit?.bind(scroll, task.taskId);
    if (preserveScroll) scroll.scrollTop = previousScrollTop;
    renderedEditTask = editing ? task.taskId : undefined;
    resumeThinkingAnimations(scroll);
  }

  /**
   * One round's working steps. While the round runs they are listed as they
   * happen; once it has a settled answer they fold into one "处理过程" row.
   * What Main is doing overall is the composer's status line, so the steps
   * carry no heading of their own. `settled` is the round's duration once it
   * has folded, for the line under the answer.
   */
  return { renderConversation };
}
