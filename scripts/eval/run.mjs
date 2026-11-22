#!/usr/bin/env node
/**
 * Run the prompt eval task set against a real model.
 *
 *   node scripts/eval/run.mjs [--tasks fix,due] [--repeat 2] [--out DIR] [--label NAME]
 *                             [--context-window TOKENS]
 *
 * Needs `npm run build` first. Each run starts its own Dashboard in a temporary
 * data home, with copies of the desktop's model settings and keys
 * (`~/.atria/model-config.json`, `credentials.json`, or `EVAL_MODEL_CONFIG` and
 * `EVAL_CREDENTIALS`); the user's own data home and running app are not touched.
 * The copies are removed when the run ends. This calls a paid model.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "../../test/dashboard-fixture.mjs";
import { tasks } from "./tasks.mjs";
import { ledgerTitles, recordEarlierMerges, seedLedger } from "./history.mjs";

const run = promisify(execFile);
const here = resolve(new URL(".", import.meta.url).pathname);
const ANSWER = "你按自己的判断决定就好，不用再问我，继续做完。";
const NUDGE = "继续。";
const TIMEOUT_MS = 45 * 60_000;

function options(argv) {
  const values = { repeat: "1", label: new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-") };
  for (let i = 0; i < argv.length; i += 2) values[argv[i].replace(/^--/, "")] = argv[i + 1];
  const selected = values.tasks ? values.tasks.split(",") : tasks.map((task) => task.id);
  const unknown = selected.filter((id) => !tasks.some((task) => task.id === id));
  if (unknown.length) throw new Error(`unknown task: ${unknown.join(", ")}`);
  return {
    tasks: tasks.filter((task) => selected.includes(task.id)),
    repeat: Number(values.repeat),
    contextWindow: values["context-window"] ? Number(values["context-window"]) : undefined,
    out: resolve(values.out ?? join(here, "results", values.label))
  };
}

async function git(cwd, ...args) {
  return (await run("git", args, { cwd })).stdout;
}

async function api(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const textOf = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");

/**
 * Settled: the turn ended and no delegated work or callback is outstanding.
 * A turn that ends on a reply waits for the user, which counts as settled once
 * no question card is pending; the questions are answered above.
 */
function settled(detail) {
  const { task, runtime, coordination } = detail;
  const waiting =
    task.status === "waiting" && !detail.humanRequests.some((request) => request.status === "pending");
  return (
    (["completed", "failed", "cancelled"].includes(task.status) || waiting) &&
    !runtime.active &&
    !coordination.pending?.length &&
    !coordination.callbackPending?.length
  );
}

/** Drive one Task until it settles, answering questions and nudging a stalled turn once. */
async function drive(base, taskId, prompt, check, counts = { questions: [], confirmations: 0, nudges: 0 }) {
  const nudged = counts.nudges;
  await api(base, `/api/tasks/${taskId}/run`, { prompt });
  const until = Date.now() + TIMEOUT_MS;
  let calm = 0;
  while (Date.now() < until) {
    await delay(5_000);
    const detail = await api(base, `/api/tasks/${taskId}`);
    for (const request of detail.humanRequests.filter((entry) => entry.status === "pending")) {
      // A confirmation card (tickets, an Agent) is approved as proposed, the
      // way a user who agrees with the plan answers it; it is not a question.
      const approve = request.proposal !== undefined;
      if (approve) counts.confirmations++;
      else counts.questions.push(request.question);
      await api(base, `/api/tasks/${taskId}/human/${request.requestId}/answer`, {
        answer: approve ? request.options[0] : ANSWER
      });
    }
    if (!settled(detail)) {
      calm = 0;
      continue;
    }
    if (++calm < 2) continue;
    // A turn that ended before the work passed its check and with the user
    // asked something is a stop; one plain "continue" tells a stop from a failure.
    const last = detail.messages.findLast((message) => message.role === "assistant");
    if (counts.nudges === nudged && /[?？]\s*$/.test(textOf(last ?? {}).trim()) && !(await check()).passed) {
      counts.nudges++;
      calm = 0;
      await api(base, `/api/tasks/${taskId}/run`, { prompt: NUDGE });
      continue;
    }
    return { detail, counts, timedOut: false };
  }
  await api(base, `/api/tasks/${taskId}/action`, { action: "cancel" });
  return { detail: await api(base, `/api/tasks/${taskId}`), counts, timedOut: true };
}

async function hiddenCheck(task, repo) {
  if (!task.hidden) return { passed: true, output: "" };
  try {
    const { stdout } = await run("node", ["--test", join(here, "hidden", task.hidden)], {
      cwd: here,
      env: { ...process.env, EVAL_REPO: repo },
      timeout: 120_000
    });
    return { passed: true, output: summary(stdout) };
  } catch (error) {
    return { passed: false, output: summary(`${error.stdout ?? ""}${error.stderr ?? ""}`) };
  }
}

const summary = (tap) =>
  tap
    .split("\n")
    .filter((line) => /^(not ok|# (pass|fail))/.test(line.trim()))
    .join("\n");

async function ownTests(repo) {
  try {
    await run("npm", ["test"], { cwd: repo, timeout: 120_000 });
    return true;
    // eslint-disable-next-line no-restricted-syntax -- a failing test run is the result being recorded
  } catch {
    return false;
  }
}

async function leftovers(repo, word) {
  const { stdout } = await run("git", ["grep", "-c", word, "--", "src", ":!src/store.js"], {
    cwd: repo
  }).catch((error) => {
    // git grep exits 1 when nothing matches.
    if (error.code === 1) return { stdout: "" };
    throw error;
  });
  return stdout.trim().split("\n").filter(Boolean);
}

async function runTask(dashboard, task, attempt, out) {
  const dir = await mkdtemp(join(tmpdir(), `atria-eval-${task.id}-`));
  const repo = join(dir, "todo-cli");
  await cp(join(here, "repo"), repo, { recursive: true });
  await task.setup?.(repo);
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "add", "-A");
  await git(repo, "-c", "user.name=eval", "-c", "user.email=eval@localhost", "commit", "-qm", "start");
  const base = (await git(repo, "rev-parse", "HEAD")).trim();

  const { project } = await api(dashboard.base, "/api/projects", {
    projectName: `${task.id}-${attempt}`,
    projectDirectory: repo
  });
  const ledgerPost = (body) => api(dashboard.base, `/api/projects/${project.projectId}/ledger`, body);
  if (task.ledger) await seedLedger(ledgerPost, task.ledger);
  if (task.mergedBefore)
    await recordEarlierMerges(
      join(dashboard.root, "project-data.sqlite"),
      ledgerPost,
      project.projectId,
      task.mergedBefore
    );
  const seeded = await ledgerTitles(ledgerPost);
  // The first conversation takes the prompt and its follow-ups; each later
  // session is a new conversation in the same project.
  const conversations = [{ prompt: task.prompt, followUps: task.followUps ?? [] }].concat(
    (task.sessions ?? []).map((prompt) => ({ prompt, followUps: [] }))
  );
  const started = Date.now();
  const counts = { questions: [], confirmations: 0, nudges: 0 };
  const taskIds = [];
  let detail;
  let timedOut = false;
  for (const conversation of conversations) {
    const created = await api(dashboard.base, "/api/tasks", {
      goal: conversation.prompt,
      projectId: project.projectId
    });
    const id = created.task?.taskId ?? created.taskId;
    taskIds.push(id);
    for (const prompt of [conversation.prompt, ...conversation.followUps]) {
      const driven = await drive(dashboard.base, id, prompt, () => hiddenCheck(task, repo), counts);
      detail = driven.detail;
      timedOut ||= driven.timedOut;
      if (timedOut) break;
    }
    if (timedOut) break;
  }
  const taskId = taskIds.at(-1);

  const developments = await api(dashboard.base, `/api/tasks/${taskId}/developments`);
  const records = developments.developments;
  const ticketSets = await Promise.all(
    records.map(
      async (record) =>
        (
          await api(dashboard.base, `/api/tasks/${taskId}/developments`, {
            action: "tickets",
            developmentId: record.developmentId
          })
        ).tickets
    )
  );
  const owned = new Set(ticketSets.flatMap((set) => set.tickets.flatMap((ticket) => ticket.reviewIds ?? [])));
  const reviews = (await api(dashboard.base, `/api/tasks/${taskId}/reviews`)).reviews;
  const changed = (await git(repo, "status", "--porcelain")).split("\n").filter(Boolean);
  const committed = (await git(repo, "diff", "--name-only", base, "HEAD")).split("\n").filter(Boolean);
  const tools = {};
  const ledger = [];
  for (const event of detail.runtimeEvents ?? []) {
    const payload = event.payload ?? event;
    if (payload.type !== "tool_execution_start") continue;
    tools[payload.toolName] = (tools[payload.toolName] ?? 0) + 1;
    if (payload.toolName === "project_ledger") ledger.push(payload.args ?? {});
  }
  const titles = await ledgerTitles(ledgerPost);
  const calls = detail.coordination.calls ?? [];
  const final = detail.messages.findLast((message) => message.role === "assistant");
  const result = {
    task: task.id,
    attempt,
    status: detail.task.status,
    timedOut,
    minutes: Math.round((Date.now() - started) / 6_000) / 10,
    tokens: detail.statistics?.usage?.totalTokens ?? null,
    // Most of the total is the cached context read again on every response.
    freshTokens: detail.statistics?.usage
      ? detail.statistics.usage.input + detail.statistics.usage.output
      : null,
    hidden: await hiddenCheck(task, repo),
    // Work left in a requirement checkout that was never merged back.
    hiddenInCheckout: await Promise.all(
      records
        .map((record) => record.workspace?.directory)
        .filter(Boolean)
        .map((directory) => hiddenCheck(task, directory))
    ),
    ownTests: await ownTests(repo),
    changedFiles: [...new Set([...changed.map((line) => line.slice(3)), ...committed])],
    leftovers: task.expect.noLeftover ? await leftovers(repo, task.expect.noLeftover) : undefined,
    delegations: calls.map((call) => ({ name: call.name, role: call.role, status: call.status })),
    questions: counts.questions,
    confirmations: counts.confirmations,
    nudges: counts.nudges,
    developments: records.map((record) => ({ route: record.route, criteria: record.completionCriteria })),
    tickets: ticketSets.flatMap((set) =>
      set.tickets.map((ticket) => ({
        ticketId: ticket.ticketId,
        title: ticket.title,
        state: ticket.state,
        scope: ticket.scope,
        dependsOn: ticket.dependsOn
      }))
    ),
    // A review no ticket owns is the full route's final review.
    reviews: reviews.map((review) => ({
      reviewId: review.reviewId,
      final: !owned.has(review.reviewId),
      state: review.state,
      previousReviewId: review.previousReviewId,
      findings: review.findings.length
    })),
    tools,
    // Requirements the run added to the ledger, and the seeded ones it removed (a tidy's merge).
    requirementsCreated: titles.filter((title) => !seeded.includes(title)),
    requirementsRemoved: seeded.filter((title) => !titles.includes(title)),
    // How Main searched the ledger: each call's action and its query or target.
    ledger: ledger.map((args) =>
      [args.action, args.q ?? args.requirementId ?? args.status ?? ""].join(" ").trim()
    ),
    // Compaction entries in the Main sessions, counted the same way for the
    // summary compaction before P4.9 and the handoff after it.
    windows: await windowChanges(dashboard.env.COWORK_WORKSPACE, taskIds),
    contextWindow: detail.contextUsage?.contextWindow ?? null,
    memories: await savedMemories(dashboard.env.ATRIA_HOME),
    finalReply: textOf(final ?? {})
  };
  await writeFile(join(out, `${task.id}-${attempt}.json`), JSON.stringify(result, null, 2));
  await writeFile(join(out, `${task.id}-${attempt}.detail.json`), JSON.stringify(detail, null, 2));
  await rm(dir, { recursive: true, force: true });
  return result;
}

async function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

async function windowChanges(workspace, taskIds) {
  let count = 0;
  for (const file of await filesUnder(workspace)) {
    if (!file.endsWith(".jsonl") || !taskIds.some((id) => file.includes(id))) continue;
    count += (await readFile(file, "utf8"))
      .split("\n")
      .filter((line) => line.includes('"type":"compaction"')).length;
  }
  return count;
}

async function savedMemories(home) {
  return (await filesUnder(join(home, "memory")))
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(home.length + 1));
}

function verdicts(task, result) {
  const notes = [];
  if (!result.hidden.passed)
    notes.push(result.hiddenInCheckout.some((check) => check.passed) ? "做完但没合入" : "检查未过");
  if (!result.ownTests) notes.push("项目测试未过");
  if (result.timedOut) notes.push("超时");
  if (result.nudges) notes.push("中途停下");
  if (result.questions.length) notes.push(`问用户 ${result.questions.length} 次`);
  const { expect } = task;
  if (expect.delegations === 0 && result.delegations.length)
    notes.push(`派了 ${result.delegations.length} 次`);
  if (expect.maxChangedFiles !== undefined && result.changedFiles.length > expect.maxChangedFiles)
    notes.push(`改了 ${result.changedFiles.length} 个文件`);
  if (expect.development && !result.developments.length) notes.push("没走开发记录");
  if (expect.tickets && !result.tickets.length) notes.push("没拆票");
  // A call record carries no role; an independent review leaves a review record.
  if (expect.review && !result.reviews.length) notes.push("没派审查");
  if (expect.requirementsCreated === 0 && result.requirementsCreated.length)
    notes.push(`新建需求 ${result.requirementsCreated.join("、")}`);
  if (expect.merged && expect.merged.every((title) => !result.requirementsRemoved.includes(title)))
    notes.push("重复需求没合并");
  if (result.leftovers?.length) notes.push(`残留 ${result.leftovers.join(" ")}`);
  return notes.length ? notes.join("；") : "通过";
}

async function main() {
  const { tasks: selected, repeat, out, contextWindow } = options(process.argv.slice(2));
  await mkdir(out, { recursive: true });
  const secrets = await mkdtemp(join(tmpdir(), "atria-eval-config-"));
  const config = join(secrets, "model-config.json");
  const credentials = join(secrets, "credentials.json");
  await copyFile(process.env.EVAL_MODEL_CONFIG ?? join(homedir(), ".atria", "model-config.json"), config);
  await copyFile(process.env.EVAL_CREDENTIALS ?? join(homedir(), ".atria", "credentials.json"), credentials);
  if (contextWindow) await shrinkContextWindow(config, contextWindow);
  const dashboard = await startDashboard({
    defaultProject: false,
    env: { COWORK_CONFIG: config, COWORK_CREDENTIALS: credentials }
  });
  const rows = [];
  try {
    const models = await api(dashboard.base, "/api/model-settings");
    const main = models.modelRoles?.roles?.find((role) => role.role === "main")?.effective;
    console.log(
      `model: ${main?.connectionName ?? "?"} / ${main?.model ?? "?"}  window: ${main?.contextWindow ?? "?"}  out: ${out}`
    );
    for (const task of selected)
      for (let attempt = 1; attempt <= repeat; attempt++) {
        console.log(`▶ ${task.id} #${attempt}`);
        const result = await runTask(dashboard, task, attempt, out);
        const verdict = verdicts(task, result);
        rows.push({ task, result, verdict });
        console.log(`  ${verdict}  (${result.minutes} 分钟, ${result.tokens ?? "?"} tokens)`);
      }
    await writeFile(join(out, "summary.md"), report(rows, main));
  } finally {
    await dashboard.stop();
    await rm(secrets, { recursive: true, force: true });
  }
}

/**
 * Give every connection and model in the copied settings a small window that
 * the endpoint's own limit does not replace, so a long task changes windows.
 * Only the temporary copy is changed.
 */
async function shrinkContextWindow(file, tokens) {
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    if (
      "contextWindow" in value ||
      "autoLimits" in value ||
      "baseUrl" in value ||
      "supportsImages" in value
    ) {
      value.contextWindow = tokens;
      value.autoLimits = (value.autoLimits ?? ["maxTokens", "images"]).filter(
        (field) => field !== "contextWindow"
      );
    }
    Object.values(value).forEach(visit);
  };
  const config = JSON.parse(await readFile(file, "utf8"));
  visit(config);
  await writeFile(file, JSON.stringify(config));
}

/** Where a rule meant to outlast the conversation was kept: Main's memory, the repository's AGENTS.md, or both. */
const remembered = (result) =>
  [
    result.memories.length ? `记忆 ${result.memories.length}` : "",
    result.changedFiles.includes("AGENTS.md") ? "AGENTS.md" : ""
  ]
    .filter(Boolean)
    .join("、") || "—";

function report(rows, model) {
  const lines = [
    `模型：${model?.connectionName ?? "?"} / ${model?.model ?? "?"}，上下文窗口 ${model?.contextWindow ?? "?"}`,
    "",
    "| 任务 | 次 | 结果 | 分钟 | tokens | 不含缓存 | 换窗 | 记在 | 查台账 | 新建需求 | 派单 | 提问 | 票 | 审查 | 改动文件 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  ];
  for (const { task, result, verdict } of rows)
    lines.push(
      `| ${task.title} | ${result.attempt} | ${verdict} | ${result.minutes} | ${result.tokens ?? "—"} | ${result.freshTokens ?? "—"} | ${result.windows} | ${remembered(result)} | ${result.ledger.length} | ${result.requirementsCreated.join("、") || "—"} | ${result.delegations.length} | ${result.questions.length} | ${result.tickets.length} | ${result.reviews.length} | ${result.changedFiles.length} |`
    );
  lines.push("", "## 最终汇报", "");
  for (const { task, result } of rows) {
    lines.push(`### ${task.title} #${result.attempt}`, "");
    if (result.hidden.output.includes("not ok"))
      lines.push("检查未过：", "", "```", result.hidden.output, "```", "");
    if (result.ledger.length) lines.push(`查台账：${result.ledger.join("；")}`, "");
    lines.push(result.finalReply, "");
  }
  return lines.join("\n");
}

await main();
