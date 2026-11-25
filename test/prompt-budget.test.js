import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

/**
 * The size limits of each prompt layer (docs/prompt-and-delivery-design.md).
 * A layer that grows past its limit must give up other text first.
 */
const BASE = 4 * 1024;
const STATE = 1.5 * 1024;
const SKILL = 4 * 1024;
const TOOL = 1024;

const bytes = (text) => Buffer.byteLength(text ?? "");

test("the base prompt and every bundled skill stay within their limits", async () => {
  const base = await readFile(".pi/prompts/formicand-main.md", "utf8");
  assert.ok(bytes(base) <= BASE, `formicand-main.md is ${bytes(base)} bytes, over ${BASE}`);
  const skills = await readdir(".pi/skills", { withFileTypes: true });
  assert.ok(skills.length > 0);
  // Skills adapted from upstream keep the length their method needs; the limit is for ours.
  const adapted = Object.keys(JSON.parse(await readFile("scripts/upstream-skills.json", "utf8")).skills);
  for (const entry of skills.filter(
    (candidate) => candidate.isDirectory() && !adapted.includes(candidate.name)
  )) {
    const text = await readFile(join(".pi/skills", entry.name, "SKILL.md"), "utf8");
    assert.ok(bytes(text) <= SKILL, `skill ${entry.name} is ${bytes(text)} bytes, over ${SKILL}`);
  }
});

test("each Main tool's text stays within its limit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-prompt-budget-"));
  const previous = { ...process.env };
  t.after(async () => {
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "config.json"), "{}");
  Object.assign(process.env, {
    FORMICAND_CONFIG: join(root, "config.json"),
    FORMICAND_WORKSPACE: join(root, "workspace"),
    FORMICAND_TASK_ID: "budget-task",
    FORMICAND_RUN_ID: "budget-run",
    FORMICAND_DASHBOARD_URL: "http://127.0.0.1:1"
  });
  delete process.env.FORMICAND_API_BASE;
  delete process.env.FORMICAND_API_KEY;
  const registered = new Map();
  const pi = {
    on() {},
    registerTool: (entry) => registered.set(entry.name, entry),
    registerProvider() {},
    registerCommand() {},
    getActiveTools: () => [...registered.keys()],
    setActiveTools() {},
    sendMessage: async () => {}
  };
  const extensionPath = resolve(".pi/extensions/formicand.ts");
  const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = await import(requirePi.resolve("jiti"));
  const extension = await createJiti(pathToFileURL(extensionPath).href, { interopDefault: true }).import(
    extensionPath,
    { default: true }
  );
  await (extension.default ?? extension)(pi);
  // Tools a capability group enables later are registered too, so they are measured here.
  assert.ok(registered.has("call_subagent") && registered.has("browser_act"));
  for (const tool of registered.values()) {
    // What the model reads about one tool: its description, its line in the
    // tool list and the rules it adds.
    const size =
      bytes(tool.description) +
      bytes(tool.promptSnippet) +
      (tool.promptGuidelines ?? []).reduce((sum, rule) => sum + bytes(rule), 0);
    assert.ok(size <= TOOL, `${tool.name} has ${size} bytes of text, over ${TOOL}`);
  }
});

test("Main's workspace state section stays within its limit", { timeout: 60_000 }, async (t) => {
  const provider = await modelProtocolFixture("openai-completions", () => ({ text: "ok" }));
  t.after(() => provider.close());
  const dashboard = await startDashboard({ modelEndpoint: provider.baseUrl, model: "protocol-fixture" });
  t.after(() => dashboard.stop());
  const post = async (path, body) => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.ok(response.ok, `${path} ${response.status}`);
    return response.json();
  };
  const { taskId } = await post("/api/tasks", { goal: "budget", projectId: dashboard.projectId });
  await post(`/api/tasks/${taskId}/run`, { prompt: "budget" });
  for (let attempt = 0; attempt < 300 && !provider.requests.length; attempt++) await delay(100);
  const system = provider.requests[0].body.messages[0].content;
  const sections = system.match(/<current_workspace>\n([^]*?)\n<\/current_workspace>/g);
  assert.equal(sections?.length, 1, "one current_workspace section, wrapped once");
  // The paths are this machine's; the limit is for the words around them.
  const words = sections[0]
    .replace(/<formicand_main_context>[^]*?<\/formicand_main_context>/, "")
    .replaceAll(dashboard.workspaceRoot, "<root>")
    .replace(/<root>\/[^\s]+/g, "<path>");
  assert.ok(bytes(words) <= STATE, `current_workspace is ${bytes(words)} bytes without paths, over ${STATE}`);
});

test("the Executor's and the Reviewer's role prompts stay within the base limit", async () => {
  const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = await import(requirePi.resolve("jiti"));
  const path = resolve(".pi/runtime/subagent-agent.ts");
  const { subagentRolePrompt } = await createJiti(pathToFileURL(path).href).import(path);
  for (const role of ["executor", "reviewer"]) {
    const prompt = subagentRolePrompt({
      role,
      name: "worker",
      workingDirectory: "/w",
      taskWorkspace: "/t",
      deliverablesDirectory: "/d"
    });
    assert.ok(bytes(prompt) <= BASE, `the ${role} prompt is ${bytes(prompt)} bytes, over ${BASE}`);
    // Every role hands back the same three parts.
    assert.match(prompt, /Result: [^]*Evidence: [^]*Tried and dropped: /);
  }
});
