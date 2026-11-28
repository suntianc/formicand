import { listenOnFixtureHttpPort } from "./fixtures/http-server.mjs";
import { releaseFixtureResources } from "./fixtures/cleanup.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";

/** The one prompt every capture run sends, so two captures stay comparable. */
export const CAPTURE_PROMPT = "你好！";
export const CAPTURE_MODEL = "p46-upgrade-fixture";

export async function createUpgradeTask(dashboard, taskId, goal, after) {
  const created = await fetch(`${dashboard.base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId, goal })
  });
  if (!created.ok) throw new Error(`Could not create ${taskId}: HTTP ${created.status}`);
  // Main remains resident after a completed turn. Close the session while its
  // Dashboard is still available, before the fixture removes its workspace.
  after(async () => {
    const closed = await fetch(`${dashboard.base}/api/tasks/${taskId}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
      signal: AbortSignal.timeout(60_000)
    });
    await closed.arrayBuffer();
    if (!closed.ok) throw new Error(`Could not close ${taskId}: HTTP ${closed.status}`);
  });
  await created.arrayBuffer();
}

/**
 * Run one standard Main turn against a recorded local provider and return the
 * model request the real Pi process produced.
 *
 * Its summary is stored as `test/fixtures/p46-pi-upgrade-baseline.json`; the
 * comparison test then checks the current runtime against that stored baseline
 * instead of re-deriving it. After a reviewed, intended change to the tool
 * table or the prompt's sections, record it again with
 * `node test/p46-pi-upgrade-capture.mjs --record` (build first).
 */
export async function captureStandardMainRun({ api = "openai-completions", after }) {
  const requests = [];
  const provider = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ data: [{ id: CAPTURE_MODEL }] }));
    }
    const raw = await readFixtureRequestBody(request);
    requests.push({ path: request.url, body: JSON.parse(raw) });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(protocolStream(api, { text: "收到。" }));
  });
  const port = await listenOnFixtureHttpPort(provider);
  after(async () => {
    provider.closeAllConnections();
    await new Promise((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve())));
  });
  const dashboard = await startDashboard({
    modelEndpoint: `http://127.0.0.1:${port}`,
    model: CAPTURE_MODEL
  });
  after(() => dashboard.stop());
  // Pin the protocol and output budget: a different default would change the
  // request the baseline describes without any SDK change.
  await writeFile(join(dashboard.root, "config.json"), JSON.stringify({ api, mainMaxTokens: 64 }));
  await mkdir(join(dashboard.root, "pi"), { recursive: true });
  await writeFile(
    join(dashboard.root, "pi", "settings.json"),
    JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } })
  );
  await createUpgradeTask(dashboard, "p46-upgrade-task", CAPTURE_PROMPT, after);
  const run = await fetch(`${dashboard.base}/api/tasks/p46-upgrade-task/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: CAPTURE_PROMPT })
  });
  if (run.status !== 202) throw new Error(`Main run was not accepted: ${run.status}`);
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const detail = await (await fetch(`${dashboard.base}/api/tasks/p46-upgrade-task`)).json();
    if (!detail.runtime.active) {
      if (detail.task.status !== "completed") throw new Error(`Main did not complete: ${detail.task.status}`);
      if (requests.length !== 1) throw new Error(`Expected one standard request, saw ${requests.length}`);
      return requests[0];
    }
    await delay(50);
  }
  throw new Error("The real Main process did not settle");
}

/**
 * Reduce a recorded request to the parts the upgrade must not change:
 * the tool table (names and parameter schemas), the structure of the rendered
 * system prompt, and the request envelope. Paths and prose are excluded because
 * the fixture workspace lives in a temporary directory.
 */
export function summarizeRequest({ path, body }) {
  const system = body.messages.find((message) => message.role === "system");
  return {
    path,
    envelope: {
      keys: Object.keys(body),
      stream: body.stream,
      streamOptions: body.stream_options,
      store: body.store,
      maxCompletionTokens: body.max_completion_tokens,
      messages: body.messages.map((message) => ({
        role: message.role,
        blockTypes:
          typeof message.content === "string" ? ["text"] : message.content.map((block) => block.type)
      }))
    },
    tools: body.tools.map((tool) => ({
      name: tool.function.name,
      parameters: tool.function.parameters
    })),
    systemPrompt: {
      structure: systemPromptStructure(
        typeof system.content === "string" ? system.content : system.content[0].text
      )
    }
  };
}

/** Ordered section boundaries of the rendered system prompt, without prose. */
function systemPromptStructure(prompt) {
  return prompt
    .split("\n")
    .filter((line) => /^<\/?[a-z_]+>$/.test(line) || /^#{1,3} \S/.test(line))
    .map((line) => line.trim());
}

if (process.argv[2] === "--record" && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cleanup = [];
  try {
    const summary = summarizeRequest(
      await captureStandardMainRun({ after: (release) => cleanup.push(release) })
    );
    await writeFile(
      new URL("./fixtures/p46-pi-upgrade-baseline.json", import.meta.url),
      `${JSON.stringify(summary, null, 2)}\n`
    );
  } finally {
    await releaseFixtureResources(cleanup);
  }
}
