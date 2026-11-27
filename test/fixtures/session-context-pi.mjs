import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspaceStore } from "../../dist/src/workspace/workspace-store.js";
import { readFixtureRequestBody } from "../http-request-body-fixture.mjs";
import { protocolStream } from "../model-protocol-fixture.mjs";

const api = "openai-completions";

export { withoutMainState } from "./main-state.mjs";

export const providerText = (body) =>
  body.messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content ?? []).map((part) => part.text ?? "").join("\n")
    )
    .join("\n");

/** The summary a fixture model writes when a window changes, unless a test supplies its own. */
export const FIXTURE_SUMMARY = "FIXTURE_SUMMARY: the earlier window's work.";

const isSummaryRequest = (body) =>
  !body.tools?.length && /handoff summary for an agent/.test(JSON.stringify(body.messages[0] ?? ""));

export async function sessionContextFixture(
  t,
  handle,
  {
    contextWindow = 64000,
    config = {},
    compaction,
    summarize = () => ({ text: `<analysis>notes</analysis><summary>${FIXTURE_SUMMARY}</summary>` })
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "p49-context-"));
  const workspace = join(root, "workspace");
  const project = join(root, "project");
  const sessions = join(root, "sessions");
  const taskId = "context-task";
  const runId = "context-run";
  const requests = [];
  const summaries = [];
  const failures = [];
  let child, childExit;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/chat/completions");
      const body = JSON.parse(await readFixtureRequestBody(req));
      // Summary requests are counted apart, so each test's steps are its agent's turns.
      const summary = isSummaryRequest(body);
      (summary ? summaries : requests).push(body);
      const sequence = summary ? summaries.length : requests.length;
      const {
        usage = 1000,
        error,
        ...reply
      } = summary ? await summarize(body, sequence) : await handle(body, sequence);
      if (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error }));
        return;
      }
      const data = {
        id: "usage",
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: usage, completion_tokens: 10, total_tokens: usage + 10 }
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        protocolStream(api, reply)
          .replaceAll("call_protocol", `call_${sequence}`)
          .replace("data: [DONE]", `data: ${JSON.stringify(data)}\n\ndata: [DONE]`)
      );
    } catch (error) {
      failures.push(error.stack);
      res.writeHead(400, { "content-type": "application/json" });
      res.end('{"error":{"message":"Fixture assertion failed"}}');
    }
  });
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      await childExit;
    }
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await mkdir(project);
  await mkdir(join(root, "pi"));
  await writeFile(join(root, "config.json"), JSON.stringify({ contextWindow, ...config }));
  await writeFile(
    join(root, "pi", "settings.json"),
    JSON.stringify({
      retry: { enabled: false },
      compaction: compaction ?? { enabled: false }
    })
  );
  const store = new LocalWorkspaceStore(workspace);
  await store.createTask(taskId, { projectDirectory: project });
  await store.createRun(taskId, runId);
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(FORMICAND_|FORMICAND_|PI_|OPENAI_|ANTHROPIC_)/.test(name)
    )
  );
  const env = {
    ...inherited,
    FORMICAND_HOME: join(root, "formicand"),
    FORMICAND_CONFIG: join(root, "config.json"),
    FORMICAND_WORKSPACE: workspace,
    FORMICAND_PROJECT_DIR: project,
    FORMICAND_TASK_ID: taskId,
    FORMICAND_RUN_ID: runId,
    FORMICAND_GLOBAL_INDEX: join(root, "workspaces.json"),
    FORMICAND_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
    FORMICAND_API_KEY: "session-context-fixture",
    FORMICAND_MODEL: "protocol-fixture",
    FORMICAND_MODEL_API: api,
    FORMICAND_DASHBOARD_URL: "",
    FORMICAND_DISABLE_MAIN_GUARDIAN: "1",
    FORMICAND_DISABLE_SESSION_TITLES: "1",
    FORMICAND_REASONING_EFFORT: "off",
    FORMICAND_SUPPORTS_REASONING_EFFORT: "0",
    FORMICAND_WEB_TOOLS: "0",
    PI_CODING_AGENT_DIR: join(root, "pi"),
    PI_OFFLINE: "1"
  };
  const sessionFile = async () => {
    const files = (await readdir(sessions)).filter((file) => file.endsWith(".jsonl"));
    assert.equal(files.length, 1);
    return join(sessions, files[0]);
  };
  const history = async () =>
    (await readFile(await sessionFile(), "utf8")).trimEnd().split("\n").map(JSON.parse);
  const launch = async (prompt, { resume = false, launchEnv = {}, args = [] } = {}) => {
    child = spawn(
      process.execPath,
      [
        "scripts/start-pi.mjs",
        "--print",
        "--mode",
        "json",
        "--session-dir",
        sessions,
        ...(resume ? ["--session", await sessionFile()] : []),
        ...args,
        prompt
      ],
      { env: { ...env, ...launchEnv }, detached: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    childExit = once(child, "exit");
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.setEncoding("utf8").on("data", (chunk) => {
        output = (output + chunk).slice(-20_000);
      });
    const [code] = await childExit;
    assert.deepEqual(failures, [], output.slice(-2000));
    assert.equal(code, 0, output.slice(-3000));
    return output;
  };
  return {
    root,
    workspace,
    project,
    sessions,
    taskId,
    runId,
    requests,
    summaries,
    launch,
    history,
    sessionFile,
    store
  };
}
