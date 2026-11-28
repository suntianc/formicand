import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { HumanRequestStore } from "../dist/src/runtime/human.js";
import { MainInboxDelivery } from "../dist/src/runtime/main-inbox-delivery.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

async function fixture(t, timeoutMs, hooks = {}) {
  const root = await mkdtemp(join(tmpdir(), "formicand-question-tool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = new LocalWorkspaceStore(root);
  await task.createTask("task");
  await task.createRun("task", "run");
  const human = new HumanRequestStore(root);
  const inbox = new MainInboxDelivery(root, "task", "run");
  const tools = new Map();
  const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = requirePi("jiti");
  const modulePath = resolve(".pi/runtime/tools/coordination.ts");
  const jiti = createJiti(pathToFileURL(modulePath).href, { interopDefault: true });
  const { registerCoordinationTools } = await jiti.import(modulePath);
  const events = [];
  registerCoordinationTools(
    {
      registerTool(tool) {
        tools.set(tool.name, tool);
      }
    },
    {
      taskId: "task",
      mainRunId: "run",
      workspaceRoot: root,
      runtimeEnv: { FORMICAND_HUMAN_ANSWER_TIMEOUT_MS: String(timeoutMs) },
      humanStore: human,
      inboxDelivery: inbox,
      async flushSessionContext(ctx) {
        events.push("flushSessionContext");
        await hooks.flushSessionContext?.(ctx);
      },
      async materializeRequestSnapshot() {
        events.push("materializeRequestSnapshot");
        await hooks.materializeRequestSnapshot?.();
      },
      updateRuntime() {}
    }
  );
  return {
    human,
    inbox,
    events,
    tool: tools.get("askhuman"),
    ctx: { ui: { notify() {} }, sessionManager: { getBranch: () => [] } }
  };
}

test("aborting askhuman releases its wait promptly and clears the pending question", async (t) => {
  const f = await fixture(t, 1000);
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const result = await f.tool.execute(
    "ask",
    { questions: [{ question: "继续吗？" }] },
    controller.signal,
    undefined,
    f.ctx
  );
  assert.equal(result.details.status, "cancelled");
  assert.ok(Date.now() - started < 700, "Escape must not wait out the configured human timeout");
  assert.deepEqual(await f.human.list("task", "pending"), []);
});

test("askhuman timeout and rendered recommendation use the same normalized option", async (t) => {
  const f = await fixture(t, 0);
  const result = await f.tool.execute(
    "ask",
    { questions: [{ question: "格式？", options: [" ", "Markdown", "PDF"], recommended: [1] }] },
    undefined,
    undefined,
    f.ctx
  );
  const [question] = await f.human.list("task");
  assert.equal(question.options[question.recommended[0]], "Markdown");
  assert.deepEqual(result.details.recommended, [{ question: "格式？", answer: "Markdown" }]);
  assert.ok(Date.parse(question.expiresAt) > 0, "the page can count down to when Main proceeds");
});

test("several questions are one request with one answer, and a timeout lists each recommendation", async (t) => {
  const f = await fixture(t, 0);
  const result = await f.tool.execute(
    "ask",
    {
      questions: [
        {
          question: "改哪些页面？",
          label: "页面",
          options: ["登录", "注册", "设置"],
          multiple: true,
          recommended: [0, 1]
        },
        { question: "什么时候上线？", options: ["本周", "下周"] }
      ]
    },
    undefined,
    undefined,
    f.ctx
  );
  const [request] = await f.human.list("task");
  assert.equal(request.question, "改哪些页面？");
  assert.equal(request.questions.length, 2);
  assert.deepEqual(request.questions[0].recommended, [0, 1]);
  assert.equal(request.questions[0].multiple, true);
  assert.deepEqual(result.details.recommended, [{ question: "改哪些页面？", answer: "登录、注册" }]);
});

test("askhuman does not publish a pending question when context flush fails", async (t) => {
  const f = await fixture(t, 1000, {
    async flushSessionContext() {
      throw new Error("simulated messages.json flush failure");
    }
  });
  await assert.rejects(
    f.tool.execute("ask", { questions: [{ question: "继续吗？" }] }, undefined, undefined, f.ctx),
    /simulated messages\.json flush failure/
  );
  assert.deepEqual(f.events, ["flushSessionContext"]);
  assert.deepEqual(await f.human.list("task", "pending"), []);
});

test("askhuman does not publish a pending question when request materialization fails", async (t) => {
  const f = await fixture(t, 1000, {
    async materializeRequestSnapshot() {
      throw new Error("simulated materialize failure");
    }
  });
  await assert.rejects(
    f.tool.execute("ask", { questions: [{ question: "继续吗？" }] }, undefined, undefined, f.ctx),
    /simulated materialize failure/
  );
  assert.deepEqual(f.events, ["flushSessionContext", "materializeRequestSnapshot"]);
  assert.deepEqual(await f.human.list("task", "pending"), []);
});
