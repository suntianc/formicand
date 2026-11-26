import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("returned async tools retain real work status through progress, callbacks and completion", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.route("**/app.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: "// Isolated UI state fixture" })
    );
    await page.goto(dashboard.base);
    await page.evaluate(async () => {
      const { createConversationView } = await import("/assets/controllers/conversation-view.js");
      const user = { role: "user", content: "四缸发动机协作状态验收", timestamp: 1 };
      const runtimeEvents = [{ type: "turn_start" }, { type: "message_start", message: user }];
      for (const [id, name, args, data] of [
        [
          "question",
          "askhuman",
          { questions: [{ question: "使用机械联动还是动力学仿真？" }] },
          { status: "timeout" }
        ],
        [
          "dispatch",
          "call_subagent",
          { task: "独立核验曲轴、活塞和凸轮联动" },
          { accepted: true, callId: "one", name: "Ara" }
        ],
        [
          "dispatch-two",
          "call_subagent",
          { task: "核对点火顺序" },
          { accepted: true, callId: "two", name: "Bea" }
        ],
        [
          "message",
          "send_subagent_message",
          { callId: "one", message: "补充核对凸轮间隙" },
          { status: "queued", messageId: "message-one" }
        ]
      ])
        runtimeEvents.push(
          { type: "tool_execution_start", toolCallId: id, toolName: name, args },
          { type: "tool_execution_end", toolCallId: id, toolName: name, result: { details: data } }
        );
      const state = {
        selected: "fixture",
        localMessages: [],
        executionHistoryOpen: new Map(),
        detail: {
          task: { taskId: "fixture", status: "running" },
          runtime: { active: true },
          runtimeEvents,
          coordination: {
            calls: [
              { callId: "one", status: "running" },
              { callId: "two", status: "running" }
            ],
            pending: ["one", "two"],
            callbackPending: []
          }
        }
      };
      const view = createConversationView({
        state,
        $: (selector) => document.querySelector(selector),
        bindStarterPrompts() {},
        textContent: (value) => (typeof value === "string" ? value : "")
      });
      window.lifecycleFixture = { state, render: () => view.renderConversation([user], state.detail.task) };
      window.lifecycleFixture.render();
    });
    // A running subagent row stays directly visible in L1, one line with no disclosure, while
    // ordinary tools fold into .process-segment.
    const agent = page.locator(".subagent-step").first();
    await expect(page.locator(".subagent-group > .subagent-step")).toHaveCount(2);
    // Each dispatched Subagent takes its own line under the one before.
    const [first, second] = await page.$$eval(".subagent-group > .subagent-step", (rows) =>
      rows.map((row) => row.getBoundingClientRect().toJSON())
    );
    expect(second.top).toBeGreaterThanOrEqual(first.bottom - 0.5);
    expect(second.left).toBe(first.left);
    await expect(agent.locator(".subagent-status")).toHaveText("运行中");
    await expect(agent.locator(".ant-mark")).toHaveCount(0);
    await expect(agent.locator(".tool-status-dot")).toHaveCount(1);
    await expect(agent.locator("summary")).toHaveCount(0);
    for (const summary of await page.locator(".process-segment > summary").all()) await summary.click();
    await expect(page.locator(".tool-step .activity-status")).toHaveText(["未答复，已继续", "已入队"]);
    // Each row's mark sits on the middle of its words, whatever its state.
    for (const offset of await page.$$eval(".tool-step", (steps) =>
      steps.map((step) => {
        const middle = (node) => {
          const box = node.getBoundingClientRect();
          return box.y + box.height / 2;
        };
        return (
          middle(step.querySelector(".tool-status-dot")) - middle(step.querySelector(".tool-action strong"))
        );
      })
    ))
      expect(Math.abs(offset)).toBeLessThan(0.75);
    await mkdir(".tmp/status-verification", { recursive: true });
    await page.screenshot({ path: test.info().outputPath("running.png"), fullPage: true });
    await page.evaluate(() => {
      const fixture = window.lifecycleFixture;
      fixture.state.detail.runtime.active = false;
      fixture.state.detail.coordination = {
        calls: [{ callId: "one", status: "completed" }],
        callbackPending: ["one"]
      };
      fixture.render();
    });
    // Done but not yet read by Main is still done for the person.
    await expect(agent.locator(".subagent-status")).toHaveText("完成");
    await expect(page.locator(".live-workflow-head")).toHaveCount(0);
    await page.evaluate(() => {
      window.lifecycleFixture.state.detail.coordination.callbackPending = [];
      window.lifecycleFixture.render();
    });
    await expect(agent.locator(".subagent-status")).toHaveText("完成");
    await expect(page.locator(".subagent-group")).toHaveCount(1);
  } finally {
    await dashboard.stop();
  }
});

test("Main sitting in a wait for its Subagents titles the transcript row with the wait", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.route("**/app.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: "// Isolated UI state fixture" })
    );
    await page.goto(dashboard.base);
    await page.evaluate(async () => {
      const { createConversationView } = await import("/assets/controllers/conversation-view.js");
      const user = { role: "user", content: "并行升级两个依赖", timestamp: 1 };
      const runtimeEvents = [
        { type: "turn_start" },
        { type: "message_start", message: user },
        { type: "tool_execution_start", toolCallId: "status", toolName: "get_subagent_status", args: {} },
        { type: "tool_execution_end", toolCallId: "status", toolName: "get_subagent_status", result: {} },
        { type: "tool_execution_start", toolCallId: "wait", toolName: "wait_for_subagents", args: {} }
      ];
      const state = {
        selected: "fixture",
        localMessages: [],
        executionHistoryOpen: new Map(),
        detail: { task: { taskId: "fixture", status: "running" }, runtime: { active: true }, runtimeEvents }
      };
      const view = createConversationView({
        state,
        $: (selector) => document.querySelector(selector),
        bindStarterPrompts() {},
        textContent: (value) => (typeof value === "string" ? value : "")
      });
      view.renderConversation([user], state.detail.task);
    });
    // The row says what Main waits for, without the live spinner of work.
    const row = page.locator(".process-segment").last();
    await expect(row.locator("summary .process-segment-label")).toHaveText("等待子助手的结果");
    await expect(row).not.toHaveClass(/is-live/);
    await expect(page.locator(".thinking-spinner")).toHaveCount(0);
    await expect(page.getByText("等待协作结果中")).toHaveCount(0);
    await expect(page.getByText("思考中")).toHaveCount(0);
  } finally {
    await dashboard.stop();
  }
});
