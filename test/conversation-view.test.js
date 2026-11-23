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
  const { document, state, render } = fixture("steering-order", "补充前的第六步。");
  state.detail.runtimeEvents.push(update("thinking_end", 0, { content: "补充前的第六步。" }));
  render();
  expandHistory(document, render);
  const before = document.querySelector(".reasoning-details");
  before.open = true;
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
      row.classList.contains("execution-history")
        ? "before"
        : row.textContent.includes(instruction.content)
          ? "instruction"
          : row.querySelector(".process-segment.is-live")
            ? "after"
            : "request"
    ),
    ["request", "before", "instruction", "after"]
  );
  // Pre-interjection L1 wraps into an L0 execution-history fold without duplicating run duration;
  // because the reader already opened a step inside it, L0 stays open and keeps that step open.
  assert.equal(rows[1].open, true);
  assert.equal(rows[1].querySelector(":scope > summary strong").textContent, "处理过程");
  assert.doesNotMatch(rows[1].querySelector(":scope > summary").textContent, /用时/);
  assert.match(rows[1].textContent, /第六步/);
  assert.equal(document.querySelector(".reasoning-details").open, true);
  assert.equal(document.querySelectorAll(".thinking-spinner").length, 1);
  assert.equal(document.querySelectorAll('[data-answer-kind="final"]').length, 0);

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
  assert.equal(document.querySelectorAll(".execution-history").length, 2);
  assert.equal(document.querySelector(".reasoning-details").open, true);
  assert.equal(document.querySelectorAll(".chat-message.user").length, 2);
});

test("interjecting while L1 is untouched collapses earlier activity into a closed L0 fold", () => {
  const { document, state, render } = fixture("steering-collapse", "先读取配置。");
  state.detail.runtimeEvents.push(update("thinking_end", 0, { content: "先读取配置。" }));
  render();
  assert.equal(document.querySelectorAll(".execution-history").length, 0);

  const instruction = {
    role: "user",
    id: "steer-collapse",
    content: "换个方向",
    timestamp: 3,
    delivery: "steer",
    interjected: true
  };
  const delivered = {
    role: "custom",
    customType: "cowork-user-message",
    content: "用户在你工作期间补充了一句话：换个方向",
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
    update("thinking_delta", 0, { delta: "按新方向继续。" })
  );
  render([user, instruction]);
  const collapsed = document.querySelector(".execution-history");
  assert.ok(collapsed);
  assert.equal(collapsed.open === true, false);
  assert.equal(collapsed.querySelector(":scope > summary strong").textContent, "处理过程");
  assert.equal(document.querySelectorAll('[data-answer-kind="continuation"]').length, 0);
  assert.equal(document.querySelectorAll('[data-answer-kind="pending"]').length, 1);
});

test("a superseded waiting or tool-only round folds its L1 workflow into L0 when a later user turn follows", () => {
  const { document, state, render } = fixture("superseded-waiting", "先检查进度。");
  const progressUpdate = {
    role: "assistant",
    timestamp: 2,
    stopReason: "toolUse",
    content: [{ type: "text", text: "三块已完成一块，正在继续推进。" }]
  };
  const followup = { role: "user", id: "later-turn", content: "怎么样了？", timestamp: 5 };
  const finalAnswer = {
    role: "assistant",
    timestamp: 6,
    stopReason: "stop",
    content: [{ type: "text", text: "全部已完成并合入。" }]
  };
  state.detail.task.status = "completed";
  state.detail.runtime.active = false;
  state.detail.runtimeEvents.push(
    update("thinking_end", 0, { content: "先检查进度。" }),
    { type: "message_end", message: progressUpdate },
    update("toolcall_end", 1, {
      toolCall: { id: "cmd-1", name: "bash", arguments: { command: "git status" } }
    }),
    { type: "tool_execution_end", toolCallId: "cmd-1", result: { content: [] } },
    { type: "main.run_waiting", runId: "run-1" },
    { type: "message_start", message: followup },
    { type: "message_end", message: followup },
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant", timestamp: 6, content: [] } },
    update("thinking_start", 0),
    update("thinking_end", 0, { content: "整理最终结果。" }),
    { type: "message_end", message: finalAnswer },
    { type: "turn_end", message: finalAnswer }
  );
  render([user, progressUpdate, followup, finalAnswer]);

  const histories = document.querySelectorAll(".execution-history");
  assert.equal(histories.length, 2);
  assert.equal(histories[0].open === true, false);
  assert.equal(histories[1].open === true, false);
  // None of the superseded round's L1 rows leak outside L0.
  assert.equal(
    document.querySelectorAll("#conversation > .process-segment, #conversation > .live-answer").length,
    0
  );
  assert.equal(document.querySelectorAll('[data-answer-kind="final"]').length, 1);
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
  expandDetails(document, ".reasoning-details", render);
  const detail = document.querySelector(".reasoning-details");
  const spinner = detail.querySelector(".thinking-spinner");
  const paragraph = detail.querySelector(".reasoning-copy p");
  for (const delta of ["然后读取", "约束", "，继续检查。"]) {
    state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta }));
    render();
    assert.equal(document.querySelector(".reasoning-details"), detail);
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
  assert.equal(document.querySelectorAll(".tool-progress-spinner").length, 1);
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
  const { document, state, render } = fixture("parked-run", "本轮变化已核实。");
  state.detail.runtimeEvents.push(update("thinking_end", 0, { content: "本轮变化已核实。" }), {
    type: "main.run_waiting"
  });
  state.detail.runtime.active = false;
  state.detail.task.status = "waiting";
  state.detail.parked = { wakeAt: "2099-01-01T00:00:00Z", reason: "等待新变化" };
  render();
  assert.equal(document.querySelectorAll(".live-workflow-head, .turn-endline").length, 0);
  assert.equal(document.querySelectorAll("[data-thinking-key]").length, 0);
  assert.equal(document.querySelector(".process-segment").open === true, false);
  expandHistory(document, render);
  expandDetails(document, ".reasoning-details", render);
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

test("a collapsed thought shows its real first sentence and mounts its body only when expanded", () => {
  const thought = "先读取项目说明，确认约束。然后检查入口与工具。";
  const { document, render } = fixture("preview", thought);
  assert.match(document.querySelector(".process-segment.is-live > summary").textContent, /思考中/);
  expandHistory(document, render);
  const detail = document.querySelector(".reasoning-details");
  assert.match(detail.querySelector("summary").textContent, /先读取项目说明，确认约束。/);
  assert.doesNotMatch(detail.querySelector("summary").textContent, /然后检查|查看思考过程|实时更新/);
  assert.equal(detail.open === true, false);
  assert.equal(detail.querySelector(".reasoning-copy"), null);
  assert.equal(document.querySelectorAll(".reasoning-step .activity-step-head").length, 0);
  expandDetails(document, ".reasoning-details", render);
  assert.equal(detail.querySelector(".reasoning-copy").textContent, thought);
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
  assert.equal(document.querySelectorAll(".tool-progress-spinner").length, 0);
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
  expandDetails(document, ".reasoning-details", render);
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
  assert.equal(document.querySelector(".reasoning-details").open, true);
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
  const { document, render } = fixture("markdown-preview", thought);
  assert.match(document.querySelector(".process-segment.is-live > summary").textContent, /思考中/);
  expandHistory(document, render);
  assert.equal(
    document.querySelector(".reasoning-preview").textContent,
    "Planning project inspection and testing"
  );
  assert.equal(document.querySelector(".reasoning-details").open === true, false);
  expandDetails(document, ".reasoning-details", render);
  assert.equal(
    document.querySelector(".reasoning-copy strong").textContent,
    "Planning project inspection and testing"
  );
  assert.match(
    document.querySelector(".reasoning-copy").textContent,
    /I should read the project instructions first\./
  );
  expandDetails(document, ".activity-raw", render);
  assert.equal(document.querySelector(".activity-raw-copy").textContent, thought);
});

test("later streamed sentences do not replace the preview or the user's expansion choice", () => {
  const { document, state, render } = fixture("preview-stream", "先核对文件路径。");
  expandHistory(document, render);
  expandDetails(document, ".reasoning-details", render);
  for (const character of "接着检查文件权限与内容。") {
    state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta: character }));
    render();
    assert.equal(document.querySelector(".reasoning-preview")?.textContent, "先核对文件路径。");
    assert.equal(document.querySelector(".reasoning-details").open, true);
  }
  assert.equal(
    document.querySelector(".reasoning-copy").textContent,
    "先核对文件路径。接着检查文件权限与内容。"
  );
});

test("empty thought blocks have a running indication without an empty or invented preview", () => {
  const { document, state, render } = fixture("preview-empty", " \n ");
  assert.equal(document.querySelectorAll(".reasoning-details").length, 0);
  assert.equal(document.querySelectorAll(".reasoning-preview").length, 0);
  assert.match(document.querySelector(".reasoning-step").textContent, /思考中/);
  assert.equal(document.querySelectorAll(".thinking-spinner").length, 1);
  state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta: "真正的第一句。后续过程。" }));
  render();
  assert.match(document.querySelector(".process-segment.is-live > summary").textContent, /思考中/);
  expandHistory(document, render);
  assert.equal(document.querySelector(".reasoning-preview")?.textContent, "真正的第一句。");
});

test("long or HTML-like thinking stays plain in the preview and complete in the expanded body", () => {
  const thought = `<img src=x onerror=alert(1)> ${"核对输入".repeat(30)}。后续说明。`;
  const { document, render } = fixture("preview-plain", thought);
  expandHistory(document, render);
  const preview = document.querySelector(".reasoning-preview");
  assert.equal(preview.querySelector("img"), null);
  assert.equal(Array.from(preview.textContent).length, 88);
  assert.equal(preview.textContent.endsWith("…"), true);
  expandDetails(document, ".reasoning-details", render);
  assert.equal(document.querySelector(".reasoning-copy").textContent, thought);
});

test("a recovered final snapshot derives its preview and keeps thought text out of the final answer", () => {
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
  expandHistory(document, render, [user, answer]);
  assert.equal(document.querySelector(".reasoning-preview")?.textContent, "const path = 'local.txt';");
  expandDetails(document, ".reasoning-details", render, [user, answer]);
  assert.equal(document.querySelector(".reasoning-copy pre code").textContent, "const path = 'local.txt';");
  assert.match(document.querySelector(".reasoning-copy").textContent, /读取后继续检查。/);
  expandDetails(document, ".activity-raw", render, [user, answer]);
  assert.equal(document.querySelector(".activity-raw-copy").textContent, thought);
  assert.equal(answer.content[0].thinking, thought);
});

test("an expanded live thought stays open through deltas and a user's collapse survives polling", () => {
  const { document, state, render } = fixture();
  expandHistory(document, render);
  expandDetails(document, ".reasoning-details", render);
  state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta: "再核对第二部分。" }));
  render();
  assert.equal(document.querySelector(".reasoning-details").open, true);
  assert.match(document.querySelector(".reasoning-copy").textContent, /先核对第一部分。再核对第二部分。/);
  document.querySelector(".reasoning-details").open = false;
  render();
  assert.equal(document.querySelector(".reasoning-details").open, false);
});

test("thought blocks retain independent expansion before and after a tool and preserve choices on completion", () => {
  const { document, state, render } = fixture();
  expandHistory(document, render);
  expandDetails(document, ".reasoning-details", render);
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
  let blocks = [...document.querySelectorAll(".reasoning-details")];
  assert.deepEqual(
    blocks.map((node) => node.open === true),
    [true, false]
  );
  assert.equal(document.querySelectorAll(".reasoning-step .thinking-spinner").length, 1);
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
  blocks = [...document.querySelectorAll(".reasoning-details")];
  assert.deepEqual(
    blocks.map((node) => node.open === true),
    [true, false]
  );
  assert.equal(document.querySelectorAll(".thinking-spinner").length, 0);
  assert.equal(document.querySelectorAll('[data-answer-kind="final"]').length, 1);
});

test("leaving a thought for an empty conversation preserves its expansion without leaking into another task", () => {
  const { document, state, render } = fixture();
  const first = state.detail;
  expandHistory(document, render);
  expandDetails(document, ".reasoning-details", render);
  state.selected = "reasoning-two";
  state.detail = { ...first, task: { ...first.task, taskId: state.selected } };
  render([]);
  render();
  assert.equal(document.querySelector(".process-segment").open === true, false);
  expandHistory(document, render);
  assert.equal(document.querySelector(".reasoning-details").open === true, false);
  state.selected = "reasoning-one";
  state.detail = first;
  render();
  assert.equal(document.querySelector(".process-segment").open, true);
  assert.equal(document.querySelector(".reasoning-details").open, true);
});

test("thought reading positions and independent follow-up choices survive updates", () => {
  const { document, state, render } = fixture();
  expandHistory(document, render);
  expandDetails(document, ".reasoning-details", render);
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
  expandHistory(document, render, [user, answer, followUp]);
  const blocks = [...document.querySelectorAll(".reasoning-details")];
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
  expandDetails(document, ".reasoning-details", render, [user, stopped]);
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
  assert.equal(row.querySelectorAll(".tool-progress-spinner, .ant-mark").length, 0);
  assert.equal(row.querySelectorAll(".tool-status-dot").length, 1);
  // Main's own turn ends while Ara works; Ara's row keeps its running state without logo animation.
  state.detail.runtime.active = false;
  render();
  row = document.querySelector(".subagent-step");
  assert.equal(row.open, true);
  assert.equal(row.classList.contains("is-running"), true);
  assert.equal(row.querySelectorAll(".tool-progress-spinner, .ant-mark").length, 0);
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
  assert.equal(row.querySelectorAll(".tool-progress-spinner").length, 0);
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
