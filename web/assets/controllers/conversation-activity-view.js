import { ui } from "../ui/language.js";
import { outstandingWork } from "../tool-lifecycle.js";
import { presentToolCall } from "../tool-presentation.js";
import {
  projectLiveActivity,
  hasReasoningMore,
  reasoningPreview,
  normalizeReasoningDisplay
} from "../activity.js";
import { exchangeExecutionState } from "../conversation.js";
import { escapeHtml as esc } from "../ui/html.js";
import { icon } from "../ui/icons.js";
import { executionElapsedMs, formatExecutionDuration } from "../execution-time.js";
import { antMarkSvg } from "../ui/thinking-mark.js";
import { completeMarkdown, hasOpenFence } from "../ui/stream-reveal.js";

const readTools = new Set(["read", "read_file", "read_attachment"]);
const searchTools = new Set(["search", "grep", "find", "web_search", "fetch_url"]);
const editTools = new Set(["write", "write_file", "edit", "apply_patch"]);
const commandTools = new Set(["bash", "exec_command", "run_tests"]);
const windowTools = new Set(["computer_status", "computer_observe", "computer_act"]);
const collabTools = new Set([
  "wait_for_subagents",
  "get_subagent_status",
  "send_subagent_message",
  "cancel_subagent",
  "sleep_until"
]);

const categoryMeta = {
  read: {
    icon: "book-open",
    live: () => ui("读取文件中"),
    done: (n) => ui`读取了 ${n} 个文件`
  },
  search: {
    icon: "search",
    live: () => ui("搜索信息中"),
    done: (n) => ui`执行了 ${n} 次搜索`
  },
  edit: {
    icon: "pencil",
    live: () => ui("编辑文件中"),
    done: (n) => ui`编辑了 ${n} 个文件`
  },
  command: {
    icon: "terminal",
    live: () => ui("运行命令中"),
    done: (n) => ui`运行了 ${n} 条命令`
  },
  window: {
    icon: "laptop",
    live: () => ui("操作窗口中"),
    done: (n) => ui`操作了 ${n} 次窗口`
  },
  collab: {
    icon: "team",
    live: () => ui("等待协作结果中"),
    done: (n) => ui`协调了 ${n} 次任务`
  },
  question: {
    icon: "help",
    live: () => ui("等待你的回复"),
    done: (n) => ui`发起了 ${n} 次提问`
  },
  other: {
    icon: "wrench",
    live: () => ui("执行操作中"),
    done: (n) => ui`执行了 ${n} 项操作`
  }
};

function toolCategory(call) {
  const name = call?.name || "";
  if (name === "browse_workspace") return call?.arguments?.mode === "search" ? "search" : "read";
  if (readTools.has(name)) return "read";
  if (searchTools.has(name)) return "search";
  if (editTools.has(name)) return "edit";
  if (commandTools.has(name)) return "command";
  if (windowTools.has(name)) return "window";
  if (collabTools.has(name)) return "collab";
  if (name === "askhuman") return "question";
  return "other";
}

export function liveClockText(label, since) {
  return [label, formatExecutionDuration(Math.max(0, Date.now() - since))].filter(Boolean).join(" ");
}

function subagentRunState(presentation, detail) {
  const status = presentation.status;
  const finished = status === "completed" || presentation.statusLabel === "结果待接收";
  // A paused conversation's Subagents are held at their step boundary.
  const held = !finished && ["running", "waiting"].includes(status) && detail?.task?.status === "paused";
  const running = !finished && !held && status === "running";
  return { status, finished, held, running };
}

export function createConversationActivityView({
  markdown,
  activityContext,
  isHistoryOpen,
  isActivityOpen = () => false,
  toolDetailFor
}) {
  function resolveExpandedCall(call, taskId) {
    if (!call?.detailOmitted || !call.id || !toolDetailFor) return { call, state: "inline" };
    const loaded = toolDetailFor(taskId, call);
    if (!loaded) return { call, state: "inline" };
    if (loaded.status === "ready") {
      return {
        call: {
          ...call,
          ...(loaded.arguments !== undefined ? { arguments: loaded.arguments } : {}),
          ...(loaded.result !== undefined ? { rawResult: loaded.result, result: loaded.result } : {})
        },
        state: "ready"
      };
    }
    return { call, state: loaded.status, detailKey: loaded.detailKey };
  }

  function renderToolDetailsBody(sections, detailState, detailKey) {
    if (detailState === "loading") {
      return `<div class="tool-details-body"><div class="tool-detail-state" role="status">${esc(ui("正在加载详情…"))}</div></div>`;
    }
    const errorNotice =
      detailState === "error"
        ? `<div class="tool-detail-state is-error"><span>${esc(ui("无法加载完整记录"))}</span>${
            detailKey
              ? `<button type="button" class="tool-detail-retry" data-tool-detail-retry="${esc(detailKey)}">${esc(ui("重试"))}</button>`
              : ""
          }</div>`
        : "";
    return `<div class="tool-details-body">${errorNotice}${sections
      .map(
        (section) =>
          `<section><span class="activity-data-label">${esc(section.label)}</span><pre class="tool-copy" data-reading-key="${esc(section.label)}">${esc(section.text)}</pre></section>`
      )
      .join("")}</div>`;
  }
  const renderStreamingAnswerBody = (text) =>
    markdown(completeMarkdown(text), { streaming: true, openTailFence: hasOpenFence(text) });

  function renderLiveActivity(
    events,
    active,
    hasFinalAnswer = false,
    finalText = "",
    historyOpen = false,
    historyKey = "",
    failed = false,
    isCurrent = true,
    stopped = undefined,
    { rawL1 = false } = {}
  ) {
    const { taskId, detail } = activityContext();
    const { turns, streaming: streamingState } = projectLiveActivity(events);
    const retry = active && exchangeExecutionState(events).retry;
    const retryCode = retry && /\b(429|5\d\d)\b/.exec(retry.errorMessage || "")?.[1];
    const retryBanner = retry
      ? ui`<div class="request-retry" role="status" aria-live="polite"><strong>模型连接异常${retryCode ? `（HTTP ${retryCode}）` : ""}，正在重试</strong><p>第 ${esc(retry.attempt)} / ${esc(retry.maxAttempts)} 次自动重试，已有内容已保留。可以等待恢复或停止本轮。</p></div>`
      : "";
    const pendingWork = isCurrent ? outstandingWork(detail) : { agents: 0, callbacks: 0, jobs: 0, human: 0 };
    const working = active || Object.values(pendingWork).some((count) => count > 0);
    // A stop before the model wrote anything still ends this request, so the
    // row shows with or without activity above it.
    const stoppedRow =
      stopped && !working
        ? `<div class="activity-step turn-stopped" data-view-key="${esc(`${historyKey}:stopped`)}"><div class="activity-step-content"><div class="activity-step-head"><span class="tool-status-dot" aria-hidden="true"></span><strong>${ui("已停止")}</strong><span class="turn-stopped-note">${esc(stopped.subagents ? ui`Main 和 ${stopped.subagents} 个子助手都已停下，做完的结果保留` : ui("做完的步骤和结果已保留"))}</span></div></div></div>`
        : "";
    const placeholder = () => ({
      markup:
        (active
          ? renderThinkingPlaceholder(historyKey, retry ? ui("正在恢复模型连接…") : undefined, !retry)
          : stoppedRow) + retryBanner,
      hasActivity: false,
      collapsible: false,
      streamedAnswer: "",
      persistedAnswerMatches: false
    });
    if (!turns.length) return placeholder();
    const calls = turns.flatMap((turn) => turn.calls);
    const presentationOptions = {
      active,
      workspaceRoot: detail?.storageRoot || detail?.workspaceRoot,
      taskId,
      detail,
      includeDetails: false
    };
    const presentations = new Map(calls.map((call) => [call, presentToolCall(call, presentationOptions)]));
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
    if (!activity.length)
      return {
        ...placeholder(),
        streamedAnswer,
        persistedAnswerMatches,
        collapsible: !working && hasFinalAnswer && (!streamedAnswer || persistedAnswerMatches)
      };
    if (failed && !activity.some((item) => item.type === "tool" || item.text?.trim()))
      return {
        markup: "",
        hasActivity: false,
        collapsible: false,
        streamedAnswer,
        persistedAnswerMatches
      };
    const collapsible = !working && hasFinalAnswer && (!streamedAnswer || persistedAnswerMatches);
    // Main is working but nothing at the end is moving: the model is on its
    // way to the next step, so that step's row waits there.
    const tail = activity.at(-1);
    const tailLive =
      (["reasoning", "answer"].includes(tail?.type) && !tail.done) ||
      (tail?.type === "tool" && presentations.get(tail.call)?.status === "running");

    // Partition L1 into chronological segments:
    // - answer: mid-round Agent speech on its own line
    // - subagents: independent L1 subagent status rows (Scheme A)
    // - process: consecutive reasoning & ordinary tool calls, folded to one
    //   stable coarse-action row (L1) that expands lazily onto step rows (L2).
    const segments = [];
    for (const item of activity) {
      if (item.type === "answer") {
        segments.push({ kind: "answer", item });
        continue;
      }
      if (item.type === "tool" && item.call.name === "call_subagent") {
        const previous = segments.at(-1);
        if (previous?.kind === "subagents") previous.items.push(item);
        else segments.push({ kind: "subagents", key: `${item.key}:agents`, items: [item] });
        continue;
      }
      const previous = segments.at(-1);
      if (previous?.kind === "process") previous.items.push(item);
      else segments.push({ kind: "process", items: [item] });
    }

    let renderedStreamingKey;
    const renderAnswerSegment = (item) => {
      const streaming = Boolean(active && item === activity.at(-1) && !item.done);
      if (streaming) {
        renderedStreamingKey = item.key;
        return `<div class="live-answer" data-activity-key="${esc(item.key)}" data-streaming-answer><div class="markdown-body">${renderStreamingAnswerBody(item.text)}</div></div>`;
      }
      return `<div class="live-answer" data-activity-key="${esc(item.key)}"><div class="markdown-body">${markdown(item.text)}</div></div>`;
    };

    const renderProcessItems = (segmentItems, showWaitingRow) => {
      const rows = segmentItems
        .map((item) =>
          item.type === "reasoning"
            ? renderReasoningStep(
                item.text,
                { done: !active || item.done, interrupted: (!active || item.done) && !item.complete },
                item.key
              )
            : renderToolStep(item.call, active, item.key, taskId, detail, presentations.get(item.call))
        )
        .join("");
      const waitingRow = showWaitingRow
        ? thinkingRow(historyKey, retry ? ui("正在恢复模型连接…") : undefined, !retry)
        : "";
      return `${rows}${waitingRow}`;
    };

    const renderL1 = () => {
      let processIndex = 0;
      const segmentMarkup = segments
        .map((segment, segmentIndex) => {
          if (segment.kind === "answer") return renderAnswerSegment(segment.item);
          if (segment.kind === "subagents")
            return renderSubagentGroup(segment, presentations, detail, taskId, active);
          const currentProcessIndex = processIndex++;
          const isLastSegment = segmentIndex === segments.length - 1;
          const segmentKey = `${historyKey}:proc:${currentProcessIndex}`;
          const segmentItems = segment.items;
          const segmentCallItems = segmentItems.filter((item) => item.type === "tool");
          const segmentCalls = segmentCallItems.map((item) => item.call);
          const segmentFailed = segmentCalls.filter(
            (call) => presentations.get(call)?.status === "failed"
          ).length;
          const runningToolItem = segmentCallItems.findLast(
            (item) => presentations.get(item.call)?.status === "running"
          );
          const lastItem = segmentItems.at(-1);
          const activeReasoning =
            isLastSegment && active && lastItem?.type === "reasoning" && !lastItem.done ? lastItem : null;
          const waitingNext = Boolean(isLastSegment && active && !tailLive);
          const segmentLive = Boolean(
            (isLastSegment && retry) || runningToolItem || activeReasoning || waitingNext
          );
          const emptyReasoningOnly =
            segmentItems.length === 1 &&
            segmentItems[0].type === "reasoning" &&
            !segmentCalls.length &&
            !reasoningPreview(
              normalizeReasoningDisplay(segmentItems[0].text, { streaming: !segmentItems[0].done })
            );
          if (emptyReasoningOnly) {
            return segmentLive
              ? thinkingRow(
                  segmentKey,
                  isLastSegment && retry ? ui("正在恢复模型连接…") : undefined,
                  !(isLastSegment && retry)
                )
              : "";
          }
          if (!segmentLive && !segmentCalls.length) {
            const interruptedThought = segmentItems.some(
              (item) => item.type === "reasoning" && !item.complete
            );
            const firstThought = segmentItems.find(
              (item) =>
                item.type === "reasoning" &&
                reasoningPreview(normalizeReasoningDisplay(item.text, { streaming: false }))
            );
            const thoughtPreview = firstThought
              ? reasoningPreview(normalizeReasoningDisplay(firstThought.text, { streaming: false }))
              : "";
            if (
              !interruptedThought &&
              segmentItems.length === 1 &&
              thoughtPreview &&
              !hasReasoningMore(firstThought.text, thoughtPreview)
            ) {
              return `<div class="process-segment is-thought-only" data-view-key="${esc(segmentKey)}"><span class="process-segment-icon" aria-hidden="true">${icon("activity")}</span><span class="process-segment-label" title="${esc(thoughtPreview)}">${esc(thoughtPreview)}</span></div>`;
            }
          }
          const segmentOpen = Boolean(isActivityOpen(segmentKey));
          let summary;
          if (segmentLive) {
            let spinner = `<span class="thinking-spinner ant-mark" data-thinking-key="${esc(`${segmentKey}:live`)}" aria-hidden="true">${antMarkSvg}</span>`;
            let stateText;
            let shimmer = false;
            if (isLastSegment && retry) {
              stateText = ui("正在恢复模型连接…");
            } else if (runningToolItem) {
              // A call in flight shows what kind of call it is, still; the ant
              // is kept for Main's own thinking.
              const meta = categoryMeta[toolCategory(runningToolItem.call)];
              spinner = `<span class="process-segment-icon" aria-hidden="true">${icon(meta.icon)}</span>`;
              stateText = meta.live();
            } else {
              stateText = ui("思考中");
              shimmer = true;
            }
            const countText = segmentCalls.length ? ui`${segmentCalls.length} 项操作` : "";
            const label = [stateText, countText].filter(Boolean).join(" · ");
            summary = `<summary aria-label="${esc(label)}">${spinner}<strong class="process-live-state${shimmer ? " shimmer-text" : ""}"${shimmer ? ` data-thinking-key="${esc(`${segmentKey}:label`)}"` : ""}>${esc(stateText)}</strong>${countText ? `<small>${esc(countText)}</small>` : ""}${segmentFailed ? ui`<em class="history-failures">${segmentFailed} 次调用未成功</em>` : ""}<span class="process-chevron" aria-hidden="true">${icon("chevron-down")}</span></summary>`;
          } else {
            let leadIcon = "activity";
            let titleText;
            if (segmentCalls.length) {
              const counts = new Map();
              for (const call of segmentCalls) {
                const kind = toolCategory(call);
                counts.set(kind, (counts.get(kind) || 0) + 1);
              }
              leadIcon = categoryMeta[[...counts.keys()][0]].icon;
              titleText = [...counts].map(([kind, count]) => categoryMeta[kind].done(count)).join(" · ");
            } else {
              const interruptedThought = segmentItems.some(
                (item) => item.type === "reasoning" && !item.complete
              );
              const firstThought = segmentItems.find(
                (item) =>
                  item.type === "reasoning" &&
                  reasoningPreview(normalizeReasoningDisplay(item.text, { streaming: false }))
              );
              const thoughtPreview = firstThought
                ? reasoningPreview(normalizeReasoningDisplay(firstThought.text, { streaming: false }))
                : "";
              titleText = interruptedThought ? ui("思考已停止") : thoughtPreview || ui("思考完成");
            }
            const showFailed = !collapsible && segmentFailed > 0;
            const label = [titleText, showFailed ? ui`${segmentFailed} 次调用未成功` : ""]
              .filter(Boolean)
              .join(" · ");
            summary = `<summary aria-label="${esc(label)}"><span class="process-segment-icon" aria-hidden="true">${icon(leadIcon)}</span><span class="process-segment-label">${esc(titleText)}</span>${showFailed ? ui`<em class="history-failures">${segmentFailed} 次调用未成功</em>` : ""}<span class="process-chevron" aria-hidden="true">${icon("chevron-down")}</span></summary>`;
          }
          const body = segmentOpen
            ? `<section class="live-workflow ${segmentLive ? "is-active" : "is-complete"}"${segmentLive ? ' aria-live="polite"' : ""}><div class="workflow-rail">${renderProcessItems(segmentItems, waitingNext)}</div></section>`
            : "";
          return `<details class="process-segment${segmentLive ? " is-live" : ""}" data-activity-key="${esc(segmentKey)}" data-view-key="${esc(segmentKey)}"${segmentOpen ? " open" : ""}>${summary}${body}</details>`;
        })
        .join("");

      const trailingThinking =
        active && (segments.at(-1)?.kind === "answer" || segments.at(-1)?.kind === "subagents") && !tailLive
          ? thinkingRow(historyKey, retry ? ui("正在恢复模型连接…") : undefined, !retry)
          : "";
      return `${segmentMarkup}${trailingThinking}${stoppedRow}${retryBanner}`;
    };

    if (rawL1 || !collapsible) {
      const markup = renderL1();
      const expectedKey =
        renderedStreamingKey &&
        streamingState &&
        renderedStreamingKey === `${historyKey}:${streamingState.answerKey}`
          ? renderedStreamingKey
          : undefined;
      return {
        markup,
        hasActivity: true,
        collapsible,
        streamedAnswer,
        persistedAnswerMatches,
        ...(expectedKey ? { streamingAnswer: { expectedKey, state: streamingState } } : {})
      };
    }

    const settled = formatExecutionDuration(executionElapsedMs(events, detail?.events)) || undefined;
    const l0Open = isHistoryOpen ? Boolean(isHistoryOpen(historyKey)) : Boolean(historyOpen);
    const heading = settled ? ui`用时 ${settled}` : ui("处理过程");
    const body = l0Open ? `<div class="execution-timeline">${renderL1()}</div>` : "";
    return {
      markup: `<details class="execution-history" data-task="${esc(taskId)}" data-history-key="${esc(historyKey)}"${l0Open ? " open" : ""}><summary aria-label="${esc(heading)}"><strong>${esc(heading)}</strong><span class="history-chevron" aria-hidden="true">${icon("chevron-down")}</span></summary>${body}</details>`,
      hasActivity: true,
      collapsible: true,
      streamedAnswer,
      persistedAnswerMatches,
      settled
    };
  }

  /** L0 fold header for a multi-input round whose interleaved L1 blocks follow below when opened. */
  function renderRoundFold(historyKey, roundEvents, open, leadBody = "") {
    const { taskId, detail } = activityContext();
    const settled = formatExecutionDuration(executionElapsedMs(roundEvents, detail?.events)) || undefined;
    const heading = settled ? ui`用时 ${settled}` : ui("处理过程");
    const body = open && leadBody ? `<div class="execution-timeline">${leadBody}</div>` : "";
    return `<details class="execution-history" data-task="${esc(taskId)}" data-history-key="${esc(historyKey)}"${open ? ' data-l0-expanded="1" open' : ""}><summary aria-label="${esc(heading)}"><strong>${esc(heading)}</strong><span class="history-chevron" aria-hidden="true">${icon("chevron-down")}</span></summary>${body}</details>`;
  }

  /** The Subagents one step sent out: a header row, then one indented row each. */
  function renderSubagentGroup(group, presentations, detail, taskId, active) {
    const rows = group.items.map((item) => {
      const open = Boolean(isActivityOpen(item.key));
      const resolved = open ? resolveExpandedCall(item.call, taskId) : undefined;
      const presentation = open
        ? presentToolCall(resolved.call, {
            active,
            workspaceRoot: detail?.storageRoot || detail?.workspaceRoot,
            taskId,
            detail,
            includeDetails: resolved.state !== "loading"
          })
        : presentations.get(item.call);
      const agent = presentation.agent;
      const elapsed = formatExecutionDuration(agent.elapsedMs);
      const { status, finished, held, running } = subagentRunState(presentation, detail);
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
      // A running one counts up in the page from when it was handed out,
      // rather than showing the time of the last snapshot.
      const since = running && presentation.statusLabel !== "协作排队中" ? Date.parse(agent.startedAt) : NaN;
      const liveClock = Number.isFinite(since)
        ? ` data-live-since="${since}" data-live-label="${esc(ui("运行中"))}"`
        : "";
      const statusText = liveClock ? liveClockText(ui("运行中"), since) : right;
      const mark = '<span class="tool-status-dot" aria-hidden="true"></span>';
      const text = finished && agent.outcome ? agent.outcome : agent.task;
      const sections = open ? presentation.detailSections || [] : [];
      const body = open ? renderToolDetailsBody(sections, resolved.state, resolved.detailKey) : "";
      return `<details class="tool-details subagent-step is-${finished ? "done" : status === "failed" ? "failed" : running ? "running" : "waiting"}" data-activity-key="${esc(item.key)}" data-view-key="${esc(item.key)}"${open ? " open" : ""}><summary class="activity-step-head">${mark}<span class="tool-action"><strong>${esc(agent.name)}</strong><span class="subagent-role-tag">${esc(agent.role)}</span>${text ? `<span class="tool-subject" title="${esc(text)}">${esc(text)}</span>` : ""}</span><span class="subagent-status"${liveClock}>${esc(statusText)}</span><span class="tool-chevron" aria-hidden="true">${icon("chevron-right")}</span></summary>${body}</details>`;
    });
    return `<div class="activity-step subagent-group" data-view-key="${esc(group.key)}"><div class="activity-step-content"><div class="activity-step-head"><span class="tool-status-dot" aria-hidden="true"></span><strong>${esc(ui`派出 ${group.items.length} 个子助手`)}</strong></div><div class="subagent-nest">${rows.join("")}</div></div></div>`;
  }

  function renderReasoningStep(reasoning, turn, key) {
    const normalized = normalizeReasoningDisplay(reasoning, { streaming: !turn.done });
    const hasText = Boolean(reasoningPreview(normalized));
    if (!hasText) {
      if (turn.done && !turn.interrupted) return "";
      const label = turn.interrupted ? ui("思考已停止") : ui("思考中");
      const stateClass = turn.done ? "reasoning-state" : "reasoning-state shimmer-text";
      const sweepKey = turn.done ? "" : ` data-thinking-key="${esc(`${key}:label`)}"`;
      const spinner = turn.done
        ? ""
        : `<span class="thinking-spinner ant-mark" data-thinking-key="${esc(key)}" aria-hidden="true">${antMarkSvg}</span>`;
      return `<div class="activity-step reasoning-step${turn.interrupted ? " is-interrupted" : ""}" data-view-key="${esc(key)}"><div class="activity-step-content"><div class="activity-step-head">${spinner}<strong class="${stateClass}"${sweepKey}>${esc(label)}</strong></div></div></div>`;
    }
    const stoppedHead = turn.interrupted
      ? `<div class="activity-step-head"><span class="reasoning-state">${esc(ui("思考已停止"))}</span></div>`
      : "";
    return `<div class="activity-step reasoning-step${turn.interrupted ? " is-interrupted" : ""}" data-view-key="${esc(key)}"><div class="activity-step-content">${stoppedHead}<div class="reasoning-copy markdown-body" data-reading-key="${esc(key)}">${markdown(normalized)}</div></div></div>`;
  }

  // Before the first token, the turn shows the row its first thought will
  // take: same place, mark and words, so nothing jumps when the thought arrives.
  // Between steps the same row waits at the end of the steps.
  function thinkingRow(key, label = ui("思考中"), announce = true) {
    return `<div class="activity-step reasoning-step"><div class="activity-step-content"><div class="activity-step-head assistant-thinking"${announce ? ' role="status"' : ""}><span class="thinking-spinner ant-mark" data-thinking-key="${esc(`${key}:pending`)}" aria-hidden="true">${antMarkSvg}</span><strong class="reasoning-state shimmer-text" data-thinking-key="${esc(`${key}:pending-label`)}">${esc(label)}</strong></div></div></div>`;
  }
  function renderThinkingPlaceholder(key, label, announce) {
    return `<section class="live-workflow is-active"><div class="workflow-rail">${thinkingRow(key, label, announce)}</div></section>`;
  }

  function renderToolStep(call, active, key, taskId, detail, summaryPresentation) {
    const open = Boolean(isActivityOpen(key));
    const resolved = open ? resolveExpandedCall(call, taskId) : undefined;
    const presentation = open
      ? presentToolCall(resolved.call, {
          active,
          workspaceRoot: detail?.storageRoot || detail?.workspaceRoot,
          taskId,
          detail,
          includeDetails: resolved.state !== "loading"
        })
      : summaryPresentation ||
        presentToolCall(call, {
          active,
          workspaceRoot: detail?.storageRoot || detail?.workspaceRoot,
          taskId,
          detail,
          includeDetails: false
        });
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
    const sections = open ? presentation.detailSections || [] : [];
    // The ant belongs to Main's own thinking, not to every call it makes.
    const indicator = '<span class="tool-status-dot" aria-hidden="true"></span>';
    const body = open ? renderToolDetailsBody(sections, resolved.state, resolved.detailKey) : "";
    return `<div class="activity-step tool-step is-${statusClass}" data-view-key="${esc(key)}">
    <div class="activity-step-content">
      <details class="tool-details" data-activity-key="${esc(key)}"${open ? " open" : ""}><summary class="activity-step-head"><span class="tool-action"><strong>${esc(name)}</strong>${subject ? `<span class="tool-subject" title="${esc(subject)}">${esc(subject)}</span>` : ""}</span><span class="activity-status ${statusClass}">${indicator}${esc(status)}</span>${presentation.durationLabel ? `<span class="tool-duration">${esc(presentation.durationLabel)}</span>` : ""}<span class="tool-chevron" aria-hidden="true">${icon("chevron-right")}</span></summary>${body}</details>${context ? `<p class="tool-context${failed ? " is-failure" : ""}">${esc(context)}</p>` : ""}
    </div>
  </div>`;
  }

  return { renderLiveActivity, renderRoundFold, renderThinkingPlaceholder, renderStreamingAnswerBody };
}
