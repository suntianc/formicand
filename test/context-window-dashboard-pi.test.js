import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { providerText } from "./fixtures/session-context-pi.mjs";

const exec = promisify(execFile);
async function waitFor(read, check, label) {
  for (let i = 0; i < 200; i++) {
    const state = await read();
    if (check(state)) return state;
    await delay(50);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

test(
  "composer command switches the real resident Main with a summary from its model and carries authoritative development records",
  { timeout: 60_000 },
  async (t) => {
    let release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    const ordinary = [];
    const summaries = [];
    const provider = await modelProtocolFixture("openai-completions", async (body) => {
      // A request without tools is a window's summary, not a turn of Main's.
      if (!body.tools?.length) {
        summaries.push(body);
        return { text: `<analysis>a</analysis><summary>MODEL SUMMARY ${summaries.length}</summary>` };
      }
      ordinary.push(body);
      if (ordinary.length === 2) await barrier;
      return { text: `Fixture answer ${ordinary.length}` };
    });
    const dashboard = await startDashboard({
      modelEndpoint: provider.baseUrl,
      defaultProject: false,
      config: { mainIdleTimeoutMs: 2000 }
    });
    const request = async (path, body, code) => {
      const response = await fetch(
        dashboard.base + path,
        body === undefined
          ? undefined
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body)
            }
      );
      const payload = await response.json();
      assert.equal(response.status, code ?? (body === undefined ? 200 : 201), JSON.stringify(payload));
      return payload;
    };
    let taskPath;
    t.after(async () => {
      release();
      try {
        if (taskPath)
          await fetch(dashboard.base + taskPath + "/action", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"action":"cancel"}'
          });
      } finally {
        await dashboard.stop();
        await provider.close();
      }
    });
    const repository = join(dashboard.root, "repository");
    await mkdir(repository);
    await exec("git", ["-C", repository, "init", "-b", "main"]);
    await writeFile(join(repository, "README.md"), "Context fixture\n");
    await exec("git", ["-C", repository, "add", "README.md"]);
    await exec("git", [
      "-C",
      repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "baseline"
    ]);
    const { project } = await request("/api/projects", {
      projectName: "Context fixture",
      projectDirectory: repository
    });
    const projectPath = `/api/projects/${project.projectId}`;
    const { requirement } = await request(projectPath + "/ledger", {
      action: "create",
      title: "Development fixture",
      summary: "Authoritative fixture."
    });
    const { session } = await request(projectPath + "/main-sessions", {
      requirementId: requirement.requirementId
    });
    taskPath = `/api/tasks/${session.taskId}`;
    const { development } = await request(taskPath + "/developments", {
      action: "create",
      requirementId: requirement.requirementId,
      goal: "DURABLE GOAL",
      completionCriteria: ["DURABLE COMPLETION CRITERION"],
      route: "direct"
    });
    await request(
      taskPath + "/developments",
      {
        action: "write_tickets",
        op: "propose",
        developmentId: development.developmentId,
        tickets: [
          {
            ticketId: "01",
            title: "AUTHORITATIVE TICKET",
            scope: ["README.md"],
            criteria: [{ text: "README exists", command: "test -f README.md" }]
          }
        ]
      },
      200
    );
    const next = await request(
      taskPath + "/developments",
      { action: "next", developmentId: development.developmentId },
      200
    );
    const details = () => request(taskPath);
    // The handoffs as Main's session stores them; the browser never receives them.
    const handoffs = async () => {
      const directory = join(dashboard.env.FORMICAND_WORKSPACE, session.taskId, "sessions", "main", "pi");
      const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl"));
      const lines = (await Promise.all(files.map((file) => readFile(join(directory, file), "utf8"))))
        .join("\n")
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      return lines.filter((entry) => entry.type === "compaction").map((entry) => entry.summary);
    };
    await request(taskPath + "/run", { prompt: "Remember this original user request." }, 202);
    await waitFor(
      details,
      ({ messages, runtime }) => !runtime.active && messages.some((message) => message.role === "assistant"),
      "the first reply"
    );
    await request(taskPath + "/action", { action: "compact" }, 202);
    const first = await waitFor(
      details,
      ({ contextWindows }) => contextWindows.length === 1,
      "resident compact"
    );
    assert.equal(ordinary.length, 1);
    assert.equal(first.contextUsage.window, 2);
    for (const text of [
      "Remember this original user request.",
      "DURABLE GOAL",
      "DURABLE COMPLETION CRITERION",
      development.developmentId,
      "Route: direct",
      "01 [draft] AUTHORITATIVE TICKET",
      next.next,
      "MODEL SUMMARY 1"
    ]) {
      assert.ok((await handoffs())[0].includes(text), text);
    }
    assert.equal(first.contextWindows[0].summary, undefined, "the handoff is not sent to the browser");

    await request(taskPath + "/run", { prompt: "One more original instruction." }, 202);
    await waitFor(
      async () => ordinary.length,
      (length) => length === 2,
      "active model request"
    );
    assert.match(providerText(ordinary[1]), /Context window handoff/);
    await request(taskPath + "/action", { action: "compact" }, 202);
    release();
    const second = await waitFor(
      details,
      ({ contextWindows }) => contextWindows.length === 2,
      "window at the in-flight step boundary"
    );
    assert.equal(ordinary.length, 2);
    assert.match((await handoffs())[1], /One more original instruction/);
    assert.ok(!second.messages.some((message) => message.role === "user" && message.content === "/compact"));
    await waitFor(
      details,
      ({ runtime, task }) => !runtime.active && task.status === "completed",
      "Main to settle"
    );

    await waitFor(details, ({ runtime }) => !runtime.mainRunning, "the idle Main to exit");
    await request(taskPath + "/action", { action: "compact" }, 200);
    const offline = await details();
    assert.equal(offline.contextUsage.window, 4);
    assert.equal(offline.contextWindows.length, 3);
    const offlineHandoff = (await handoffs())[2];
    assert.match(offlineHandoff, /DURABLE GOAL/);
    // The Dashboard asks Main's model for the summary of a stored session itself.
    assert.match(offlineHandoff, /MODEL SUMMARY 3/);
    assert.equal(summaries.length, 3);
    assert.equal(ordinary.length, 2, "changing windows starts no turn of Main's");
  }
);
