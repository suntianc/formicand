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

export const providerText = (body) =>
  body.messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content ?? []).map((part) => part.text ?? "").join("\n")
    )
    .join("\n");

export async function sessionContextFixture(t, handle, { contextWindow = 64000, compaction } = {}) {
  const root = await mkdtemp(join(tmpdir(), "p49-context-"));
  const workspace = join(root, "workspace");
  const project = join(root, "project");
  const sessions = join(root, "sessions");
  const taskId = "context-task";
  const runId = "context-run";
  const requests = [];
  const failures = [];
  let child, childExit;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/chat/completions");
      const body = JSON.parse(await readFixtureRequestBody(req));
      requests.push(body);
      const sequence = requests.length;
      const { usage = 1000, error, ...reply } = await handle(body, sequence);
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
      child.kill("SIGKILL");
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
  await writeFile(join(root, "config.json"), JSON.stringify({ contextWindow }));
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
    Object.entries(process.env).filter(([name]) => !/^(COWORK_|ATRIA_|PI_|OPENAI_|ANTHROPIC_)/.test(name))
  );
  const env = {
    ...inherited,
    ATRIA_HOME: join(root, "atria"),
    COWORK_CONFIG: join(root, "config.json"),
    COWORK_WORKSPACE: workspace,
    COWORK_PROJECT_DIR: project,
    COWORK_TASK_ID: taskId,
    COWORK_RUN_ID: runId,
    COWORK_GLOBAL_INDEX: join(root, "workspaces.json"),
    COWORK_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
    COWORK_API_KEY: "session-context-fixture",
    COWORK_MODEL: "protocol-fixture",
    COWORK_MODEL_API: api,
    COWORK_DASHBOARD_URL: "",
    COWORK_DISABLE_MAIN_GUARDIAN: "1",
    COWORK_REASONING_EFFORT: "off",
    COWORK_SUPPORTS_REASONING_EFFORT: "0",
    COWORK_WEB_TOOLS: "0",
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
      { env: { ...env, ...launchEnv }, stdio: ["ignore", "pipe", "pipe"] }
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
  return { root, workspace, project, sessions, taskId, runId, requests, launch, history, sessionFile, store };
}
