import { ui } from "../ui/language.js";
import { outstandingWork } from "../tool-lifecycle.js";
import { presentToolCall } from "../tool-presentation.js";
import { buildLiveActivity, reasoningPreview, normalizeReasoningDisplay } from "../activity.js";
import { exchangeExecutionState } from "../conversation.js";
import { escapeHtml as esc } from "../ui/html.js";
import { icon } from "../ui/icons.js";
import { executionElapsedMs, formatExecutionDuration } from "../execution-time.js";
import { antMarkSvg } from "../ui/thinking-mark.js";
import { completeMarkdown } from "../ui/stream-reveal.js";

const toolKinds = new Map([
  ...["read", "read_file"].map((name) => [name, "read"]),
  ...["write", "write_file", "edit", "apply_patch"].map((name) => [name, "edit"]),
  ...["bash", "exec_command", "run_tests"].map((name) => [name, "command"])
]);

export function liveClockText(label, since) {
  return [label, formatExecutionDuration(Math.max(0, Date.now() - since))].filter(Boolean).join(" ");
}

export function createConversationActivityView({ markdown, activityContext }) {
  function renderLiveActivity(
    events,
    active,
    hasFinalAnswer = false,
    finalText = "",
    historyOpen = false,
    historyKey = "",
    failed = false,
    isCurrent = true,
    stopped = undefined
  ) {
    const { taskId, detail } = activityContext();
    const turns = buildLiveActivity(events);
    const retry = active && exchangeExecutionState(events).retry;
    const retryCode = retry && /\b(429|5\d\d)\b/.exec(retry.errorMessage || "")?.[1];
    const retryBanner = retry
      ? ui`<div class="request-retry" role="status" aria-live="polite"><strong>模型连接异常${retryCode ? `（HTTP ${retryCode}）` : ""}，正在重试</strong><p>第 ${esc(retry.attempt)} / ${esc(retry.maxAttempts)} 次自动重试，已有内容已保留。可以等待恢复或停止本轮。</p></div>`
      : "";
    const placeholder = () => ({
      markup:
        (active
          ? renderThinkingPlaceholder(historyKey, retry ? ui("正在恢复模型连接…") : undefined, !retry)
          : "") + retryBanner
    });
    if (!turns.length) return placeholder();
    const calls = turns.flatMap((turn) => turn.calls);
    const presentations = new Map(
      calls.map((call) => [
        call,
        presentToolCall(call, {
          active,
          workspaceRoot: detail?.storageRoot || detail?.workspaceRoot,
          taskId,
          detail
        })
      ])
    );
    const pendingWork = isCurrent ? outstandingWork(detail) : { agents: 0, callbacks: 0, jobs: 0, human: 0 };
    const working = active || Object.values(pendingWork).some((count) => count > 0);
    const delegations = calls.filter((call) => call.name === "call_subagent").length;
    const operations = calls.length - delegations;
    const failedCalls = calls.filter((call) => presentations.get(call)?.status === "failed").length;
    const streamedAnswer = turns.at(-1)?.answer?.trim() || "";
    // Do not collapse the streamed answer until the persisted transcript has
    // caught up. A completion event can arrive just before messages.json is
    // atomically replaced, and hiding it at that point makes the final answer
    // appear to vanish.
    const persistedAnswerMatches = Boolean(
      hasFinalAnswer && streamedAnswer && finalText && streamedAnswer === finalText
    );
    const items = turns.flatMap((turn, turnIndex) =>
      (turn.items?.length
        ? turn.items
        : [
            ...(turn.reasoning
              ? [{ type: "reasoning", text: turn.reasoning, done: turn.done, key: `${turnIndex}:reasoning` }]
              : []),
            ...turn.calls.map((call, callIndex) => ({
              type: "tool",
              call,
              key: `${turnIndex}:call:${callIndex}`
            }))
          ]
      ).map((item, itemIndex) => ({
        ...item,
        done: item.done ?? turn.done,
        key: `${historyKey}:${item.key || `${turnIndex}:${item.type}:${itemIndex}`}`
      }))
    );
    const finalMessageKey = turns.at(-1)?.answerMessageKey;
    const visibleItems = items.filter(
      (item) =>
        !(!active && persistedAnswerMatches && item.type === "answer" && item.messageKey === finalMessageKey)
    );
    // Adjacent text blocks form one response. Rendering each fragment on its
    // own inserts paragraph breaks and can split Markdown while persistence
    // is still catching up with the final stream.
    const activity = [];
    for (const item of visibleItems) {
      const previous = activity.at(-1);
      if (item.type === "answer" && previous?.type === "answer" && previous.messageKey === item.messageKey)
        previous.text += item.text;
      else activity.push({ ...item });
    }
    if (!activity.length) return placeholder();
    // Consecutive completed reads, edits and commands fold into one row, and
    // consecutive delegations into one "派出 N 个子助手" row.
    const compactActivity = [];
    let batch = [];
    const flush = () => {
      if (batch[0]?.call.name === "call_subagent")
        compactActivity.push({ type: "subagents", items: batch, key: `${batch[0].key}:agents` });
      else if (batch.length > 1)
        compactActivity.push({ type: "tools", items: batch, key: `${batch[0].key}:group` });
      else compactActivity.push(...batch);
      batch = [];
    };
    const batchKind = (item) =>
      item.type !== "tool"
        ? undefined
        : item.call.name === "call_subagent"
          ? "agents"
          : toolKinds.has(item.call.name) && presentations.get(item.call)?.status === "completed"
            ? "tools"
            : undefined;
    for (const item of activity) {
      const kind = batchKind(item);
      if (batch.length && kind !== batchKind(batch[0])) flush();
      if (kind) batch.push(item);
      else compactActivity.push(item);
    }
    flush();
    if (failed && !activity.some((item) => item.type === "tool" || item.text?.trim())) return { markup: "" };
    const collapsible = !working && hasFinalAnswer && persistedAnswerMatches;
    // Main is working but nothing at the end is moving: the model is on its
    // way to the next step, so that step's row waits there.
    const tail = compactActivity.at(-1);
    const tailLive =
      (["reasoning", "answer"].includes(tail?.type) && !tail.done) ||
      (tail?.type === "tool" && presentations.get(tail.call)?.status === "running");
    const nextStep =
      active && !tailLive ? thinkingRow(historyKey, retry ? ui("正在恢复模型连接…") : undefined, !retry) : "";
    const stoppedRow =
      stopped && !working
        ? `<div class="activity-step turn-stopped" data-view-key="${esc(`${historyKey}:stopped`)}"><div class="activity-step-content"><div class="activity-step-head"><span class="tool-status-dot" aria-hidden="true"></span><strong>${ui("已停止")}</strong><span class="turn-stopped-note">${esc(stopped.subagents ? ui`Main 和 ${stopped.subagents} 个子助手都已停下，做完的结果保留` : ui("做完的步骤和结果已保留"))}</span></div></div></div>`
        : "";
    const content = `<section class="live-workflow ${working ? "is-active" : "is-complete"}"${active ? ' aria-live="polite"' : ""}>
    <div class="workflow-rail">${compactActivity.map((item) => (item.type === "subagents" ? renderSubagentGroup(item, presentations, detail) : item.type === "tools" ? renderToolGroup(item, active, presentations, taskId, detail) : item.type === "reasoning" ? renderReasoningStep(item.text, { done: !active || item.done, interrupted: (!active || item.done) && !item.complete }, item.key, item.rawText) : item.type === "answer" ? (active && item === compactActivity.at(-1) && !item.done ? `<div class="live-answer" data-activity-key="${esc(item.key)}" data-streaming-answer><div class="markdown-body">${markdown(completeMarkdown(item.text))}</div></div>` : `<div class="live-answer" data-activity-key="${esc(item.key)}"><div class="markdown-body">${markdown(item.text)}</div></div>`) : renderToolStep(item.call, active, item.key, taskId, detail, presentations.get(item.call)))).join("")}${nextStep}${stoppedRow}</div>
  </section>`;
    if (!collapsible) return { markup: content + retryBanner };
    const counts = [
      operations ? ui`${operations} 项操作` : "",
      delegations ? ui`${delegations} 个子助手` : ""
    ].filter(Boolean);
    const label = [ui("处理过程"), ...counts].join(" · ");
    return {
      markup: `<details class="execution-history" data-task="${esc(taskId)}" data-history-key="${esc(historyKey)}"${historyOpen ? " open" : ""}><summary aria-label="${esc(label)}"><strong>${ui("处理过程")}</strong>${counts.length ? `<small>${esc(counts.join(" · "))}</small>` : ""}${failedCalls ? ui`<em class="history-failures">${failedCalls} 次调用未成功</em>` : ""}<span class="history-chevron" aria-hidden="true">${icon("chevron-down")}</span></summary>${content}</details>`,
      settled: formatExecutionDuration(executionElapsedMs(events, detail?.events)) || undefined
    };
  }

  /** The Subagents one step sent out: a header row, then one indented row each. */
  function renderSubagentGroup(group, presentations, detail) {
    const rows = group.items.map((item) => {
      const presentation = presentations.get(item.call);
      const agent = presentation.agent;
      const elapsed = formatExecutionDuration(agent.elapsedMs);
      const status = presentation.status;
      const finished = status === "completed" || presentation.statusLabel === "结果待接收";
      // A paused conversation's Subagents are held at their step boundary.
      const held = !finished && ["running", "waiting"].includes(status) && detail?.task?.status === "paused";
      const right = finished
        ? [ui("完成"), elapsed].filter(Boolean).join(" ")
        : status === "failed"
          ? presentation.statusLabel
          : held
            ? ui("已暂停")
            : status === "interrupted"
              ? ui("已停止")
              : status === "recorded"
                ? ui("已派发")
                : status === "waiting"
                  ? ui("等待中")
                  : [presentation.statusLabel === "协作排队中" ? ui("排队中") : ui("运行中"), elapsed]
                      .filter(Boolean)
                      .join(" ");
      const running = !finished && !held && status === "running";
      // A running one counts up in the page from when it was handed out,
      // rather than showing the time of the last snapshot.
      const since = running && presentation.statusLabel !== "协作排队中" ? Date.parse(agent.startedAt) : NaN;
      const liveClock = Number.isFinite(since)
        ? ` data-live-since="${since}" data-live-label="${esc(ui("运行中"))}"`
        : "";
      const statusText = liveClock ? liveClockText(ui("运行中"), since) : right;
      const mark = running
        ? `<span class="tool-progress-spinner ant-mark" data-thinking-key="${esc(`${item.key}:agent`)}" aria-hidden="true">${antMarkSvg}</span>`
        : '<span class="tool-status-dot" aria-hidden="true"></span>';
      const text = finished && agent.outcome ? agent.outcome : agent.task;
      const sections = presentation.detailSections || [];
      return `<details class="tool-details subagent-step is-${finished ? "done" : status === "failed" ? "failed" : running ? "running" : "waiting"}" data-activity-key="${esc(item.key)}" data-view-key="${esc(item.key)}"><summary class="activity-step-head">${mark}<span class="tool-action"><strong>${esc(agent.name)}</strong><span class="subagent-role-tag">${esc(agent.role)}</span>${text ? `<span class="tool-subject" title="${esc(text)}">${esc(text)}</span>` : ""}</span><span class="subagent-status"${liveClock}>${esc(statusText)}</span><span class="tool-chevron" aria-hidden="true">${icon("chevron-right")}</span></summary><div class="tool-details-body">${sections.map((section) => `<section><span class="activity-data-label">${esc(section.label)}</span><pre class="tool-copy" data-reading-key="${esc(section.label)}">${esc(section.text)}</pre></section>`).join("")}</div></details>`;
    });
    return `<div class="activity-step subagent-group" data-view-key="${esc(group.key)}"><div class="activity-step-content"><div class="activity-step-head"><span class="tool-status-dot" aria-hidden="true"></span><strong>${esc(ui`派出 ${group.items.length} 个子助手`)}</strong></div><div class="subagent-nest">${rows.join("")}</div></div></div>`;
  }

  function renderReasoningStep(reasoning, turn, key, rawReasoning = reasoning) {
    const original = String(rawReasoning || "");
    const normalized = normalizeReasoningDisplay(reasoning, { streaming: !turn.done });
    const preview = reasoningPreview(normalized);
    const label = turn.interrupted ? ui("思考已停止") : turn.done ? ui("思考完成") : ui("思考中");
    const stateClass = turn.done ? "reasoning-state" : "reasoning-state shimmer-text";
    const spinner = turn.done
      ? ""
      : `<span class="thinking-spinner ant-mark" data-thinking-key="${esc(key)}" aria-hidden="true">${antMarkSvg}</span>`;
    return `<div class="activity-step reasoning-step" data-view-key="${esc(key)}">
    <div class="activity-step-content">
      ${preview ? `<details class="reasoning-details" data-activity-key="${esc(key)}"><summary>${spinner}<span class="${stateClass}">${label}</span><span class="reasoning-preview">${esc(preview)}</span><span class="reasoning-chevron" aria-hidden="true">${icon("chevron-right")}</span></summary><div class="reasoning-copy markdown-body">${markdown(normalized)}</div>${original !== normalized || /\*\*|```/.test(original) ? ui`<details class="activity-raw" data-activity-key="${esc(`${key}:source`)}"><summary>原始内容</summary><pre class="activity-raw-copy">${esc(original)}</pre></details>` : ""}</details>` : `<div class="activity-step-head">${spinner}<strong class="${stateClass}">${label}</strong></div>`}
    </div>
  </div>`;
  }

  // Before the first token, the turn shows the row its first thought will
  // take: same place, mark and words, so nothing jumps when the thought arrives.
  // Between steps the same row waits at the end of the steps.
  function thinkingRow(key, label = ui("思考中"), announce = true) {
    return `<div class="activity-step reasoning-step"><div class="activity-step-content"><div class="activity-step-head assistant-thinking"${announce ? ' role="status"' : ""}><span class="thinking-spinner ant-mark" data-thinking-key="${esc(`${key}:pending`)}" aria-hidden="true">${antMarkSvg}</span><strong class="reasoning-state shimmer-text">${esc(label)}</strong></div></div></div>`;
  }
  function renderThinkingPlaceholder(key, label, announce) {
    return `<section class="live-workflow is-active"><div class="workflow-rail">${thinkingRow(key, label, announce)}</div></section>`;
  }

  function renderToolGroup(group, active, presentations, taskId, detail) {
    const counts = new Map();
    for (const item of group.items) {
      const kind = toolKinds.get(item.call.name);
      counts.set(kind, (counts.get(kind) || 0) + 1);
    }
    const labels = {
      read: (n) => ui`读取了 ${n} 个文件`,
      edit: (n) => ui`编辑了 ${n} 个文件`,
      command: (n) => ui`运行了 ${n} 条命令`
    };
    const summary = [...counts].map(([kind, count]) => labels[kind](count)).join(" · ");
    return `<div class="activity-step tool-group" data-view-key="${esc(group.key)}"><div class="activity-step-content"><details class="tool-group-details" data-activity-key="${esc(group.key)}"><summary><span class="tool-group-label">${esc(summary)}</span><span class="tool-chevron" aria-hidden="true">${icon("chevron-right")}</span></summary><div class="tool-group-body">${group.items.map((item) => renderToolStep(item.call, active, item.key, taskId, detail, presentations.get(item.call))).join("")}</div></details></div></div>`;
  }

  function renderToolStep(
    call,
    active,
    key,
    taskId,
    detail,
    presentation = presentToolCall(call, {
      active,
      workspaceRoot: detail?.storageRoot || detail?.workspaceRoot,
      taskId,
      detail
    })
  ) {
    const status = presentation.statusLabel === ui("调用完成") ? ui("完成") : presentation.statusLabel;
    const statusClass =
      {
        failed: "failed",
        completed: "done",
        interrupted: "stopped",
        waiting: "waiting",
        running: "running",
        recorded: "waiting"
      }[presentation.status] || "running";
    const name = presentation.title;
    const subject = presentation.subject || "";
    const resultContext = /^(?:命令执行完成|已完成|调用成功)[。.!]?$/.test(presentation.resultSummary || "")
      ? ""
      : presentation.resultSummary;
    const failed = presentation.status === "failed";
    const context = failed
      ? presentation.failureReason || presentation.resultSummary
      : [
          ...new Set([presentation.summary, resultContext].filter((value) => value && value !== subject))
        ].join(" · ");
    const sections = presentation.detailSections || [];
    const indicator =
      statusClass === "running"
        ? `<span class="tool-progress-spinner ant-mark" data-thinking-key="${esc(`${key}:tool`)}" aria-hidden="true">${antMarkSvg}</span>`
        : '<span class="tool-status-dot" aria-hidden="true"></span>';
    return `<div class="activity-step tool-step is-${statusClass}" data-view-key="${esc(key)}">
    <div class="activity-step-content">
      <details class="tool-details" data-activity-key="${esc(key)}"><summary class="activity-step-head"><span class="tool-action"><strong>${esc(name)}</strong>${subject ? `<span class="tool-subject" title="${esc(subject)}">${esc(subject)}</span>` : ""}</span><span class="activity-status ${statusClass}">${indicator}${esc(status)}</span>${presentation.durationLabel ? `<span class="tool-duration">${esc(presentation.durationLabel)}</span>` : ""}<span class="tool-chevron" aria-hidden="true">${icon("chevron-right")}</span></summary><div class="tool-details-body">${sections.map((section) => `<section><span class="activity-data-label">${esc(section.label)}</span><pre class="tool-copy" data-reading-key="${esc(section.label)}">${esc(section.text)}</pre></section>`).join("")}</div></details>${context ? `<p class="tool-context${failed ? " is-failure" : ""}">${esc(context)}</p>` : ""}
    </div>
  </div>`;
  }

  return { renderLiveActivity, renderThinkingPlaceholder };
}
