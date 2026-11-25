import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { applyMainParkEvent } from "../web/assets/conversation.js";
import { createConversationView } from "../web/assets/controllers/conversation-view.js";
import { humanAnswerTurn } from "../web/assets/human-questions.js";

const textContent = (content) =>
  typeof content === "string" ? content : (content || []).map((part) => part.text || "").join("");
const user = { role: "user", content: "合成思考展示验收", timestamp: 1 };
const update = (type, contentIndex, value = {}) => ({
  type: "message_update",
  assistantMessageEvent: { type, contentIndex, ...value }
});
const expandHistory = (document, render, messages) => {
  for (const node of document.querySelectorAll(".execution-history")) node.open = true;
  render(messages);
  for (const node of document.querySelectorAll(".process-segment")) node.open = true;
  render(messages);
};
const expandDetails = (document, selector, render, messages) => {
  for (const node of document.querySelectorAll(selector)) node.open = true;
  render(messages);
};

test("a submitted human reply uses a compact disclosure and preserves its open state on refresh", () => {
  const { document, state, render } = fixture("human-answer-disclosure", "");
  const request = {
    requestId: "city",
    status: "answered",
    question: "你想查询哪个城市？",
    answer: "上海\n\n保留完整回答"
  };
  state.detail.humanRequests = [request];
  state.detail.runtimeEvents = [];
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  const reply = { role: "user", timestamp: 3, content: humanAnswerTurn(request.question, request.answer) };
  render([user, reply]);
  const disclosure = document.querySelector(".human-answer-details");
  assert.ok(disclosure);
  assert.match(disclosure.querySelector("summary").textContent, /回答问题/);
  assert.equal(disclosure.hasAttribute("open"), false);
  assert.equal(document.querySelector(".human-answer-card"), null);
  assert.equal(disclosure.querySelector(".human-answer-question").textContent, request.question);
  assert.match(disclosure.querySelector(".human-answer-value").textContent, /上海[\s\S]*保留完整回答/);
  disclosure.open = true;
  render([user, reply]);
  assert.equal(document.querySelector(".human-answer-details"), disclosure);
  assert.equal(disclosure.open, true);
});

test("a context divider keeps its chronological position and shows nothing of the handoff", () => {
  const { document, state, render } = fixture("context-window-divider", "");
  const reply = {
    id: "before-window",
    role: "assistant",
    content: "First reply.",
    timestamp: 2,
    stopReason: "stop"
  };
  const followUp = { id: "after-window", role: "user", content: "Continue the work.", timestamp: 4 };
  state.detail.runtimeEvents = [];
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  state.detail.contextWindows = [{ id: "window-2", timestamp: 3 }];
  render([user, reply, followUp]);
  const divider = document.querySelector(".context-window-divider");
  assert.ok(divider);
  assert.match(divider.previousElementSibling.textContent, /First reply/);
  assert.match(divider.nextElementSibling.textContent, /Continue the work/);
  assert.equal(divider.textContent, "新的上下文窗口");
  assert.equal(divider.querySelector("details, summary"), null, "nothing opens onto the handoff");
  state.detail.contextUsage = { tokens: 1000, contextWindow: 64_000, window: 2 };
  render([user, reply, followUp]);
  assert.equal(document.querySelectorAll(".context-window-divider").length, 1);
});

test("a mid-run instruction separates earlier activity from the continuing response", () => {
  const { document, state, render } = fixture("steering-order", "补充前的第六步。\n详细检查内容。");
  state.detail.runtimeEvents.push(update("thinking_end", 0, { content: "补充前的第六步。\n详细检查内容。" }));
  render();
  expandHistory(document, render);
  const before = document.querySelector("details.process-segment");
  const instruction = {
    role: "user",
    id: "steer-one",
    content: "你现在再试试",
    timestamp: 3,
    delivery: "steer",
    interjected: true
  };
  const delivered = {
    role: "custom",
    customType: "cowork-user-message",
    content: "用户在你工作期间补充了一句话：你现在再试试",
    timestamp: 3,
    details: {
      message: instruction.content,
      delivery: "steer",
      _coworkInbox: { messageId: instruction.id }
    }
  };
  state.detail.runtimeEvents.push(
    { type: "message_start", message: delivered },
    { type: "message_end", message: delivered },
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant", timestamp: 4, content: [] } },
    update("thinking_delta", 0, { delta: "根据补充指令继续执行。" })
  );
  render([user, instruction]);
  const rows = [...document.querySelector("#conversation").children];
  assert.deepEqual(
    rows.map((row) =>
      row.textContent.includes("第六步")
        ? "before"
        : row.textContent.includes(instruction.content)
          ? "instruction"
          : row.querySelector(".process-segment.is-live")
            ? "after"
            : "request"
    ),
    ["request", "before", "instruction", "after"]
  );
  // While the round is still running, earlier L1 stays chronological above the interjection
  // and keeps the reader's expanded step open without an intermediate L0 fold.
  assert.equal(document.querySelector("details.process-segment"), before);
  assert.equal(before.open, true);
  assert.equal(document.querySelectorAll(".execution-history").length, 0);
  assert.equal(document.querySelectorAll(".thinking-spinner").length, 1);
  assert.equal(document.querySelectorAll('[data-answer-kind="final"]').length, 0);
  assert.doesNotMatch(rows[1].textContent, /用时/);

  const answer = {
    role: "assistant",
    timestamp: 4,
    stopReason: "stop",
    content: [{ type: "text", text: "按补充指令完成。" }]
  };
  state.detail.runtimeEvents.push(
    { type: "message_end", message: answer },
    { type: "turn_end", message: answer }
  );
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  render([user, instruction, answer]);
  assert.equal(document.querySelectorAll('[data-answer-kind="final"]').length, 1);
  assert.equal(document.querySelectorAll("[data-thinking-key]").length, 0);
  // One L0 fold summarizes the whole round; because the reader had opened a step inside it,
  // L0 stays expanded with L1 interleaved around the interjection bubble.
  assert.equal(document.querySelectorAll(".execution-history").length, 1);
  assert.equal(document.querySelector(".execution-history").open, true);
  assert.equal(document.querySelector("details.process-segment").open, true);
  assert.equal(document.querySelectorAll(".chat-message.user").length, 2);
});

test("a settled multi-interjection round collapses into one L0 fold above stacked interjections and interleaves L1 when expanded", () => {
  const { document, state, render } = fixture("steering-collapse", "先读取配置。");
  state.detail.runtimeEvents.push(update("thinking_end", 0, { content: "先读取配置。" }));
  render();
  assert.equal(document.querySelectorAll(".execution-history").length, 0);

  const steer1 = {
    role: "user",
    id: "steer-one",
    content: "插话测试",
    timestamp: 3,
    delivery: "steer",
    interjected: true
  };
  const steer2 = {
    role: "user",
    id: "steer-two",
    content: "可以了",
    timestamp: 5,
    delivery: "steer",
    interjected: true
  };
  const deliver = (msg) => ({
    role: "custom",
    customType: "cowork-user-message",
    content: `用户在你工作期间补充了一句话：${msg.content}`,
    timestamp: msg.timestamp,
    details: { message: msg.content, delivery: "steer", _coworkInbox: { messageId: msg.id } }
  });
  const answer = {
    role: "assistant",
    timestamp: 6,
    stopReason: "stop",
    content: [{ type: "text", text: "收到，插话测试结束。" }]
  };
  state.detail.runtimeEvents.push(
    { type: "message_start", message: deliver(steer1) },
    { type: "message_end", message: deliver(steer1) },
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant", timestamp: 4, content: [] } },
    update("thinking_start", 0),
    update("thinking_end", 0, { content: "收到插话继续检查。" }),
    { type: "message_start", message: deliver(steer2) },
    { type: "message_end", message: deliver(steer2) },
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant", timestamp: 6, content: [] } },
    { type: "message_end", message: answer },
    { type: "turn_end", message: answer }
  );
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  render([user, steer1, steer2, answer]);

  // Collapsed (Codex style): User 0 -> ONE L0 fold -> User 1 -> User 2 -> Final answer.
  const collapsedChildren = [...document.querySelector("#conversation").children];
  assert.deepEqual(
    collapsedChildren.map((node) =>
      node.classList.contains("execution-history")
        ? "l0"
        : node.dataset.answerKind === "final"
          ? "final"
          : node.textContent.includes("插话测试")
            ? "steer1"
            : node.textContent.includes("可以了")
              ? "steer2"
              : "lead"
    ),
    ["lead", "l0", "steer1", "steer2", "final"]
  );
  assert.equal(collapsedChildren[1].open === true, false);
  assert.equal(document.querySelectorAll(".execution-timeline").length, 0);

  // Expanding L0 interleaves each segment's L1 around its interjection bubble.
  expandDetails(document, ".execution-history", render, [user, steer1, steer2, answer]);
  const expandedChildren = [...document.querySelector("#conversation").children];
  assert.deepEqual(
    expandedChildren.map((node) =>
      node.classList.contains("execution-history")
        ? "l0-open"
        : node.classList.contains("execution-continuation")
          ? "l1-mid"
          : node.dataset.answerKind === "final"
            ? "final"
            : node.textContent.includes("插话测试")
              ? "steer1"
              : node.textContent.includes("可以了")
                ? "steer2"
                : "lead"
    ),
    ["lead", "l0-open", "steer1", "l1-mid", "steer2", "final"]
  );
  assert.equal(expandedChildren[1].querySelectorAll(".process-segment").length, 1);
  assert.equal(expandedChildren[3].querySelectorAll(".process-segment").length, 1);
});

test("a superseded waiting/tool round merges with the follow-up turn into one L0 fold and isolates cross-run preludes", () => {
  const origin = Date.parse("2026-10-08T00:00:00.000Z");
  const { document, state, render } = fixture("superseded-waiting", "先检查进度。");
  const firstUser = { role: "user", id: "first-turn", content: "进度咋样了", timestamp: origin + 1000 };
  const progressUpdate = {
    role: "assistant",
    timestamp: origin + 2000,
    stopReason: "toolUse",
    content: [{ type: "text", text: "三块已完成一块，正在继续推进。" }]
  };
  const followup = { role: "user", id: "later-turn", content: "怎么样了？", timestamp: origin + 5000 };
  const finalAnswer = {
    role: "assistant",
    timestamp: origin + 6000,
    stopReason: "stop",
    content: [{ type: "text", text: "全部已完成并合入。" }]
  };
  const nextUser = {
    role: "user",
    id: "next-run-user",
    content: "推送到远程吧",
    timestamp: origin + 605_000
  };
  const nextAnswer = {
    role: "assistant",
    timestamp: origin + 610_000,
    stopReason: "stop",
    content: [{ type: "text", text: "已推送。" }]
  };
  state.detail.task.status = "completed";
  state.detail.runtime.active = false;
  state.detail.runtimeEvents = [
    { type: "runtime_event", runId: "run-1", payload: { type: "turn_start" } },
    { type: "runtime_event", runId: "run-1", payload: { type: "message_start", message: firstUser } },
    {
      type: "runtime_event",
      runId: "run-1",
      payload: {
        type: "message_start",
        message: { role: "assistant", timestamp: origin + 2000, content: [] }
      }
    },
    { type: "runtime_event", runId: "run-1", payload: update("thinking_start", 0) },
    {
      type: "runtime_event",
      runId: "run-1",
      payload: update("thinking_end", 0, { content: "先检查进度。" })
    },
    { type: "runtime_event", runId: "run-1", payload: { type: "message_end", message: progressUpdate } },
    {
      type: "runtime_event",
      runId: "run-1",
      payload: update("toolcall_end", 1, {
        toolCall: { id: "cmd-1", name: "bash", arguments: { command: "git status" } }
      })
    },
    {
      type: "runtime_event",
      runId: "run-1",
      payload: { type: "tool_execution_end", toolCallId: "cmd-1", result: { content: [] } }
    },
    { type: "main.run_waiting", runId: "run-1" },
    { type: "runtime_event", runId: "run-1", payload: { type: "message_start", message: followup } },
    { type: "runtime_event", runId: "run-1", payload: { type: "message_end", message: followup } },
    { type: "runtime_event", runId: "run-1", payload: { type: "turn_start" } },
    {
      type: "runtime_event",
      runId: "run-1",
      payload: {
        type: "message_start",
        message: { role: "assistant", timestamp: origin + 6000, content: [] }
      }
    },
    { type: "runtime_event", runId: "run-1", payload: update("thinking_start", 0) },
    {
      type: "runtime_event",
      runId: "run-1",
      payload: update("thinking_end", 0, { content: "整理最终结果。" })
    },
    { type: "runtime_event", runId: "run-1", payload: { type: "message_end", message: finalAnswer } },
    { type: "runtime_event", runId: "run-1", payload: { type: "turn_end", message: finalAnswer } },
    // Next Run's startup events must not bleed into run-1's duration.
    { type: "runtime_event", runId: "run-2", payload: { type: "agent_start" } },
    { type: "runtime_event", runId: "run-2", payload: { type: "turn_start" } },
    { type: "runtime_event", runId: "run-2", payload: { type: "message_start", message: nextUser } },
    { type: "runtime_event", runId: "run-2", payload: { type: "message_end", message: nextUser } },
    {
      type: "runtime_event",
      runId: "run-2",
      payload: {
        type: "message_start",
        message: { role: "assistant", timestamp: origin + 610_000, content: [] }
      }
    },
    { type: "runtime_event", runId: "run-2", payload: update("thinking_start", 0) },
    {
      type: "runtime_event",
      runId: "run-2",
      payload: update("thinking_end", 0, { content: "执行推送。" })
    },
    { type: "runtime_event", runId: "run-2", payload: { type: "message_end", message: nextAnswer } },
    { type: "runtime_event", runId: "run-2", payload: { type: "turn_end", message: nextAnswer } }
  ];
  state.detail.events = [
    { runId: "run-1", type: "main.run_spawned", occurredAt: "2026-10-08T00:00:00.000Z" },
    { runId: "run-1", type: "main.run_completed", occurredAt: "2026-10-08T00:00:10.000Z" },
    { runId: "run-2", type: "main.run_spawned", occurredAt: "2026-10-08T00:10:00.000Z" },
    { runId: "run-2", type: "main.run_completed", occurredAt: "2026-10-08T00:10:30.000Z" }
  ];
  render([firstUser, progressUpdate, followup, finalAnswer, nextUser, nextAnswer]);

  const histories = [...document.querySelectorAll(".execution-history")];
  assert.equal(histories.length, 2);
  // First round combines user + followup under one 10s L0 fold (without run-2's 30s bleeding in).
  assert.equal(histories[0].querySelector(":scope > summary strong").textContent, "用时 10 秒");
  assert.equal(histories[1].querySelector(":scope > summary strong").textContent, "用时 30 秒");
  assert.equal(
    document.querySelectorAll("#conversation > .process-segment, #conversation > .live-answer").length,
    0
  );
  assert.equal(document.querySelectorAll('[data-answer-kind="final"]').length, 2);
});

test("an accepted instruction leaves the current tool active until Pi delivers it", () => {
  const { document, state, render } = fixture("steering-in-flight", "");
  state.detail.runtimeEvents.push({
    type: "tool_execution_start",
    toolCallId: "in-flight",
    toolName: "bash",
    args: { command: "node check.mjs" }
  });
  render();
  // Collapsed by default while running: summary reflects the coarse running action.
  const segment = document.querySelector(".process-segment.is-live");
  assert.ok(segment);
  assert.equal(segment.open === true, false);
  assert.match(segment.querySelector("summary").textContent, /运行命令中/);
  expandHistory(document, render);
  const tool = document.querySelector(".tool-details");
  render([
    user,
    {
      role: "user",
      id: "pending-steer",
      content: "等当前调用返回后修改",
      timestamp: 3,
      delivery: "steer",
      interjected: true
    }
  ]);
  assert.equal(document.querySelector(".tool-details"), tool);
  assert.match(document.querySelector(".tool-step").textContent, /执行中/);
  assert.equal(document.querySelectorAll('[data-answer-kind="pending"]').length, 1);
  const rows = [...document.querySelector("#conversation").children];
  assert.match(rows[1].textContent, /check\.mjs/);
  assert.match(rows[2].textContent, /等当前调用返回后修改/);
});

function fixture(taskId = "reasoning-one", thought = "先核对第一部分。", actions = {}) {
  const { document } = parseHTML('<main id="conversation"></main>');
  const state = {
    selected: taskId,
    localMessages: [],
    executionHistoryOpen: new Map(),
    detail: {
      task: { taskId, status: "running" },
      runtime: { active: true },
      runtimeEvents: [
        { type: "turn_start" },
        { type: "message_start", message: user },
        { type: "message_start", message: { role: "assistant", timestamp: 2, content: [] } },
        update("thinking_start", 0),
        update("thinking_delta", 0, { delta: thought })
      ]
    }
  };
  const view = createConversationView({
    state,
    $: (selector) => document.querySelector(selector),
    bindStarterPrompts() {},
    textContent,
    ...actions
  });
  const render = (messages = [user]) => view.renderConversation(messages, state.detail.task);
  render();
  return { document, state, render };
}

test("retrying keeps the original request and attachment when its timestamp matches the next position", () => {
  const { document, state, render } = fixture("retry-key-collision", "已检查输入。");
  const original = {
    ...user,
    content: "原始请求\n\nAttached files:\nsource.txt\nORIGINAL_ATTACHMENT_BODY"
  };
  render([original]);
  const row = document.querySelector(".chat-message.user");
  state.localMessages.push({ role: "user", content: "继续刚才未完成的请求。", taskId: state.selected });
  render([original]);
  render([original]);
  const rows = [...document.querySelectorAll(".chat-message.user")];
  assert.equal(rows.length, 2);
  assert.equal(rows[0], row);
  assert.match(rows[0].textContent, /原始请求/);
  assert.match(rows[1].textContent, /继续刚才/);
  assert.equal(document.querySelectorAll(".message-attachments").length, 1);
});

test("continuous thought deltas retain the disclosure, spinner and existing paragraph nodes", () => {
  const { document, state, render } = fixture("stable-thought", "先核对输入。");
  expandHistory(document, render);
  const detail = document.querySelector("details.process-segment");
  const spinner = detail.querySelector(".thinking-spinner");
  const paragraph = detail.querySelector(".reasoning-copy p");
  for (const delta of ["然后读取", "约束", "，继续检查。"]) {
    state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta }));
    render();
    assert.equal(document.querySelector("details.process-segment"), detail);
    assert.equal(detail.querySelector(".thinking-spinner"), spinner);
    assert.equal(detail.querySelector(".reasoning-copy p"), paragraph);
    assert.equal(detail.open, true);
  }
  assert.match(paragraph.textContent, /然后读取约束，继续检查。/);
});

test("between steps the next step's thinking row waits at the end of the steps", () => {
  const { document, state, render } = fixture("model-gaps");
  expandHistory(document, render);
  const waiting = () =>
    document.querySelector(".workflow-rail > .reasoning-step:last-child .assistant-thinking");
  state.detail.runtimeEvents.push(update("thinking_end", 0, { content: "先核对第一部分。" }));
  render();
  assert.match(waiting()?.textContent || "", /思考中/);
  assert.equal(document.querySelectorAll(".live-workflow-head").length, 0);
  state.detail.runtimeEvents.push(
    update("toolcall_end", 1, {
      toolCall: { id: "attachment", name: "read_attachment", arguments: { path: "input.txt" } }
    }),
    { type: "tool_execution_start", toolCallId: "attachment", toolName: "read_attachment" }
  );
  render();
  // A running tool is the moving row; nothing waits after it.
  assert.equal(waiting(), null);
  assert.match(document.querySelector(".process-segment > summary").textContent, /读取文件中/);
  assert.match(document.querySelector(".tool-action").textContent, /读取附件/);
  // The running call shows a still dot beside its status, not the working ant.
  assert.equal(document.querySelectorAll(".tool-step .ant-mark").length, 0);
  assert.equal(document.querySelectorAll(".tool-step.is-running .tool-status-dot").length, 1);
  assert.equal(document.querySelectorAll(".process-segment > summary .ant-mark").length, 0);
  state.detail.runtimeEvents.push({
    type: "tool_execution_end",
    toolCallId: "attachment",
    toolName: "read_attachment",
    result: { content: [] }
  });
  render();
  assert.match(waiting()?.textContent || "", /思考中/);
  state.detail.runtime.active = false;
  state.detail.task.status = "cancelled";
  render();
  assert.equal(waiting(), null);
  assert.equal(document.querySelectorAll("[data-thinking-key]").length, 0);
});

test("a parked or unfinished round folds its steps without a turn endline or active spinners", () => {
  const { document, state, render } = fixture("parked-run", "本轮变化已核实。\n准备进入等待状态。");
  state.detail.runtimeEvents.push(
    update("thinking_end", 0, { content: "本轮变化已核实。\n准备进入等待状态。" }),
    { type: "main.run_waiting" }
  );
  state.detail.runtime.active = false;
  state.detail.task.status = "waiting";
  state.detail.parked = { wakeAt: "2099-01-01T00:00:00Z", reason: "等待新变化" };
  render();
  assert.equal(document.querySelectorAll(".live-workflow-head, .turn-endline").length, 0);
  assert.equal(document.querySelectorAll("[data-thinking-key]").length, 0);
  assert.equal(document.querySelector("details.process-segment").open === true, false);
  expandHistory(document, render);
  assert.match(document.querySelector(".reasoning-copy").textContent, /本轮变化已核实/);
  state.detail.runtime.active = true;
  state.detail.task.status = "running";
  const wake = { type: "runtime_event", runId: "run", payload: { type: "turn_start" } };
  state.detail.task.activeRunId = wake.runId;
  state.detail.runtimeEvents.push(wake);
  assert.ok(applyMainParkEvent(state.detail, wake));
  render();
  assert.match(document.querySelector(".assistant-thinking").textContent, /思考中/);
});

test("no first token and an automatic retry both keep a visible waiting animation", () => {
  const { document, state, render } = fixture("no-first-token", "");
  state.detail.runtimeEvents = [];
  render();
  const progress = document.querySelector(".assistant-thinking .thinking-spinner");
  assert.ok(progress);
  render();
  assert.equal(document.querySelector(".assistant-thinking .thinking-spinner"), progress);
  state.detail.runtimeEvents.push({ type: "auto_retry_start", attempt: 1, maxAttempts: 5 });
  render();
  assert.ok(document.querySelector(".assistant-thinking .thinking-spinner"));
  assert.match(document.querySelector(".assistant-thinking").textContent, /恢复模型连接/);
  state.detail.runtime.active = false;
  state.detail.task.status = "cancelled";
  render();
  assert.equal(document.querySelectorAll("[data-thinking-key]").length, 0);
});

test("unknown tool names remain identifiable and HTML in a tool name is escaped", () => {
  const { document, state, render } = fixture("named-custom-tool", "");
  state.detail.runtimeEvents.push({
    type: "tool_execution_start",
    toolCallId: "custom",
    toolName: "mcp__slides__inspect<img src=x onerror=alert(1)>"
  });
  render();
  assert.match(document.querySelector(".process-segment > summary").textContent, /执行操作中/);
  assert.equal(document.querySelector(".process-segment > summary img"), null);
  expandHistory(document, render);
  assert.match(document.querySelector(".tool-action").textContent, /mcp__slides__inspect/);
  assert.equal(document.querySelector(".tool-action img"), null);
  assert.doesNotMatch(document.querySelector(".tool-action").textContent, /执行工具/);
});

test("Main retry progress uses bounded event fields and clears on recovery", () => {
  const { document, state, render } = fixture("retry-progress", "");
  state.detail.runtimeEvents.push({
    type: "auto_retry_start",
    attempt: 3,
    maxAttempts: 5,
    errorMessage: "Bearer sk-test-synthetic-private"
  });
  render();
  assert.match(document.querySelector(".request-retry").textContent, /第 3 \/ 5 次自动重试/);
  assert.doesNotMatch(
    document.querySelector("#conversation").textContent,
    /Bearer|sk-test-synthetic|private/
  );
  state.detail.runtimeEvents.push({ type: "auto_retry_end", attempt: 3, success: true });
  render();
  assert.equal(document.querySelector(".request-retry"), null);
});

test("an exhausted Main retry shows the observed retry count with manual recovery", () => {
  const { document, state, render } = fixture("retry-exhausted", "");
  state.detail.runtime.active = false;
  state.detail.task = { ...state.detail.task, status: "failed", lastError: "503 service unavailable" };
  state.detail.runtimeEvents.push({
    type: "auto_retry_end",
    attempt: 5,
    success: false,
    finalError: "Bearer sk-test-synthetic-private"
  });
  render();
  assert.match(document.querySelector('[role="alert"]').textContent, /已自动重试 5 次/);
  assert.equal(document.querySelectorAll("[data-retry-request]").length, 1);
  assert.doesNotMatch(
    document.querySelector("#conversation").textContent,
    /Bearer|sk-test-synthetic|private/
  );
});

test("consecutive successful file and command calls compact into an expandable group while failure stays visible", () => {
  const { document, state, render } = fixture("compact-tools", "");
  const add = (index, name, failed = false) => {
    const id = `operation-${index}`;
    state.detail.runtimeEvents.push(
      update("toolcall_end", index, {
        toolCall: { id, name, arguments: { path: `file-${index}.txt`, command: "node check.mjs" } }
      }),
      { type: "tool_execution_end", toolCallId: id, toolName: name, isError: failed, result: { content: [] } }
    );
  };
  add(1, "read");
  add(2, "read");
  add(3, "edit");
  add(4, "bash");
  add(5, "bash", true);
  render();
  const segment = document.querySelector(".process-segment");
  assert.equal(segment.open === true, false);
  assert.match(segment.querySelector("summary").textContent, /1 次调用未成功/);
  assert.equal(segment.querySelectorAll(".tool-step").length, 0, "collapsed segment omits inner rows");
  expandHistory(document, render);
  assert.equal(segment.querySelectorAll(".tool-step").length, 5);
  assert.equal(document.querySelectorAll(".workflow-rail > .tool-step.is-failed").length, 1);
  const firstTool = segment.querySelector(".tool-details");
  firstTool.open = true;
  state.detail.runtimeEvents.push(
    update("thinking_start", 6),
    update("thinking_delta", 6, { delta: "失败需要检查。" })
  );
  render();
  assert.equal(document.querySelector(".process-segment"), segment);
  assert.equal(segment.open, true);
  assert.equal(segment.querySelector(".tool-details"), firstTool);
  assert.equal(firstTool.open, true);
});

test("compaction does not hide running commands or merge calls across reasoning", () => {
  const { document, state, render } = fixture("group-boundaries", "");
  for (const index of [1, 2]) {
    state.detail.runtimeEvents.push(
      update("toolcall_end", index, {
        toolCall: { id: `read-${index}`, name: "read", arguments: { path: "input.txt" } }
      }),
      { type: "tool_execution_end", toolCallId: `read-${index}`, result: { content: [] } }
    );
  }
  state.detail.runtimeEvents.push(
    update("thinking_delta", 3, { delta: "现在运行验证。" }),
    update("toolcall_end", 4, {
      toolCall: { id: "running", name: "bash", arguments: { command: "node verify.mjs" } }
    }),
    { type: "tool_execution_start", toolCallId: "running", toolName: "bash" }
  );
  render();
  assert.match(document.querySelector(".process-segment.is-live > summary").textContent, /运行命令中/);
  expandHistory(document, render);
  assert.equal(document.querySelectorAll(".workflow-rail > .tool-step").length, 3);
  assert.equal(document.querySelectorAll(".workflow-rail > .tool-step.is-running").length, 1);
  assert.equal(document.querySelectorAll(".reasoning-step").length, 2);
});

test("a collapsed multi-sentence thought uses its first sentence as the single-layer summary and renders flat prose on open", () => {
  const thought = "先读取项目说明，确认约束。然后检查入口与工具。";
  const { document, state, render } = fixture("preview", thought);
  assert.match(document.querySelector(".process-segment.is-live > summary").textContent, /思考中/);
  state.detail.runtimeEvents.push(update("thinking_end", 0, { content: thought }));
  state.detail.runtime.active = false;
  state.detail.task.status = "waiting";
  render();
  const segment = document.querySelector("details.process-segment");
  assert.equal(segment.querySelector(".process-segment-label").textContent, "先读取项目说明，确认约束。");
  assert.doesNotMatch(
    segment.querySelector("summary").textContent,
    /然后检查|查看思考过程|实时更新|思考完成/
  );
  assert.equal(segment.open === true, false);
  assert.equal(segment.querySelector(".reasoning-copy"), null);
  expandHistory(document, render);
  assert.equal(document.querySelectorAll(".reasoning-details, .activity-raw").length, 0);
  assert.equal(segment.querySelector(".reasoning-copy").textContent, thought);
});

test("a single-line completed thought renders as one static line with no nested disclosure", () => {
  const { document, state, render } = fixture("single-line-thought", "**Checking current catalog**");
  state.detail.runtimeEvents.push(update("thinking_end", 0, { content: "**Checking current catalog**" }));
  state.detail.runtime.active = false;
  state.detail.task.status = "waiting";
  render();
  const row = document.querySelector(".process-segment.is-thought-only");
  assert.ok(row);
  assert.equal(row.tagName, "DIV");
  assert.equal(row.querySelector(".process-segment-label").textContent, "Checking current catalog");
  assert.equal(
    document.querySelectorAll("details.process-segment, .reasoning-details, .activity-raw").length,
    0
  );
});

test("tool rows show delegation purpose and avoid repeating an already visible success status", () => {
  const { document, state, render } = fixture("friendly-purpose", "");
  for (const [index, toolCall] of [
    { id: "script", name: "bash", arguments: { command: "python3 verify.py", timeout: 120 } },
    { id: "delegate", name: "call_subagent", arguments: { name: "Ara", task: "核对文稿的引用和文件链接" } }
  ].entries()) {
    state.detail.runtimeEvents.push(update("toolcall_end", index + 1, { toolCall }), {
      type: "tool_execution_end",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: { content: [], isError: false }
    });
  }
  render();
  expandHistory(document, render);
  assert.equal(document.querySelectorAll(".tool-step").length, 1);
  assert.equal(document.querySelector(".tool-step .tool-context"), null);
  const group = document.querySelector(".subagent-group");
  assert.match(group.querySelector(".activity-step-head").textContent, /派出 1 个子助手/);
  const agent = group.querySelector(".subagent-step > summary");
  assert.equal(agent.querySelector("strong").textContent, "Ara");
  assert.equal(agent.querySelector(".subagent-role-tag").textContent, "执行");
  assert.equal(agent.querySelector(".tool-subject").textContent, "核对文稿的引用和文件链接");
  assert.equal(document.querySelectorAll(".activity-status")[0].textContent, "完成");
  assert.doesNotMatch(
    [...document.querySelectorAll(".tool-details > summary")].map((node) => node.textContent).join(""),
    /command=|timeout=|120/
  );
});

test("all tool diagnostic sections retain independent reading positions through updates and collapse", () => {
  const { document, state, render } = fixture("tool-reading", "先核对输出。");
  state.detail.runtimeEvents.push(
    update("toolcall_end", 1, {
      toolCall: { id: "verify", name: "bash", arguments: { command: "python3 verify.py" } }
    }),
    {
      type: "tool_execution_end",
      toolCallId: "verify",
      result: { content: [{ type: "text", text: "output\n".repeat(80) }] }
    }
  );
  render();
  expandHistory(document, render);
  expandDetails(document, ".tool-details", render);
  const parameters = document.querySelector('[data-reading-key="参数"]');
  const returned = document.querySelector('[data-reading-key="返回结果"]');
  parameters.scrollTop = 91;
  returned.scrollTop = 123;
  returned.scrollLeft = 11;
  state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta: "更新过程。" }));
  render();
  assert.equal(document.querySelector('[data-reading-key="参数"]').scrollTop, 91);
  assert.equal(document.querySelector('[data-reading-key="返回结果"]').scrollTop, 123);
  assert.equal(document.querySelector('[data-reading-key="返回结果"]').scrollLeft, 11);
  document.querySelector(".tool-details").open = false;
  render();
  document.querySelector(".tool-details").open = true;
  document.querySelector(".tool-details").dispatchEvent(new document.defaultView.Event("toggle"));
  assert.equal(document.querySelector('[data-reading-key="返回结果"]').scrollTop, 123);
});

test("a rejected finish acknowledgement remains waiting in the visible tool row", () => {
  const { document, state, render } = fixture("waiting-finish", "");
  state.detail.runtimeEvents.push(
    update("toolcall_end", 1, {
      toolCall: { id: "finish", name: "finish_task", arguments: { summary: "等待检查产物" } }
    }),
    {
      type: "tool_execution_end",
      toolCallId: "finish",
      result: { content: [], details: { completed: false } }
    }
  );
  render();
  expandHistory(document, render);
  assert.equal(document.querySelector(".activity-status").textContent, "等待中");
  assert.equal(document.querySelector(".tool-step").classList.contains("is-done"), false);
  assert.equal(document.querySelectorAll(".tool-step .ant-mark").length, 0);
});

test("command exit evidence marks a failed tool while counting its returned call", () => {
  const { document, state, render } = fixture("exit-code-evidence", "");
  state.detail.runtimeEvents.push(
    update("toolcall_end", 1, {
      toolCall: { id: "exit", name: "bash", arguments: { command: "python3 verify.py" } }
    }),
    {
      type: "tool_execution_end",
      toolCallId: "exit",
      isError: true,
      result: {
        content: [{ type: "text", text: "SyntaxError: invalid syntax\n\nCommand exited with code 1" }]
      }
    }
  );
  render();
  expandHistory(document, render);
  assert.equal(document.querySelector(".activity-status").textContent, "调用失败");
  assert.equal(document.querySelector(".tool-step").classList.contains("is-failed"), true);
  assert.equal(document.querySelector(".tool-context").textContent, "Python 语法错误");
  expandDetails(document, ".tool-details", render);
  assert.match(document.querySelector(".tool-details-body").textContent, /SyntaxError: invalid syntax/);
});

test("zero-output HTTP stream failure shows a safe recovery card instead of an empty waiting workflow", () => {
  let retries = 0;
  const { document, state, render } = fixture("zero-error", "", {
    retry: () => retries++
  });
  const error = {
    role: "assistant",
    timestamp: 2,
    stopReason: "error",
    errorMessage: "Upstream HTTP/2 stream failed",
    content: [{ type: "text", text: "\n" }]
  };
  state.detail.runtimeEvents.push(
    update("text_delta", 0, { delta: "" }),
    { type: "message_end", message: error },
    { type: "turn_end", message: error }
  );
  state.detail.runtime.active = false;
  state.detail.task.status = "failed";
  state.detail.task.lastError = error.errorMessage;
  render([user, error]);
  const alert = document.querySelector('[role="alert"]');
  assert.match(alert.textContent, /模型连接中断/);
  assert.match(alert.textContent, /已保留|重试/);
  assert.doesNotMatch(alert.textContent, /Upstream|HTTP\/2|等待继续/);
  assert.equal(document.querySelectorAll(".live-workflow").length, 0);
  assert.equal(document.querySelectorAll('[data-answer-kind="final"]').length, 0);
  assert.equal(document.querySelectorAll(".thinking-spinner").length, 0);
  assert.equal(retries, 0);
  assert.deepEqual(
    [...alert.querySelectorAll("button")].map((button) => button.textContent.trim()),
    ["重试", "查看详情"]
  );
  document.querySelector("[data-retry-request]").click();
  assert.equal(retries, 1);
});

test("a latest stopped assistant error exposes recovery before task status polling catches up and retains partial thought", () => {
  const { document, state, render } = fixture("partial-error", "已经读取输入约束。");
  expandHistory(document, render);
  const error = {
    role: "assistant",
    timestamp: 2,
    stopReason: "error",
    errorMessage: "Upstream HTTP/2 stream failed",
    content: [{ type: "thinking", thinking: "已经读取输入约束。" }]
  };
  state.detail.runtimeEvents.push(
    { type: "message_end", message: error },
    { type: "turn_end", message: error }
  );
  state.detail.runtime.active = false;
  state.detail.task.status = "waiting";
  render([user, error]);
  assert.match(document.querySelector('[role="alert"]')?.textContent || "", /模型连接中断/);
  assert.equal(document.querySelector("details.process-segment").open, true);
  assert.equal(document.querySelector(".reasoning-copy").textContent, "已经读取输入约束。");
  assert.match(document.querySelector(".reasoning-state").textContent, /思考已停止/);
  assert.equal(document.querySelectorAll(".turn-endline").length, 0);
  assert.equal(document.querySelectorAll('[data-answer-kind="final"]').length, 0);
});

test("recovery buttons belong to their rendered task and cannot act on a newer selection", () => {
  const retries = [];
  const { document, state, render } = fixture("recovery-owner-a", "", {
    retry: (taskId) => retries.push(taskId)
  });
  const error = {
    role: "assistant",
    timestamp: 2,
    stopReason: "error",
    errorMessage: "401 Authentication failed",
    content: []
  };
  state.detail.runtime.active = false;
  state.detail.task.status = "failed";
  render([user, error]);
  const staleRetry = document.querySelector("[data-retry-request]");
  staleRetry.click();
  assert.deepEqual(retries, ["recovery-owner-a"]);
  state.selected = "recovery-owner-b";
  state.detail = {
    task: { taskId: state.selected, status: "failed", lastError: error.errorMessage },
    runtime: { active: false },
    runtimeEvents: []
  };
  staleRetry.click();
  assert.deepEqual(retries, ["recovery-owner-a"]);
  render([user, error]);
  assert.equal(document.querySelector("[data-recovery-task]").dataset.recoveryTask, "recovery-owner-b");
  document.querySelector("[data-retry-request]").click();
  assert.deepEqual(retries, ["recovery-owner-a", "recovery-owner-b"]);
});

test("failure recovery never exposes unknown raw provider errors containing credential-like text", () => {
  const { document, state, render } = fixture("safe-error", "");
  state.detail.runtime.active = false;
  state.detail.task.status = "failed";
  state.detail.task.lastError = "Provider refused request Authorization: Bearer sk-test-synthetic-never-real";
  render();
  assert.match(document.querySelector('[role="alert"]').textContent, /任务失败/);
  assert.doesNotMatch(
    document.querySelector("#conversation").innerHTML,
    /Authorization|Bearer|sk-test-synthetic/
  );
});

test("a current Main-process failure uses its ledger layer without blaming model settings", () => {
  const { document, state, render } = fixture("process-error", "");
  state.detail.runtime.active = false;
  state.detail.task = {
    ...state.detail.task,
    status: "failed",
    activeRunId: "current-run",
    lastError: "Main process exited with code=503 signal= private-process-detail"
  };
  state.detail.events = [
    {
      runId: "old-run",
      type: "main.run_failed",
      payload: { failure: { kind: "model_request", httpStatus: 401 } }
    },
    { runId: "current-run", type: "main.run_failed", payload: { failure: { kind: "main_process" } } }
  ];
  render();
  assert.equal(document.querySelector('[role="alert"] strong').textContent, "执行进程退出");
  assert.match(document.querySelector('[role="alert"]').textContent, /手动重试继续/);
  assert.equal(document.querySelectorAll("[data-error-settings]").length, 0);
  assert.doesNotMatch(
    document.querySelector('[role="alert"]').textContent,
    /模型|503|private-process-detail/
  );
});

test("a launch failure with no saved messages still exposes recovery after reloading", () => {
  const { document, state, render } = fixture("empty-process-error", "");
  state.detail.runtime = { active: false };
  state.detail.runtimeEvents = [];
  state.detail.task = {
    ...state.detail.task,
    status: "failed",
    activeRunId: "failed-launch",
    lastError: "spawn ENOENT private-path"
  };
  state.detail.events = [
    { runId: "failed-launch", type: "main.run_failed", payload: { failure: { kind: "main_process" } } }
  ];
  render([]);
  assert.equal(document.querySelectorAll(".welcome-empty").length, 0);
  assert.equal(document.querySelector('[role="alert"] strong').textContent, "执行进程退出");
  assert.equal(document.querySelectorAll("[data-retry-request]").length, 1);
  assert.doesNotMatch(
    document.querySelector('[role="alert"]').textContent,
    /你发送的内容|已有过程|private-path/
  );
});

test("typed model failures use only actual HTTP evidence and hide private unclassified details", () => {
  for (const [httpStatus, message] of [
    [400, "请求参数"],
    [401, "认证失败"],
    [403, "访问权限"],
    [404, "API 地址"],
    [429, "限流"],
    [503, "暂时不可用"],
    [undefined, "原因尚未确定"]
  ]) {
    const { document, state, render } = fixture(`model-error-${httpStatus}`, "");
    state.detail.runtime.active = false;
    state.detail.task = {
      ...state.detail.task,
      status: "failed",
      activeRunId: "current-run",
      lastError: "Provider refused Authorization: Bearer sk-test-synthetic-status-401-private"
    };
    state.detail.events = [
      {
        runId: "current-run",
        type: "main.run_failed",
        payload: { failure: { kind: "model_request", ...(httpStatus ? { httpStatus } : {}) } }
      }
    ];
    render();
    assert.equal(document.querySelector('[role="alert"] strong').textContent, "模型请求未完成");
    assert.ok(document.querySelector('[role="alert"]').textContent.includes(message));
    assert.doesNotMatch(
      document.querySelector('[role="alert"]').textContent,
      /Bearer|sk-test-synthetic|private/
    );
    if (!httpStatus)
      assert.doesNotMatch(document.querySelector('[role="alert"]').textContent, /认证失败|限流|暂时不可用/);
  }
});

test("another run's typed failure cannot classify the selected run's legacy error", () => {
  const { document, state, render } = fixture("legacy-error", "");
  state.detail.runtime.active = false;
  state.detail.task = {
    ...state.detail.task,
    status: "failed",
    activeRunId: "current-run",
    lastError: "unknown private detail"
  };
  state.detail.events = [
    { runId: "older-run", type: "main.run_failed", payload: { failure: { kind: "main_process" } } }
  ];
  render();
  assert.equal(document.querySelector('[role="alert"] strong').textContent, "任务失败");
  assert.doesNotMatch(document.querySelector('[role="alert"]').textContent, /private detail/);
});

test("a typed model-not-found failure explains account availability without disclosing provider details", () => {
  const { document, state, render } = fixture("model-not-found", "");
  state.detail.runtime.active = false;
  state.detail.task = {
    ...state.detail.task,
    status: "failed",
    activeRunId: "current-run",
    lastError: '404: {"type":"model_not_found","message":"Bearer sk-test-synthetic-private"}'
  };
  state.detail.events = [
    {
      runId: "current-run",
      type: "main.run_failed",
      payload: { failure: { kind: "model_request", httpStatus: 404, providerCode: "model_not_found" } }
    }
  ];
  render();
  const alert = document.querySelector('[role="alert"]').textContent;
  assert.match(alert, /账号或分组.*HTTP 404.*可用状态/);
  assert.doesNotMatch(alert, /Bearer|sk-test-synthetic|输出上限|推理参数/);
  assert.equal(document.querySelectorAll("[data-retry-request]").length, 1);
});

test("an older errored event cannot overwrite a newer successful assistant snapshot", () => {
  const { document, state, render } = fixture("older-error", "");
  const old = {
    role: "assistant",
    timestamp: 2,
    stopReason: "error",
    errorMessage: "Upstream HTTP/2 stream failed",
    content: []
  };
  const latest = {
    role: "assistant",
    timestamp: 3,
    stopReason: "stop",
    content: [{ type: "text", text: "已恢复并检查完成。" }]
  };
  state.detail.runtimeEvents.push({ type: "message_end", message: old }, { type: "turn_end", message: old });
  state.detail.runtime.active = false;
  state.detail.task.status = "waiting";
  render([user, old, latest]);
  assert.equal(document.querySelectorAll('[role="alert"]').length, 0);
});

test("cancelled, aborted, successful completion and an active retry do not report a stale model failure", () => {
  for (const [status, stopReason, active] of [
    ["cancelled", "error", false],
    ["waiting", "aborted", false],
    ["completed", "stop", false],
    ["failed", "error", true]
  ]) {
    const { document, state, render } = fixture(`not-error-${status}-${active}`, "");
    const message = {
      role: "assistant",
      timestamp: 2,
      stopReason,
      errorMessage: "Upstream HTTP/2 stream failed",
      content: stopReason === "stop" ? [{ type: "text", text: "任务已完成。" }] : []
    };
    state.detail.runtimeEvents.push({ type: "message_end", message }, { type: "turn_end", message });
    state.detail.runtime.active = active;
    state.detail.task.status = status;
    state.detail.task.lastError = "Upstream HTTP/2 stream failed";
    render([user, message]);
    assert.equal(document.querySelectorAll('[role="alert"]').length, 0, `${status}/${stopReason}/${active}`);
    assert.equal(
      document.querySelectorAll('[data-answer-kind="final"]').length,
      status === "completed" ? 1 : 0
    );
  }
});

test("the actual model's bold planning heading is plain in the summary and formatted when expanded", () => {
  const thought =
    "**Planning project inspection and testing**\nI should read the project instructions first.";
  const { document, state, render } = fixture("markdown-preview", thought);
  assert.match(document.querySelector(".process-segment.is-live > summary").textContent, /思考中/);
  state.detail.runtimeEvents.push(update("thinking_end", 0, { content: thought }));
  state.detail.runtime.active = false;
  state.detail.task.status = "waiting";
  render();
  assert.equal(
    document.querySelector(".process-segment-label").textContent,
    "Planning project inspection and testing"
  );
  assert.equal(document.querySelector("details.process-segment").open === true, false);
  expandHistory(document, render);
  assert.equal(
    document.querySelector(".reasoning-copy strong").textContent,
    "Planning project inspection and testing"
  );
  assert.match(
    document.querySelector(".reasoning-copy").textContent,
    /I should read the project instructions first\./
  );
  assert.equal(document.querySelectorAll(".reasoning-details, .activity-raw").length, 0);
});

test("later streamed sentences keep the process disclosure open and append cleanly into flat prose", () => {
  const { document, state, render } = fixture("preview-stream", "先核对文件路径。");
  expandHistory(document, render);
  for (const character of "接着检查文件权限与内容。") {
    state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta: character }));
    render();
    assert.equal(document.querySelector("details.process-segment").open, true);
  }
  assert.equal(
    document.querySelector(".reasoning-copy").textContent,
    "先核对文件路径。接着检查文件权限与内容。"
  );
});

test("empty thought blocks have a running indication without an empty or invented preview", () => {
  const { document, state, render } = fixture("preview-empty", " \n ");
  assert.equal(document.querySelectorAll("details.process-segment").length, 0);
  assert.match(document.querySelector(".reasoning-step").textContent, /思考中/);
  assert.equal(document.querySelectorAll(".thinking-spinner").length, 1);
  state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta: "真正的第一句。后续过程。" }));
  render();
  assert.match(document.querySelector(".process-segment.is-live > summary").textContent, /思考中/);
  state.detail.runtimeEvents.push(update("thinking_end", 0, { content: "真正的第一句。后续过程。" }));
  state.detail.runtime.active = false;
  state.detail.task.status = "waiting";
  render();
  assert.equal(document.querySelector(".process-segment-label")?.textContent, "真正的第一句。");
});

test("long or HTML-like thinking stays plain in the summary and complete in the expanded body", () => {
  const thought = `<img src=x onerror=alert(1)> ${"核对输入".repeat(30)}。后续说明。`;
  const { document, state, render } = fixture("preview-plain", thought);
  state.detail.runtimeEvents.push(update("thinking_end", 0, { content: thought }));
  state.detail.runtime.active = false;
  state.detail.task.status = "waiting";
  render();
  const label = document.querySelector(".process-segment-label");
  assert.equal(label.querySelector("img"), null);
  assert.equal(Array.from(label.textContent).length, 88);
  assert.equal(label.textContent.endsWith("…"), true);
  expandHistory(document, render);
  assert.equal(document.querySelector(".reasoning-copy").textContent, thought);
});

test("a recovered final snapshot derives its summary and keeps thought text out of the final answer", () => {
  const { document, state, render } = fixture("preview-history", "");
  const thought = "```js\nconst path = 'local.txt';\n```\n读取后继续检查。";
  const answer = {
    role: "assistant",
    timestamp: 2,
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: thought },
      { type: "text", text: "已经检查完成。" }
    ]
  };
  state.detail.runtimeEvents = [
    { type: "turn_start" },
    { type: "message_start", message: user },
    { type: "message_end", message: answer },
    { type: "turn_end", message: answer }
  ];
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  render([user, answer]);
  assert.equal(document.querySelector(".execution-history").open === true, false);
  assert.doesNotMatch(document.querySelector('[data-answer-kind="final"]').textContent, /const path|读取后/);
  expandDetails(document, ".execution-history", render, [user, answer]);
  assert.equal(document.querySelector(".process-segment-label")?.textContent, "const path = 'local.txt';");
  expandDetails(document, "details.process-segment", render, [user, answer]);
  assert.equal(document.querySelector(".reasoning-copy pre code").textContent, "const path = 'local.txt';");
  assert.match(document.querySelector(".reasoning-copy").textContent, /读取后继续检查。/);
  assert.equal(document.querySelectorAll(".reasoning-details, .activity-raw").length, 0);
  assert.equal(answer.content[0].thinking, thought);
});

test("an expanded live thought stays open through deltas and a user's collapse survives polling", () => {
  const { document, state, render } = fixture();
  expandHistory(document, render);
  state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta: "再核对第二部分。" }));
  render();
  assert.equal(document.querySelector("details.process-segment").open, true);
  assert.match(document.querySelector(".reasoning-copy").textContent, /先核对第一部分。再核对第二部分。/);
  document.querySelector("details.process-segment").open = false;
  render();
  assert.equal(document.querySelector("details.process-segment").open, false);
});

test("thought blocks render flat inline before and after a tool and preserve segment expansion on completion", () => {
  const { document, state, render } = fixture();
  expandHistory(document, render);
  state.detail.runtimeEvents.push(
    update("thinking_end", 0, { content: "先核对第一部分。" }),
    update("toolcall_end", 1, {
      toolCall: { id: "inspect", name: "read", arguments: { path: "fixture.txt" } }
    }),
    { type: "tool_execution_start", toolCallId: "inspect", toolName: "read" },
    { type: "tool_execution_end", toolCallId: "inspect", toolName: "read", result: "已读" },
    update("thinking_start", 2),
    update("thinking_delta", 2, { delta: "根据工具结果核对第二部分。" })
  );
  render();
  const copies = [...document.querySelectorAll(".reasoning-copy")];
  assert.equal(copies.length, 2);
  assert.match(copies[0].textContent, /先核对第一部分。/);
  assert.match(copies[1].textContent, /根据工具结果核对第二部分。/);
  assert.equal(document.querySelectorAll(".reasoning-details, .activity-raw").length, 0);
  assert.equal(document.querySelectorAll(".process-segment.is-live > summary .thinking-spinner").length, 1);
  const answer = {
    role: "assistant",
    timestamp: 2,
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "先核对第一部分。" },
      { type: "toolCall", id: "inspect", name: "read", arguments: { path: "fixture.txt" } },
      { type: "thinking", thinking: "根据工具结果核对第二部分。" },
      { type: "text", text: "核对完成。" }
    ]
  };
  state.detail.runtimeEvents.push(
    { type: "message_end", message: answer },
    { type: "turn_end", message: answer }
  );
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  render([user, answer]);
  // User had expanded the process while running; it stays open across completion.
  assert.equal(document.querySelector(".execution-history").open, true);
  assert.equal(document.querySelector("details.process-segment").open, true);
  assert.equal(document.querySelectorAll(".reasoning-copy").length, 2);
  assert.equal(document.querySelectorAll(".thinking-spinner").length, 0);
  assert.equal(document.querySelectorAll('[data-answer-kind="final"]').length, 1);
});

test("leaving a thought for an empty conversation preserves its expansion without leaking into another task", () => {
  const { document, state, render } = fixture();
  const first = state.detail;
  expandHistory(document, render);
  state.selected = "reasoning-two";
  state.detail = { ...first, task: { ...first.task, taskId: state.selected } };
  render([]);
  render();
  assert.equal(document.querySelector("details.process-segment").open === true, false);
  state.selected = "reasoning-one";
  state.detail = first;
  render();
  assert.equal(document.querySelector("details.process-segment").open, true);
});

test("thought reading positions and independent follow-up choices survive updates", () => {
  const { document, state, render } = fixture();
  expandHistory(document, render);
  const copy = document.querySelector(".reasoning-copy");
  copy.scrollTop = 37;
  copy.scrollLeft = 12;
  state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta: "继续核对。" }));
  render();
  assert.equal(document.querySelector(".reasoning-copy").scrollTop, 37);
  assert.equal(document.querySelector(".reasoning-copy").scrollLeft, 12);
  const answer = {
    role: "assistant",
    timestamp: 2,
    content: [
      { type: "thinking", thinking: "先核对第一部分。继续核对。" },
      { type: "text", text: "第一轮完成。" }
    ]
  };
  const followUp = { ...user, timestamp: 3 };
  state.detail.runtimeEvents.push(
    { type: "message_end", message: answer },
    { type: "turn_end", message: answer },
    { type: "turn_start" },
    { type: "message_start", message: followUp },
    { type: "message_start", message: { role: "assistant", timestamp: 4, content: [] } },
    update("thinking_delta", 0, { delta: "合成追问思考。" })
  );
  render([user, answer, followUp]);
  const blocks = [...document.querySelectorAll("details.process-segment")];
  assert.deepEqual(
    blocks.map((node) => node.open === true),
    [true, false]
  );
  assert.notEqual(blocks[0].dataset.activityKey, blocks[1].dataset.activityKey);
});

test("an interrupted thought retains its text without a spinner or a completed label", () => {
  const { document, state, render } = fixture();
  const stopped = {
    role: "assistant",
    timestamp: 2,
    stopReason: "aborted",
    content: [{ type: "thinking", thinking: "先核对第一部分。" }]
  };
  state.detail.runtimeEvents.push(
    { type: "message_end", message: stopped },
    { type: "turn_end", message: stopped }
  );
  state.detail.runtime.active = false;
  state.detail.task.status = "waiting";
  render([user, stopped]);
  expandHistory(document, render, [user, stopped]);
  assert.match(document.querySelector(".reasoning-step").textContent, /思考已停止/);
  assert.match(document.querySelector(".reasoning-copy").textContent, /先核对第一部分。/);
  assert.equal(document.querySelectorAll(".thinking-spinner").length, 0);
  assert.equal(document.querySelectorAll('[data-answer-kind="final"]').length, 0);
});

test("a final answer split into text blocks appears once after persistence catches up", () => {
  const { document, state, render } = fixture();
  const answer = {
    role: "assistant",
    timestamp: 2,
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "先核对第一部分。" },
      { type: "text", text: "核对" },
      { type: "text", text: "完成。" }
    ]
  };
  state.detail.runtimeEvents.push(
    { type: "message_end", message: answer },
    { type: "turn_end", message: answer }
  );
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  render([user]);
  assert.match(document.querySelector(".live-answer").textContent, /核对完成。/);
  assert.equal(document.querySelectorAll(".process-segment").length, 1);
  render([user, answer]);
  assert.equal(document.querySelectorAll(".execution-history").length, 1);
  assert.equal(document.querySelectorAll(".execution-history .live-workflow-head").length, 0);
  assert.equal(document.querySelectorAll(".live-answer").length, 0);
  assert.equal(document.querySelector('[data-answer-kind="final"]').textContent.includes("核对完成。"), true);
});

test("a finished round folds into a top 用时 summary without a bottom endline and expands L0 -> L1 -> L2", () => {
  const { document, state, render } = fixture("folded-round", "");
  const answer = {
    role: "assistant",
    timestamp: 5,
    stopReason: "stop",
    content: [{ type: "text", text: "做好了。" }]
  };
  state.detail.runtimeEvents = [
    { type: "turn_start", runId: "run-one" },
    { type: "message_start", message: user },
    { type: "message_start", message: { role: "assistant", timestamp: 2, content: [] } },
    ...[
      { id: "read", name: "read", arguments: { path: "summarize.sh" } },
      { id: "test", name: "bash", arguments: { command: "bash test/run.sh" } },
      { id: "apus", name: "call_subagent", arguments: { name: "Apus", task: "写测试" } },
      { id: "pavo", name: "call_subagent", arguments: { name: "Pavo", task: "检查参数" } }
    ].flatMap((toolCall, index) => [
      update("toolcall_end", index + 1, { toolCall }),
      { type: "tool_execution_end", toolCallId: toolCall.id, result: { content: [] } }
    ]),
    { type: "message_end", message: answer },
    { type: "turn_end", message: answer }
  ];
  state.detail.events = [
    { runId: "run-one", type: "main.run_spawned", occurredAt: "2026-11-18T10:00:00Z" },
    { runId: "run-one", type: "main.run_completed", occurredAt: "2026-11-18T10:03:12Z" }
  ];
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  render([user, answer]);
  const summary = document.querySelector(".execution-history > summary");
  assert.equal(summary.querySelector("strong").textContent, "用时 3 分钟 12 秒");
  const rows = [...document.querySelector("#conversation").children].map((node) => node.className);
  assert.deepEqual(rows.slice(-2), ["execution-history", "chat-message main"]);
  assert.equal(document.querySelector(".turn-endline"), null);
  assert.equal(document.querySelector(".execution-timeline"), null, "collapsed L0 omits inner DOM");
  assert.equal(document.querySelector(".subagent-group"), null, "collapsed L0 omits subagents");
  // Expand L0 -> L1 shows process summary + subagent group, but L2 tool rows stay unmounted.
  expandDetails(document, ".execution-history", render, [user, answer]);
  assert.equal(
    document.querySelector(".process-segment > summary .process-segment-label").textContent,
    "读取了 1 个文件 · 运行了 1 条命令"
  );
  assert.equal(document.querySelector(".process-segment .tool-step"), null);
  assert.match(document.querySelector(".subagent-group").textContent, /派出 2 个子助手/);
  // Expand L1 process segment -> L2 mounts individual tool rows.
  expandDetails(document, ".process-segment", render, [user, answer]);
  assert.equal(document.querySelectorAll(".process-segment .tool-step").length, 2);
});

test("tool progress, empty completion and interruption render their actual lifecycle", () => {
  const { document, state, render } = fixture();
  expandHistory(document, render);
  state.detail.runtimeEvents.push(
    update("toolcall_end", 1, {
      toolCall: { id: "inspect", name: "read", arguments: { path: "fixture.txt" } }
    }),
    { type: "tool_execution_start", toolCallId: "inspect", toolName: "read" },
    { type: "tool_execution_update", toolCallId: "inspect", partialResult: "读取了第一段。" }
  );
  render();
  assert.equal(document.querySelector(".tool-step").classList.contains("is-running"), true);
  assert.equal(document.querySelector(".activity-status").textContent, "执行中");
  state.detail.runtimeEvents.push({ type: "tool_execution_end", toolCallId: "inspect", result: "" });
  render();
  assert.equal(document.querySelector(".tool-step").classList.contains("is-done"), true);
  state.detail.runtimeEvents.push({ type: "tool_execution_start", toolCallId: "second", toolName: "bash" });
  state.detail.runtime.active = false;
  state.detail.task.status = "waiting";
  render();
  assert.equal(document.querySelectorAll(".tool-step.is-running").length, 0);
  assert.equal(document.querySelectorAll(".activity-status")[1].textContent, "已停止");
});

test("the final response folds mid-round speech and process segments inside L0 and reveals them in L1", () => {
  const { document, state, render } = fixture();
  const updateMessage = {
    role: "assistant",
    timestamp: 2,
    stopReason: "toolUse",
    content: [
      { type: "thinking", thinking: "先核对第一部分。" },
      { type: "text", text: "已经核对完成。" }
    ]
  };
  const answer = { ...updateMessage, timestamp: 3, stopReason: "stop" };
  state.detail.runtimeEvents.push(
    { type: "message_end", message: updateMessage },
    { type: "message_start", message: { ...answer, content: [] } },
    { type: "message_end", message: answer },
    { type: "turn_end", message: answer }
  );
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  render([user, updateMessage, answer]);
  // L0 collapsed: mid-round speech and process segments are folded inside .execution-history.
  assert.equal(document.querySelectorAll(".execution-history").length, 1);
  assert.equal(document.querySelectorAll(".live-answer").length, 0);
  assert.equal(document.querySelectorAll('[data-answer-kind="final"]').length, 1);
  // L0 expanded -> L1 shows process segment, mid-round speech, and next process segment.
  expandDetails(document, ".execution-history", render, [user, updateMessage, answer]);
  assert.equal(document.querySelectorAll(".execution-timeline > .process-segment").length, 2);
  assert.equal(document.querySelectorAll(".execution-timeline > .live-answer").length, 1);
  assert.equal(document.querySelector(".live-answer").textContent, "已经核对完成。");
});

test("saved plain text from a stopped request remains visible without runtime logs", () => {
  const { document, state, render } = fixture();
  state.detail.runtimeEvents = [];
  state.detail.runtime.active = false;
  state.detail.task.status = "waiting";
  render([user, { role: "assistant", content: "还有一部分需要核对。", stopReason: "aborted", timestamp: 2 }]);
  assert.match(document.querySelector("#conversation").textContent, /还有一部分需要核对。/);
});

test("upload filenames and thumbnails render without exposing prompt metadata or executing filename markup", () => {
  const { document, state, render } = fixture("uploaded-files", "");
  const id = "upload-00000000-0000-0000-0000-000000000000";
  const source =
    "用户原话" +
    "\n\n<atria_uploaded_files>\n" +
    JSON.stringify({
      version: 1,
      files: [
        {
          uploadId: id,
          name: "<img src=x onerror=alert(1)>.png",
          kind: "image",
          path: "/private/inputs/original.png"
        }
      ]
    }) +
    "\n</atria_uploaded_files>";
  state.detail.runtimeEvents = [];
  render([{ role: "user", content: source, timestamp: 1 }]);
  const attachments = document.querySelector(".message-attachments");
  assert.ok(attachments);
  assert.equal(attachments.querySelectorAll("img").length, 1);
  const image = attachments.querySelector("img");
  assert.equal(image.getAttribute("data-upload-src"), id);
  assert.equal(image.getAttribute("src"), null);
  assert.equal(attachments.querySelector("[data-upload-preview]").getAttribute("data-upload-preview"), id);
  assert.equal(
    attachments.querySelector("[data-upload-preview]").textContent,
    "<img src=x onerror=alert(1)>.png"
  );
  assert.doesNotMatch(
    document.querySelector("#conversation").textContent,
    /atria_uploaded_files|private\/inputs/
  );
});

test("an async delegation row follows real progress without changing its disclosure identity", () => {
  const { document, state, render } = fixture("async-status", "");
  state.detail.runtimeEvents.push(
    update("toolcall_end", 1, {
      toolCall: { id: "dispatch", name: "call_subagent", arguments: { task: "核对机构" } }
    }),
    {
      type: "tool_execution_end",
      toolCallId: "dispatch",
      result: { details: { accepted: true, callId: "call-one", name: "Ara" } }
    }
  );
  state.detail.coordination = { calls: [{ callId: "call-one", status: "running" }], pending: ["call-one"] };
  state.detail.progress = {
    agents: [{ callId: "call-one", status: "running", role: "reviewer", elapsedMs: 36_000 }]
  };
  render();
  // Scheme A: running Subagents stay directly visible in L1 without expanding a process fold.
  let row = document.querySelector(".subagent-step");
  row.open = true;
  assert.equal(row.querySelector("strong").textContent, "Ara");
  assert.equal(row.querySelector(".subagent-role-tag").textContent, "审查");
  assert.equal(row.querySelector(".subagent-status").textContent, "运行中 36 秒");
  assert.equal(row.querySelectorAll(".ant-mark").length, 0);
  assert.equal(row.querySelectorAll(".tool-status-dot").length, 1);
  // Main's own turn ends while Ara works; Ara's row keeps its running state without logo animation.
  state.detail.runtime.active = false;
  render();
  row = document.querySelector(".subagent-step");
  assert.equal(row.open, true);
  assert.equal(row.classList.contains("is-running"), true);
  assert.equal(row.querySelectorAll(".ant-mark").length, 0);
  assert.equal(document.querySelectorAll(".live-workflow-head").length, 0);
  state.detail.progress.agents[0] = {
    ...state.detail.progress.agents[0],
    status: "succeeded",
    elapsedMs: 84_000,
    callbackPending: true,
    lastAssistantText: "机构名称全部核对无误。另附两处拼写建议。"
  };
  render();
  assert.equal(row.querySelector(".subagent-status").textContent, "完成 1 分钟 24 秒");
  // Once done the row says what came back instead of what was asked.
  assert.equal(row.querySelector(".tool-subject").textContent, "机构名称全部核对无误。");
  assert.equal(row.querySelectorAll(".tool-step .ant-mark").length, 0);
  state.detail.progress.agents[0].callbackPending = false;
  state.detail.coordination = { calls: [{ callId: "call-one", status: "completed" }] };
  render();
  assert.equal(document.querySelector(".subagent-step"), row);
  assert.equal(row.open, true);
  assert.equal(row.querySelector(".subagent-status").textContent, "完成 1 分钟 24 秒");
});

test("an ended question and queued message use action-specific labels", () => {
  const { document, state, render } = fixture("action-status", "");
  for (const [index, name, data] of [
    [1, "askhuman", { status: "timeout" }],
    [2, "send_subagent_message", { status: "queued", messageId: "message" }]
  ])
    state.detail.runtimeEvents.push(
      update("toolcall_end", index, {
        toolCall: { id: name, name, arguments: { question: "怎么展示？", message: "检查行程" } }
      }),
      { type: "tool_execution_end", toolCallId: name, result: { details: data } }
    );
  render();
  expandHistory(document, render);
  assert.deepEqual(
    [...document.querySelectorAll(".activity-status")].map((node) => node.textContent),
    ["未答复，已继续", "已入队"]
  );
  assert.doesNotMatch(document.querySelector(".workflow-rail").textContent, /已完成|等待你的答复/);
});

test("retry status is visible even before content arrives and clears after recovery", () => {
  const { document, state, render } = fixture("retry-visible", "");
  state.detail.runtimeEvents = [
    { type: "message_start", message: user },
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "524 status code (no body)" }
  ];
  render();
  assert.match(document.querySelector('[role="status"]').textContent, /HTTP 524.*正在重试/);
  assert.equal(document.querySelectorAll('[role="status"]').length, 1);
  assert.match(document.querySelector('[role="status"]').textContent, /1 \/ 3/);
  state.detail.runtimeEvents.push({
    type: "auto_retry_start",
    attempt: 2,
    maxAttempts: 3,
    errorMessage: "524 status code (no body)"
  });
  render();
  assert.match(document.querySelector('[role="status"]').textContent, /2 \/ 3/);
  state.detail.runtimeEvents.push({ type: "auto_retry_end", success: true });
  render();
  assert.equal(document.querySelector(".request-retry"), null);
});

test("only a user stop displays the stopped row when replaying a round", () => {
  for (const reason of ["idle", "paused", "ui_stop"]) {
    const { document, state, render } = fixture();
    state.detail.runtime.active = false;
    state.detail.task.status = "waiting";
    state.detail.runtimeEvents.push({ type: "main.run_stopped", payload: { reason } });
    render();
    assert.equal(document.querySelector(".turn-stopped") !== null, reason === "ui_stop", reason);
  }
});

test("cancelled earlier requests stay incomplete after a later request succeeds", () => {
  const { document, state, render } = fixture("cancel-history", "正在执行");
  const partial = { role: "assistant", content: "接下来将创建文稿。", stopReason: "toolUse", timestamp: 2 };
  const followup = { role: "user", content: "先创建空白文稿", timestamp: 3 };
  const answer = { role: "assistant", content: "已创建", stopReason: "stop", timestamp: 4 };
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  state.detail.runtimeEvents.push(
    { type: "message_end", message: partial },
    { type: "main.run_cancelled", runId: "first", payload: { reason: "ui_cancel" } },
    { type: "message_start", message: followup },
    { type: "message_end", message: answer },
    { type: "turn_end", message: answer },
    { type: "main.run_completed", runId: "second" }
  );
  render([user, partial, followup, answer]);
  assert.match(document.querySelector(".turn-stopped").textContent, /已停止/);
  assert.equal(document.querySelector(".turn-stopped").closest(".execution-history"), null);
  assert.equal(document.querySelectorAll(".turn-stopped").length, 1);
  assert.match(document.querySelector('[data-answer-kind="final"]').textContent, /已创建/);
});

test("latest accepted user has an accessible edit button in completed and failed states, owned by its rendered task", () => {
  const edited = [];
  const { document, state, render } = fixture("edit-task", "", { edit: (...args) => edited.push(args) });
  const messages = [
    { ...user, id: "old-user" },
    { role: "assistant", content: "old answer", timestamp: 2 },
    { ...user, id: "latest-user", content: "latest request", timestamp: 3 }
  ];
  state.detail.runtimeEvents = [];
  state.detail.runtime.active = false;
  state.detail.editableMessage = {
    messageId: "latest-user",
    versionId: "version",
    runId: "run",
    body: "latest request",
    attachments: []
  };
  for (const status of ["completed", "failed"]) {
    state.detail.task.status = status;
    render(messages);
    const buttons = document.querySelectorAll("[data-edit-message]");
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].getAttribute("type"), "button");
    assert.equal(buttons[0].getAttribute("aria-label"), "编辑消息");
    buttons[0].click();
  }
  assert.equal(edited.length, 2);
  state.selected = "other-task";
  document.querySelector("[data-edit-message]").click();
  assert.equal(edited.length, 2);
});

test("a restored inline draft stays reachable when another branch replaces its original message", () => {
  const editingMessageId = "saved-user";
  const { document, state, render } = fixture("restored-edit", "", {
    messageEdit: {
      editingMessageId,
      markup: (_taskId, messageId) =>
        messageId === editingMessageId ? "<textarea data-inline-message-edit>保留的编辑草稿</textarea>" : "",
      bind() {}
    }
  });
  state.detail.runtime.active = false;
  state.detail.runtimeEvents = [];
  render([{ ...user, id: "new-branch-user", content: "另一窗口提交的消息" }]);
  assert.equal(document.querySelectorAll("[data-inline-message-edit]").length, 1);
  assert.match(document.querySelector(".is-editing").textContent, /保留的编辑草稿/);
  render([{ ...user, id: editingMessageId }]);
  assert.equal(document.querySelectorAll("[data-inline-message-edit]").length, 1);
  assert.equal(document.querySelectorAll(".chat-message.user").length, 1);
  render([]);
  assert.equal(document.querySelectorAll("[data-inline-message-edit]").length, 1);
});

test("cached earlier replies refresh after edits, disclosure changes and external lifecycle changes", () => {
  const { document, state, render } = fixture("cached-history", "");
  const first = { ...user, id: "first" };
  const answer = { role: "assistant", timestamp: 2, content: "original **answer**" };
  const next = { role: "user", id: "next", timestamp: 3, content: "next request" };
  state.detail.runtimeEvents = [
    { type: "message_start", message: first },
    { type: "message_start", message: answer },
    { type: "message_end", message: answer },
    { type: "main.run_completed" },
    { type: "message_start", message: next }
  ];
  const messages = [first, answer, next];
  render(messages);
  render(messages);
  const reply = document.querySelector('.chat-message[data-answer-kind="final"]');
  assert.match(reply.textContent, /original answer/);
  state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta: "live delta" }));
  render(messages);
  assert.equal(document.querySelector('.chat-message[data-answer-kind="final"]'), reply);
  answer.content = "revised answer";
  state.detail.conversationVersion = 2;
  render(messages);
  assert.match(
    document.querySelector('.chat-message[data-answer-kind="final"]').textContent,
    /revised answer/
  );
  assert.doesNotMatch(document.querySelector("#conversation").textContent, /original answer/);
  state.detail.editableMessage = { messageId: "first" };
  render(messages);
  assert.ok(document.querySelector("[data-edit-message]"));
  state.selected = "other";
  state.detail.task = { taskId: "other", status: "running" };
  state.detail.runtimeEvents = [];
  render([{ role: "user", content: "other request", timestamp: 10 }]);
  assert.doesNotMatch(document.querySelector("#conversation").textContent, /revised answer/);
});

test("a running Subagent's time counts from when it was handed out, not from the last snapshot", () => {
  const { document, state, render } = fixture("live-subagent-clock");
  const startedAt = new Date(Date.now() - 65_000).toISOString();
  state.detail.progress = {
    agents: [{ callId: "call-vela", name: "Vela", status: "running", elapsedMs: 3_000, startedAt }]
  };
  state.detail.runtimeEvents.push(
    update("toolcall_end", 1, {
      toolCall: {
        id: "vela",
        name: "call_subagent",
        arguments: { name: "Vela", task: "跑一分钟" }
      }
    }),
    {
      type: "tool_execution_end",
      toolCallId: "vela",
      result: { content: [], details: { callId: "call-vela", accepted: true } }
    }
  );
  render();
  // Scheme A: running Subagent row and live clock are directly visible in L1.
  const status = document.querySelector(".subagent-step .subagent-status");
  assert.equal(status.dataset.liveSince, String(Date.parse(startedAt)));
  assert.match(status.textContent, /运行中 1 分钟 [5-9] 秒/);
  // Once it finishes nothing counts any more, and the page's clock stops itself.
  state.detail.progress.agents[0].status = "succeeded";
  state.detail.runtime.active = false;
  render();
  assert.equal(document.querySelector("[data-live-since]"), null);
});

test("running process stays collapsed with coarse live action, expands L1 -> L2 -> L3, and breaks onto new lines for mid-round speech", () => {
  const { document, state, render } = fixture("codex-streaming", "先检查目录结构。");
  // Collapsed while thinking: coarse live state "思考中", no inner DOM.
  let segment = document.querySelector(".process-segment.is-live");
  assert.ok(segment);
  assert.equal(segment.open === true, false);
  assert.equal(segment.querySelector(".live-workflow"), null);
  assert.equal(segment.querySelector("summary .process-live-state").textContent, "思考中");

  // Tool starts: summary updates in place to the coarse tool category ("读取文件中").
  state.detail.runtimeEvents.push(
    update("thinking_end", 0, { content: "先检查目录结构。" }),
    update("toolcall_end", 1, { toolCall: { id: "r1", name: "read", arguments: { path: "web/app.js" } } }),
    { type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "web/app.js" } }
  );
  render();
  assert.equal(document.querySelector(".process-segment.is-live"), segment);
  assert.equal(segment.querySelector(".live-workflow"), null);
  assert.equal(segment.querySelector("summary .process-live-state").textContent, "读取文件中");
  assert.equal(segment.querySelector("summary small").textContent, "1 项操作");

  // Tool finishes and agent speaks mid-round: speech breaks onto a new line,
  // earlier process settles to category counts, and subsequent work starts a fresh collapsed row.
  state.detail.runtimeEvents.push(
    { type: "tool_execution_end", toolCallId: "r1", toolName: "read", result: { content: [] } },
    update("text_delta", 2, { delta: "我已经看完入口文件，接下来修改渲染逻辑。" }),
    update("text_end", 2, { content: "我已经看完入口文件，接下来修改渲染逻辑。" }),
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant", timestamp: 3, content: [] } },
    update("toolcall_end", 0, {
      toolCall: { id: "e1", name: "edit", arguments: { path: "web/assets/controllers/conversation-view.js" } }
    }),
    {
      type: "tool_execution_start",
      toolCallId: "e1",
      toolName: "edit",
      args: { path: "web/assets/controllers/conversation-view.js" }
    }
  );
  render();
  const blocks = [...document.querySelector('[data-answer-kind="pending"] .message-copy').children];
  assert.deepEqual(
    blocks.map((node) =>
      node.classList.contains("process-segment")
        ? node.classList.contains("is-live")
          ? "live-process"
          : "settled-process"
        : node.classList.contains("live-answer")
          ? "speech"
          : node.className
    ),
    ["settled-process", "speech", "live-process"]
  );
  assert.equal(blocks[0].querySelector("summary .process-segment-label").textContent, "读取了 1 个文件");
  assert.equal(blocks[1].textContent.trim(), "我已经看完入口文件，接下来修改渲染逻辑。");
  assert.equal(blocks[2].querySelector("summary .process-live-state").textContent, "编辑文件中");
  assert.equal(blocks[0].querySelector(".live-workflow"), null);
  assert.equal(blocks[2].querySelector(".live-workflow"), null);

  // Clicking/toggling the second process row mounts L2 steps on demand; toggling L2 tool mounts L3 details.
  blocks[2].open = true;
  blocks[2].dispatchEvent(new document.defaultView.Event("toggle"));
  const tool = blocks[2].querySelector(".live-workflow .tool-details");
  assert.ok(tool);
  assert.equal(tool.querySelector(".tool-details-body"), null);
  tool.open = true;
  tool.dispatchEvent(new document.defaultView.Event("toggle"));
  assert.ok(blocks[2].querySelector(".tool-details-body"));
  blocks[2].open = false;
  blocks[2].dispatchEvent(new document.defaultView.Event("toggle"));
  assert.equal(blocks[2].querySelector(".live-workflow"), null);
});

test("a person's message keeps its own lines instead of being read as Markdown", () => {
  const { document, state, render } = fixture("typed-user-text", "");
  state.detail.runtimeEvents = [];
  const typed =
    '验收标准：\n  1. 组合写法 "1h30m"\n  等于 5400000。\n  2. 支持小数 **1.5h**\n<b>原样</b>\n\n';
  render([{ role: "user", content: typed, timestamp: 1 }]);
  const shown = document.querySelector(".chat-message.user .user-text");
  assert.ok(shown);
  assert.equal(shown.textContent, typed.trimEnd());
  assert.equal(
    document.querySelector(".chat-message.user ol, .chat-message.user strong, .chat-message.user b"),
    null
  );
});

test("parking hides the pending thought until the next turn starts", () => {
  const { state, document, render } = fixture("parked");
  state.detail.parked = { wakeAt: "2026-11-23T03:06:21Z" };
  state.detail.runtimeEvents = [
    { type: "tool_execution_start", toolCallId: "sleep", toolName: "sleep_until" },
    {
      type: "tool_execution_end",
      toolCallId: "sleep",
      toolName: "sleep_until",
      result: { details: { parked: true } }
    }
  ];
  render();
  assert.doesNotMatch(document.querySelector("#conversation").textContent, /思考中/);
  expandDetails(document, ".process-segment", render);
  assert.match(document.querySelector("#conversation").textContent, /等待新的进展/);
  assert.doesNotMatch(document.querySelector("#conversation").textContent, /思考中/);
  delete state.detail.parked;
  state.detail.runtimeEvents.push({ type: "turn_start" });
  render();
  assert.match(document.querySelector("#conversation").textContent, /思考中/);
});

test("long conversations virtualize off-screen historical rounds into height-preserving shells", () => {
  const { document, state, render } = fixture("long-virtual", "");
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  state.detail.runtimeEvents = [];
  const rounds = 36;
  const messages = [];
  for (let index = 0; index < rounds; index += 1) {
    messages.push(
      { role: "user", id: `u-${index}`, content: `第 ${index + 1} 轮问题`, timestamp: 1000 + index * 20 },
      {
        role: "assistant",
        id: `a-${index}`,
        content: `## 第 ${index + 1} 轮回答\n\n\`\`\`ts\nexport const v = ${index};\n\`\`\``,
        timestamp: 1010 + index * 20,
        stopReason: "stop"
      }
    );
  }
  render(messages);
  const finals = document.querySelectorAll('.chat-message.main[data-answer-kind="final"]');
  assert.equal(finals.length, rounds, "every round keeps its final article marker");
  const virtualFinals = document.querySelectorAll(
    '.chat-message.main.is-virtual-shell[data-answer-kind="final"]'
  );
  assert.equal(
    virtualFinals.length,
    rounds - 12,
    "rounds outside the recent window render as lightweight shells"
  );
  assert.equal(finals[0].querySelector(".markdown-body"), null, "virtual shell omits heavy Markdown DOM");
  assert.match(finals[0].getAttribute("style") || "", /min-height:\d+px/);
  assert.ok(finals[rounds - 1].querySelector(".markdown-body"), "recent rounds render full Markdown DOM");
});

test("expanding L3 loads omitted tool details on demand, retries errors and discards stale responses on task switch", async () => {
  const requests = [];
  const state = {
    selected: "task-a",
    localMessages: [],
    executionHistoryOpen: new Map(),
    detail: {
      task: { taskId: "task-a", status: "completed" },
      runtime: { active: false },
      runtimeEvents: [
        { type: "runtime_event", runId: "run-a", payload: { type: "turn_start" } },
        {
          type: "runtime_event",
          runId: "run-a",
          payload: {
            type: "tool_execution_start",
            toolCallId: "big-call",
            toolName: "read",
            args: { path: "notes.md" },
            detailOmitted: true
          }
        },
        {
          type: "runtime_event",
          runId: "run-a",
          payload: {
            type: "tool_execution_end",
            toolCallId: "big-call",
            toolName: "read",
            isError: false,
            result: {},
            detailOmitted: true
          }
        },
        {
          type: "runtime_event",
          runId: "run-a",
          payload: {
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "完成" }], stopReason: "stop" }
          }
        },
        { type: "runtime_event", runId: "run-a", payload: { type: "turn_end" } }
      ]
    }
  };
  const { document } = parseHTML('<main id="conversation"></main>');
  const view = createConversationView({
    state,
    $: (selector) => document.querySelector(selector),
    textContent,
    loadToolDetail: (taskId, callId, runId) => {
      const deferred = Promise.withResolvers();
      requests.push({ taskId, callId, runId, ...deferred });
      return deferred.promise;
    }
  });
  const messages = [
    { role: "user", id: "u1", content: "看文件", timestamp: 1 },
    { role: "assistant", id: "a1", content: "完成", timestamp: 2, stopReason: "stop" }
  ];
  view.renderConversation(messages, state.detail.task);
  assert.equal(requests.length, 0, "collapsed L0/L1/L2 triggers no detail fetch");

  expandHistory(document, (m) => view.renderConversation(m, state.detail.task), messages);
  assert.equal(requests.length, 0, "collapsed L3 still triggers no detail fetch");

  const tool = document.querySelector(".tool-details");
  tool.open = true;
  tool.dispatchEvent(new document.defaultView.Event("toggle"));
  assert.equal(requests.length, 1);
  assert.deepEqual(
    { taskId: requests[0].taskId, callId: requests[0].callId, runId: requests[0].runId },
    { taskId: "task-a", callId: "big-call", runId: "run-a" }
  );
  assert.match(document.querySelector(".tool-details-body").textContent, /正在加载详情/);

  // Failure renders retry control; clicking retry re-requests.
  requests[0].reject(new Error("boom"));
  await Promise.resolve();
  await Promise.resolve();
  const retryButton = document.querySelector("[data-tool-detail-retry]");
  assert.ok(retryButton, "failed fetch exposes retry control");
  retryButton.click();
  assert.equal(requests.length, 2);

  // Switching to another conversation invalidates the in-flight response.
  state.selected = "task-b";
  state.detail = {
    task: { taskId: "task-b", status: "completed" },
    runtime: { active: false },
    runtimeEvents: []
  };
  view.renderConversation([], state.detail.task);
  requests[1].resolve({
    arguments: { path: "notes.md", offset: 1 },
    result: { content: [{ type: "text", text: "FULL_SECRET_BODY" }] }
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.doesNotMatch(document.querySelector("#conversation").textContent, /FULL_SECRET_BODY/);

  // Returning to task-a fetches cleanly (cache was cleared on switch) and renders full body.
  state.selected = "task-a";
  state.detail = {
    task: { taskId: "task-a", status: "completed" },
    runtime: { active: false },
    runtimeEvents: [
      { type: "runtime_event", runId: "run-a", payload: { type: "turn_start" } },
      {
        type: "runtime_event",
        runId: "run-a",
        payload: {
          type: "tool_execution_start",
          toolCallId: "big-call",
          toolName: "read",
          args: { path: "notes.md" },
          detailOmitted: true
        }
      },
      {
        type: "runtime_event",
        runId: "run-a",
        payload: {
          type: "tool_execution_end",
          toolCallId: "big-call",
          toolName: "read",
          isError: false,
          result: {},
          detailOmitted: true
        }
      },
      {
        type: "runtime_event",
        runId: "run-a",
        payload: {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "完成" }], stopReason: "stop" }
        }
      },
      { type: "runtime_event", runId: "run-a", payload: { type: "turn_end" } }
    ]
  };
  view.renderConversation(messages, state.detail.task);
  assert.equal(requests.length, 3, "reopening task-a re-fetches after cache release");
  requests[2].resolve({
    arguments: { path: "notes.md", offset: 1 },
    result: { content: [{ type: "text", text: "FULL_TOOL_OUTPUT_LINE" }] }
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.match(document.querySelector(".tool-details-body").textContent, /FULL_TOOL_OUTPUT_LINE/);
});

test("streaming text_delta fast path keeps frame-by-frame equivalence when split <think> tags arrive", () => {
  const makeView = () => {
    const { document } = parseHTML('<!doctype html><html><body><div id="conversation"></div></body></html>');
    const state = {
      selected: "task-think-split",
      localMessages: [],
      executionHistoryOpen: new Map(),
      detail: {
        task: { taskId: "task-think-split", status: "running", activeRunId: "run-1" },
        conversationVersion: 1,
        runtime: { active: true },
        runtimeEvents: [
          { type: "runtime_event", runId: "run-1", payload: { type: "turn_start" } },
          {
            type: "runtime_event",
            runId: "run-1",
            payload: {
              type: "message_start",
              message: { role: "user", content: "测试拆分标签", timestamp: 1 }
            }
          },
          {
            type: "runtime_event",
            runId: "run-1",
            payload: { type: "message_end", message: { role: "user", content: "测试拆分标签", timestamp: 1 } }
          },
          {
            type: "runtime_event",
            runId: "run-1",
            payload: { type: "message_start", message: { role: "assistant", timestamp: 2, content: [] } }
          },
          {
            type: "runtime_event",
            runId: "run-1",
            payload: update("text_delta", 0, { delta: "已有正文。" })
          }
        ]
      }
    };
    const messages = [{ role: "user", content: "测试拆分标签", timestamp: 1 }];
    const view = createConversationView({
      state,
      $: (selector) => document.querySelector(selector),
      textContent
    });
    return { document, state, messages, view };
  };

  const fast = makeView();
  const full = makeView();

  // Initial full render mounts [data-streaming-answer].
  fast.view.renderConversation(fast.messages, fast.state.detail.task);
  full.view.renderConversation(full.messages, full.state.detail.task);
  assert.equal(
    fast.document.querySelector("#conversation").innerHTML,
    full.document.querySelector("#conversation").innerHTML
  );

  const chunks = ["继续补充。", "\n\n<th", "ink>内部思考内容", "</think>\n\n后续正文。"];
  const fastHits = [];
  for (const delta of chunks) {
    const recFast = {
      type: "runtime_event",
      runId: "run-1",
      payload: update("text_delta", 0, { delta })
    };
    const recFull = {
      type: "runtime_event",
      runId: "run-1",
      payload: update("text_delta", 0, { delta })
    };
    fast.state.detail.runtimeEvents.push(recFast);
    full.state.detail.runtimeEvents.push(recFull);
    const hit = Boolean(
      fast.view.renderConversation(fast.messages, fast.state.detail.task, { streamRecords: [recFast] })
    );
    fastHits.push(hit);
    full.view.renderConversation(full.messages, full.state.detail.task);
    assert.equal(
      fast.document.querySelector("#conversation").innerHTML,
      full.document.querySelector("#conversation").innerHTML,
      `frame mismatch after delta ${JSON.stringify(delta)}`
    );
    assert.doesNotMatch(
      fast.document.querySelector("#conversation").textContent,
      /<th/,
      `raw tag leaked after delta ${JSON.stringify(delta)}`
    );
  }
  assert.equal(fastHits[0], true, "plain text_delta uses fast path");
  assert.equal(fastHits[1], false, "split <th envelope forces fallback to full render");
  assert.equal(fastHits[3], false, "closing </think> changes structure and falls back cleanly");
  assert.ok(fast.document.querySelector(".process-segment"), "reasoning area is rendered");
});

test("streaming text_delta fast path binds newly completed artifact links before text_end and preserves scroll", () => {
  const { document } = parseHTML('<!doctype html><html><body><div id="conversation"></div></body></html>');
  const scroll = document.querySelector("#conversation");
  Object.defineProperty(scroll, "clientHeight", { value: 400, configurable: true });
  Object.defineProperty(scroll, "scrollHeight", { value: 1000, configurable: true });
  scroll.scrollTop = 600; // at end initially

  const opened = [];
  const state = {
    selected: "task-art",
    localMessages: [],
    executionHistoryOpen: new Map(),
    detail: {
      task: { taskId: "task-art", status: "running", activeRunId: "run-art" },
      conversationVersion: 1,
      workspaceRoot: "/workspace",
      artifacts: [{ taskId: "task-art", relativePath: "report.md" }],
      runtime: { active: true },
      runtimeEvents: [
        { type: "runtime_event", runId: "run-art", payload: { type: "turn_start" } },
        {
          type: "runtime_event",
          runId: "run-art",
          payload: { type: "message_start", message: { role: "user", content: "生成报告", timestamp: 1 } }
        },
        {
          type: "runtime_event",
          runId: "run-art",
          payload: { type: "message_end", message: { role: "user", content: "生成报告", timestamp: 1 } }
        },
        {
          type: "runtime_event",
          runId: "run-art",
          payload: { type: "message_start", message: { role: "assistant", timestamp: 2, content: [] } }
        },
        {
          type: "runtime_event",
          runId: "run-art",
          payload: update("text_delta", 0, { delta: "查看 " })
        }
      ]
    }
  };
  const messages = [{ role: "user", content: "生成报告", timestamp: 1 }];
  const view = createConversationView({
    state,
    $: (selector) => document.querySelector(selector),
    textContent,
    openArtifact: (path) => opened.push(path)
  });

  view.renderConversation(messages, state.detail.task);
  const answerEl = document.querySelector("[data-streaming-answer]");
  assert.ok(answerEl);

  // User scrolls up while reply is streaming; fast path must not pull scrollTop back down.
  scroll.scrollTop = 100;
  const linkDelta = {
    type: "runtime_event",
    runId: "run-art",
    payload: update("text_delta", 0, { delta: "[报告](/workspace/task-art/artifacts/report.md)" })
  };
  state.detail.runtimeEvents.push(linkDelta);
  const updatedBody = view.renderConversation(messages, state.detail.task, { streamRecords: [linkDelta] });
  assert.ok(updatedBody, "expected fast path update");
  assert.equal(document.querySelector("[data-streaming-answer]"), answerEl, "answer node reused in place");
  assert.equal(scroll.scrollTop, 100, "reader scrolled up stays put");

  // Click the artifact link BEFORE text_end arrives.
  const link = document.querySelector('[data-message-artifact="report.md"]');
  assert.ok(link, "artifact link rendered during stream");
  link.click();
  assert.deepEqual(opened, ["report.md"], "clicking streamed artifact link opens preview before text_end");

  // Subsequent full render on text_end reconciles cleanly.
  const endRecord = {
    type: "runtime_event",
    runId: "run-art",
    payload: update("text_end", 0, { content: "查看 [报告](/workspace/task-art/artifacts/report.md)" })
  };
  state.detail.runtimeEvents.push(endRecord);
  view.renderConversation(messages, state.detail.task);
  assert.match(document.querySelector(".live-answer").textContent, /查看 报告/);
});

test("multi-input settled round does not skip structural fingerprint when lifecycleEvents reference is unchanged", () => {
  const { document, state, render } = fixture("multi-input-cache", "先分析。");
  state.detail.events = [];
  state.detail.runtimeEvents.push(update("thinking_end", 0, { content: "先分析。" }));
  const steer = {
    role: "user",
    id: "steer-cache",
    content: "补充一下",
    timestamp: 3,
    delivery: "steer",
    interjected: true
  };
  const deliver = {
    role: "custom",
    customType: "cowork-user-message",
    content: "用户在你工作期间补充了一句话：补充一下",
    timestamp: 3,
    details: { message: "补充一下", delivery: "steer", _coworkInbox: { messageId: "steer-cache" } }
  };
  const final1 = {
    role: "assistant",
    id: "ans-1",
    timestamp: 5,
    stopReason: "stop",
    content: [{ type: "text", text: "第一版答案。" }]
  };
  const nextUser = { role: "user", id: "u-2", content: "下一轮问题", timestamp: 10 };
  const baseEvents = [
    ...state.detail.runtimeEvents,
    { type: "message_start", message: deliver },
    { type: "message_end", message: deliver },
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant", timestamp: 5, content: [] } }
  ];
  state.detail.runtimeEvents = [
    ...baseEvents,
    { type: "message_end", message: final1 },
    { type: "turn_end", message: final1 }
  ];
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  render([user, steer, final1, nextUser]);
  assert.match(document.querySelector("#conversation").textContent, /第一版答案/);

  // Replace the settled multi-input round's final answer while keeping the exact same lifecycleEvents array ref.
  const final2 = { ...final1, content: [{ type: "text", text: "第二版答案。" }] };
  state.detail.runtimeEvents = [
    ...baseEvents,
    { type: "message_end", message: final2 },
    { type: "turn_end", message: final2 }
  ];
  render([user, steer, final2, nextUser]);
  assert.match(document.querySelector("#conversation").textContent, /第二版答案/);
  assert.doesNotMatch(document.querySelector("#conversation").textContent, /第一版答案/);
});

test("fast path does not establish when a newer unmatched user turn in the same run owns the global event tail", () => {
  const makeView = () => {
    const { document } = parseHTML('<!doctype html><html><body><div id="conversation"></div></body></html>');
    const state = {
      selected: "task-unmatched-turn",
      localMessages: [],
      executionHistoryOpen: new Map(),
      detail: {
        task: { taskId: "task-unmatched-turn", status: "running", activeRunId: "run-1" },
        conversationVersion: 1,
        runtime: { active: true },
        runtimeEvents: [
          { type: "runtime_event", runId: "run-1", payload: { type: "turn_start" } },
          {
            type: "runtime_event",
            runId: "run-1",
            payload: { type: "message_start", message: { role: "user", content: "第一问", timestamp: 1 } }
          },
          {
            type: "runtime_event",
            runId: "run-1",
            payload: { type: "message_end", message: { role: "user", content: "第一问", timestamp: 1 } }
          },
          {
            type: "runtime_event",
            runId: "run-1",
            payload: { type: "message_start", message: { role: "assistant", timestamp: 2, content: [] } }
          },
          {
            type: "runtime_event",
            runId: "run-1",
            payload: update("text_delta", 0, { delta: "old" })
          }
        ]
      }
    };
    const messages = [{ role: "user", content: "第一问", timestamp: 1 }];
    const view = createConversationView({
      state,
      $: (selector) => document.querySelector(selector),
      textContent
    });
    return { document, state, messages, view };
  };

  const fast = makeView();
  const full = makeView();

  // Frame 1: first streaming answer mounted, owns global tail.
  fast.view.renderConversation(fast.messages, fast.state.detail.task);
  full.view.renderConversation(full.messages, full.state.detail.task);
  assert.equal(
    fast.document.querySelector("#conversation").innerHTML,
    full.document.querySelector("#conversation").innerHTML
  );

  // Frame 2: second user turn + assistant message_start arrive via SSE in the
  // same Run while `messages` snapshot still only has the first user message.
  const secondTurnEvents = [
    {
      type: "runtime_event",
      runId: "run-1",
      payload: { type: "message_start", message: { role: "user", content: "第二问", timestamp: 10 } }
    },
    {
      type: "runtime_event",
      runId: "run-1",
      payload: { type: "message_end", message: { role: "user", content: "第二问", timestamp: 10 } }
    },
    {
      type: "runtime_event",
      runId: "run-1",
      payload: { type: "message_start", message: { role: "assistant", timestamp: 11, content: [] } }
    }
  ];
  fast.state.detail.runtimeEvents.push(...secondTurnEvents.map((entry) => ({ ...entry })));
  full.state.detail.runtimeEvents.push(...secondTurnEvents.map((entry) => ({ ...entry })));
  const hitOnSecondTurn = Boolean(
    fast.view.renderConversation(fast.messages, fast.state.detail.task, {
      streamRecords: fast.state.detail.runtimeEvents.slice(-3)
    })
  );
  full.view.renderConversation(full.messages, full.state.detail.task);
  assert.equal(hitOnSecondTurn, false);
  assert.equal(
    fast.document.querySelector("#conversation").innerHTML,
    full.document.querySelector("#conversation").innerHTML
  );

  // Frame 3: text_delta("NEW") with same contentIndex arrives for the second
  // turn. First exchange does NOT own global tail, so fast path must NOT append
  // "NEW" onto "old".
  const newDeltaFast = {
    type: "runtime_event",
    runId: "run-1",
    payload: update("text_delta", 0, { delta: "NEW" })
  };
  const newDeltaFull = {
    type: "runtime_event",
    runId: "run-1",
    payload: update("text_delta", 0, { delta: "NEW" })
  };
  fast.state.detail.runtimeEvents.push(newDeltaFast);
  full.state.detail.runtimeEvents.push(newDeltaFull);
  const hitOnNewDelta = Boolean(
    fast.view.renderConversation(fast.messages, fast.state.detail.task, { streamRecords: [newDeltaFast] })
  );
  full.view.renderConversation(full.messages, full.state.detail.task);
  assert.equal(hitOnNewDelta, false, "fast path must not activate when active exchange lost global tail");
  assert.equal(
    fast.document.querySelector("#conversation").innerHTML,
    full.document.querySelector("#conversation").innerHTML
  );
  assert.equal(fast.document.querySelector(".live-answer").textContent.trim(), "old");
  assert.doesNotMatch(fast.document.querySelector("#conversation").textContent, /NEW/);
});
