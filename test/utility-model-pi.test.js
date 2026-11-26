import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { profileId, providerConfig } from "./model-provider-fixture.mjs";

/**
 * The host's utility model writes a new conversation's title and the summary
 * of a window being left, and Main's own model takes over when it fails.
 *
 * Main runs on the launch connection; the utility model is a second local
 * provider. Which provider received a request is the only evidence used.
 */

async function waitFor(read, check, label) {
  for (let i = 0; i < 300; i++) {
    const state = await read();
    if (check(state)) return state;
    await delay(50);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

const systemText = (body) =>
  body.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    )
    .join("\n");
const isTitle = (body) => /You name conversations/.test(systemText(body));
const isSummary = (body) => /handoff summary/.test(systemText(body));

async function fixture(t, { utilityUp = true } = {}) {
  const main = await modelProtocolFixture("openai-completions", async (body) => {
    if (isTitle(body)) return { text: "MAIN TITLE" };
    if (isSummary(body)) return { text: "<summary>MAIN SUMMARY</summary>" };
    return { text: "已经看过登录跳转。" };
  });
  const utility = await modelProtocolFixture("openai-completions", async (body) => {
    if (isTitle(body)) return { text: "标题：「修复登录跳转」" };
    if (isSummary(body)) return { text: "<analysis>a</analysis><summary>UTILITY SUMMARY</summary>" };
    return { text: "unexpected" };
  });
  const entry = { id: "utility", baseUrl: utility.baseUrl, model: "utility-model", apiKey: "utility-key" };
  // An address nothing listens on: every request to it fails.
  if (!utilityUp) await utility.close();
  const dashboard = await startDashboard({
    modelEndpoint: main.baseUrl,
    defaultProject: false,
    sessionTitles: true,
    config: { ...providerConfig([entry]), utilityModel: { profileId: profileId(entry) } }
  });
  t.after(async () => {
    await dashboard.stop();
    await main.close();
    if (utilityUp) await utility.close();
  });
  const request = async (path, body) => {
    const response = await fetch(
      dashboard.base + path,
      body === undefined
        ? undefined
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    );
    const payload = await response.json();
    assert.ok(response.ok, JSON.stringify(payload));
    return payload;
  };
  await request("/api/tasks", { taskId: "named", goal: "帮我看看登录后为什么跳回首页" });
  const details = () => request("/api/tasks/named");
  const handoffs = async () => {
    const directory = join(dashboard.env.FORMICAND_WORKSPACE, "named", "sessions", "main", "pi");
    const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl"));
    return (await Promise.all(files.map((file) => readFile(join(directory, file), "utf8"))))
      .join("\n")
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse)
      .filter((entry) => entry.type === "compaction")
      .map((entry) => entry.summary);
  };
  return { main, utility, request, details, handoffs };
}

test(
  "the utility model names a conversation after its first turn and writes the window's summary",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    await f.request("/api/tasks/named/run", { prompt: "帮我看看登录后为什么跳回首页" });
    const named = await waitFor(f.details, ({ task }) => Boolean(task.title), "the title");
    assert.equal(named.task.title, "修复登录跳转");
    const titles = f.utility.requests.filter(({ body }) => isTitle(body));
    assert.equal(titles.length, 1, "one title request for the turn");
    assert.match(JSON.stringify(titles[0].body.messages), /登录后为什么跳回首页/);
    assert.match(JSON.stringify(titles[0].body.messages), /已经看过登录跳转/);
    assert.equal(titles[0].body.model, "utility-model");
    assert.equal(f.main.requests.length, 1, "Main's model only ran the turn");

    // A resident Main reads the setting when its window changes.
    await waitFor(f.details, ({ runtime }) => !runtime.active, "the turn to settle");
    await f.request("/api/tasks/named/action", { action: "compact" });
    await waitFor(f.details, ({ contextWindows }) => contextWindows.length === 1, "the new window");
    assert.match((await f.handoffs())[0], /UTILITY SUMMARY/);
    assert.equal(f.utility.requests.filter(({ body }) => isSummary(body)).length, 1);
    assert.equal(f.main.requests.length, 1, "Main's model wrote no summary");

    // A later turn keeps the title.
    await f.request("/api/tasks/named/run", { prompt: "再看看退出登录" });
    await waitFor(f.details, ({ runtime, task }) => !runtime.active && task.status === "completed", "turn 2");
    await delay(300);
    assert.equal(f.utility.requests.filter(({ body }) => isTitle(body)).length, 1);
    assert.equal((await f.details()).task.title, "修复登录跳转");
  }
);

test(
  "Main's own model writes the title and the summary when the utility model fails",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t, { utilityUp: false });
    await f.request("/api/tasks/named/run", { prompt: "帮我看看登录后为什么跳回首页" });
    const named = await waitFor(f.details, ({ task }) => Boolean(task.title), "the title");
    assert.equal(named.task.title, "MAIN TITLE");
    await waitFor(f.details, ({ runtime }) => !runtime.active, "the turn to settle");
    await f.request("/api/tasks/named/action", { action: "compact" });
    await waitFor(f.details, ({ contextWindows }) => contextWindows.length === 1, "the new window");
    assert.match((await f.handoffs())[0], /MAIN SUMMARY/);
  }
);
