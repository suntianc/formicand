import {
  beginMessageEditTransaction,
  finishMessageEditTransaction,
  readyMessageEditTransaction,
  recoverMessageEditTransaction,
  rollbackMessageEditTransaction
} from "../dist/src/runtime/main-message-edit-transaction.js";
import {
  MainRequestStore,
  mainRequestPath,
  mainRequestStatePath
} from "../dist/src/storage/main-request-store.js";
import { mainRequestEnvironment } from "../dist/src/runtime/main-request-retry.js";
import { installedPiVersion } from "./pi-version-fixture.mjs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { GlobalProjectCatalog } from "../dist/src/workspace/project-catalog.js";
import { singleConnectionMainModel } from "./role-model-fixture.mjs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  latestEditableMessage,
  prepareMessageEdit,
  readMessageVersions,
  readArchivedMessageVersion,
  messageVersionSummaries,
  alignMessageVersionSession,
  rejectAcceptedMainMessage,
  saveAcceptedMainMessage,
  versionRuntimeEvents
} from "../dist/src/runtime/main-message-edit.js";
import { mainInputPath, saveMainInput } from "../dist/src/runtime/main-continuation.js";
import { queuedUserTurn } from "../dist/src/runtime/queued-user-turn.js";
import { mainContextPaths, persistMainContext } from "../dist/src/runtime/main-context.js";
import { HumanRequestStore } from "../dist/src/runtime/human.js";
import { createDashboardRunService } from "../dist/src/dashboard/run-service.js";
import { readJsonFile } from "../dist/src/dashboard/event-stream.js";

const textMessage = (role, text, timestamp) => ({
  role,
  content: [{ type: "text", text }],
  timestamp,
  ...(role === "assistant"
    ? {
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
        stopReason: "stop",
        usage: {
          input: 1,
          output: 1,
          totalTokens: 2,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 }
        }
      }
    : {})
});
async function fixture(t, first = false) {
  const root = await mkdtemp(join(tmpdir(), "atria-edit-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalWorkspaceStore(root);
  await store.createTask("task", { goal: "old input" });
  const projectDirectory = join(root, "project");
  await mkdir(projectDirectory);
  const catalog = new GlobalProjectCatalog(join(root, "global", "projects.json"));
  const project = await catalog.create({ projectName: "Fixture", projectDirectory });
  await store.updateTask("task", {
    projectId: project.projectId,
    projectCatalogPath: catalog.filePath,
    projectDirectory
  });
  const session = SessionManager.create(root, join(root, "task", "sessions", "main", "pi"));
  const time = Date.now() - 100;
  if (first) session.appendCustomEntry("fixture-settings-before-first-user", { fixture: true });
  if (!first) {
    session.appendMessage(textMessage("user", "prefix question", time - 2));
    session.appendMessage(textMessage("assistant", "prefix response", time - 1));
  }
  const messageId = randomUUID();
  const prompt = "old input\nsecond line";
  session.appendMessage(
    textMessage("user", queuedUserTurn({ taskId: "task", runId: "old-run", messageId, text: prompt }), time)
  );
  session.appendMessage(textMessage("assistant", "old response", time + 1));
  await saveMainInput(mainInputPath(root, "task", "old-run"), {
    version: 1,
    prompt,
    body: prompt,
    messageId,
    source: "composer",
    submittedAt: time
  });
  await persistMainContext(mainContextPaths(root, "task"), session.getBranch());
  const directory = join(root, "task", "runs", "old-run");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "runtime-output.log"),
    [
      {
        type: "message_start",
        message: textMessage(
          "user",
          queuedUserTurn({ taskId: "task", runId: "old-run", messageId, text: prompt }),
          time
        )
      },
      { type: "message_end", message: textMessage("assistant", "old response", time + 1) }
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")
  );
  const latest = await latestEditableMessage(root, "task", "old-run");
  assert.equal(latest.target.messageId, messageId);
  assert.equal(latest.target.body, prompt);
  return {
    root,
    session,
    time,
    latest,
    request: {
      ...Object.fromEntries(
        ["messageId", "versionId", "runId", "scopeToken"].map((key) => [key, latest.target[key]])
      ),
      editId: randomUUID()
    }
  };
}
test("SDK branch retains full prefix, archives old records and resumes only the new version", async (t) => {
  const f = await fixture(t);
  const originalFile = f.session.getSessionFile();
  const originalBytes = await readFile(originalFile, "utf8");
  const branch = await prepareMessageEdit(f.root, "task", f.request, "new input", "new-run");
  const session = SessionManager.open(branch.sessionFile);
  assert.deepEqual(
    session.buildSessionContext().messages.map((message) => message.content[0].text),
    ["prefix question", "prefix response"]
  );
  assert.equal(await readFile(originalFile, "utf8"), originalBytes);
  const versions = await readMessageVersions(f.root, "task");
  assert.equal(
    (await readArchivedMessageVersion(f.root, "task", versions.archives[0].versionId)).messages.at(-1)
      .content[0].text,
    "old response"
  );
  assert.deepEqual(versionRuntimeEvents(f.latest.allEvents, versions), []);
  const duplicate = await prepareMessageEdit(f.root, "task", f.request, "new input", "other-run");
  assert.equal(duplicate.repeatedRunId, "new-run");
  await assert.rejects(
    prepareMessageEdit(f.root, "task", f.request, "different input", "other-run"),
    /其他输入/
  );
});
test("project-folder changes retain the selected version and full prefix, even before assistant output", async (t) => {
  for (const first of [false, true]) {
    const f = await fixture(t, first);
    await prepareMessageEdit(f.root, "task", f.request, "new input", "new-run");
    const versions = await readMessageVersions(f.root, "task");
    const oldBytes = await readFile(versions.sessionFile, "utf8");
    const oldContext = SessionManager.open(versions.sessionFile).buildSessionContext();
    const nextProject = join(f.root, "next-project");
    await mkdir(nextProject);
    const aligned = await alignMessageVersionSession(f.root, "task", nextProject, versions);
    assert.notEqual(aligned.sessionFile, versions.sessionFile);
    assert.equal(aligned.versionId, versions.versionId);
    assert.deepEqual(SessionManager.open(aligned.sessionFile).buildSessionContext(), oldContext);
    assert.equal(await readFile(versions.sessionFile, "utf8"), oldBytes);
    assert.equal((await readMessageVersions(f.root, "task")).sessionFile, aligned.sessionFile);
    assert.equal(
      (await alignMessageVersionSession(f.root, "task", nextProject, aligned)).sessionFile,
      aligned.sessionFile
    );
  }
});

test("multiple edits keep histories associated with their current message", async (t) => {
  const f = await fixture(t);
  const messageId = randomUUID();
  const prepared = await prepareMessageEdit(f.root, "task", f.request, "new input", "new-run", messageId);
  const versions = await readMessageVersions(f.root, "task");
  const history = await readArchivedMessageVersion(f.root, "task", versions.archives[0].versionId);
  assert.equal(versions.archives[0].messages, undefined);
  assert.equal(messageVersionSummaries(versions)[0].currentMessageId, messageId);
  assert.equal(messageVersionSummaries(versions)[0].runtimeEvents, undefined);
  const session = SessionManager.open(prepared.sessionFile);
  const time = Date.now();
  session.appendMessage(
    textMessage(
      "user",
      queuedUserTurn({ taskId: "task", runId: "new-run", messageId, text: "new input" }),
      time
    )
  );
  session.appendMessage(textMessage("assistant", "new response", time + 1));
  await saveMainInput(mainInputPath(f.root, "task", "new-run"), {
    version: 1,
    prompt: "new input",
    body: "new input",
    submittedAt: time,
    messageId,
    source: "composer"
  });
  await finishMessageEditTransaction(f.root, "task");
  const latest = await latestEditableMessage(f.root, "task", "new-run");
  const replacementId = randomUUID();
  await prepareMessageEdit(
    f.root,
    "task",
    { ...latest.target, editId: randomUUID() },
    "second edit",
    "second-run",
    replacementId
  );
  const updated = await readMessageVersions(f.root, "task");
  assert.equal(updated.archives.length, 2);
  assert.ok(
    updated.archives.every(
      (value) => value.currentMessageId === replacementId && !value.messages && value.historyFile
    )
  );
  assert.equal(updated.archives[0].groupId, updated.archives[1].groupId);
  assert.deepEqual(await readArchivedMessageVersion(f.root, "task", updated.archives[0].versionId), history);
});

test("editing the first turn creates an empty model prefix and preserves old session", async (t) => {
  const f = await fixture(t, true);
  const originalFile = f.session.getSessionFile();
  const branch = await prepareMessageEdit(f.root, "task", f.request, "replacement", "new-run");
  assert.deepEqual(SessionManager.open(branch.sessionFile).buildSessionContext().messages, []);
  assert.match(await readFile(originalFile, "utf8"), /old response/);
});
test("stale message or version cannot branch, and internal/human inputs are not editable", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepareMessageEdit(f.root, "task", { ...f.request, messageId: "assistant-id" }, "replacement", "new-run"),
    /消息或会话版本/
  );
  assert.equal(await readMessageVersions(f.root, "task"), undefined);
  const answered = "answer to internal question";
  f.session.appendMessage(textMessage("user", answered, f.time + 3));
  await saveMainInput(mainInputPath(f.root, "task", "human-run"), {
    version: 1,
    prompt: answered,
    source: "human",
    submittedAt: f.time + 3
  });
  const latest = await latestEditableMessage(f.root, "task", "human-run");
  assert.equal(latest.target.messageId, f.request.messageId);
  assert.equal(latest.target.runId, "human-run");
});

test("accepted composer identity survives a human resume overwriting the Run input slot", async (t) => {
  const f = await fixture(t);
  const input = JSON.parse(await readFile(mainInputPath(f.root, "task", "old-run"), "utf8"));
  await saveAcceptedMainMessage(f.root, "task", input);
  f.session.appendMessage(textMessage("user", "internal human answer", f.time + 3));
  await saveMainInput(mainInputPath(f.root, "task", "old-run"), {
    version: 1,
    prompt: "internal human answer",
    source: "human",
    submittedAt: f.time + 3
  });
  const latest = await latestEditableMessage(f.root, "task", "old-run");
  assert.equal(latest.target.messageId, f.request.messageId);
  assert.equal(latest.target.body, "old input\nsecond line");
});

test("scope changes reject stale editing without altering the original session", async (t) => {
  const f = await fixture(t);
  const changed = join(f.root, "changed-project");
  await mkdir(changed);
  const store = new LocalWorkspaceStore(f.root);
  const projectId = (await store.readTask("task")).projectId;
  const catalog = new GlobalProjectCatalog(join(f.root, "global", "projects.json"));
  await catalog.update(projectId, { projectDirectory: changed }, (_previous, _next, commit) => commit([]));
  await assert.rejects(prepareMessageEdit(f.root, "task", f.request, "replacement", "new-run"), /会话版本/);
  assert.equal(await readMessageVersions(f.root, "task"), undefined);
});

test("a pre-spawn rollback anchors the source session and restores its private retry record", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "task", "sessions", "main", "request-retry.json");
  await writeFile(path, "private original retry bytes");
  const edit = await prepareMessageEdit(f.root, "task", f.request, "replacement", "new-run");
  await rm(path);
  await edit.rollback();
  const versions = await readMessageVersions(f.root, "task");
  assert.equal(versions.sessionFile, f.session.getSessionFile());
  assert.equal(versions.archives.length, 0);
  assert.equal(await readFile(path, "utf8"), "private original retry bytes");
  const latest = await latestEditableMessage(f.root, "task", "old-run");
  assert.equal(latest.target.messageId, f.request.messageId);
});

test("editing retires only unresolved questions from the replaced tail and rollback restores them", async (t) => {
  const f = await fixture(t);
  const human = new HumanRequestStore(f.root);
  const create = (question, runId = "old-run") => human.create({ taskId: "task", runId, question });
  const pending = await create("pending tail");
  const unanswered = await create("unanswered tail");
  await human.markUnanswered("task", unanswered.requestId);
  const answered = await create("answered tail");
  await human.submitAnswer("task", answered.requestId, "accepted decision");
  const cancelled = await create("cancelled tail");
  await human.cancel("task", cancelled.requestId);
  const unrelated = await create("another run", "other-run");
  const prefix = await create("prefix question");
  await writeFile(
    join(f.root, "task", "human", "requests", `${prefix.requestId}.json`),
    JSON.stringify({ ...prefix, createdAt: new Date(f.time - 10).toISOString() })
  );
  const edit = await prepareMessageEdit(f.root, "task", f.request, "replacement", "new-run");
  for (const request of [pending, unanswered]) {
    assert.equal((await human.read("task", request.requestId)).status, "cancelled");
    await human.restoreSuperseded("task", request.requestId, "another-edit-run");
    assert.equal((await human.read("task", request.requestId)).status, "cancelled");
    await assert.rejects(human.submitAnswer("task", request.requestId, "late decision"), /cancelled/);
  }
  assert.equal((await human.read("task", prefix.requestId)).status, "pending");
  assert.equal((await human.read("task", unrelated.requestId)).status, "pending");
  assert.equal((await human.read("task", answered.requestId)).answer, "accepted decision");
  assert.equal((await human.read("task", cancelled.requestId)).status, "cancelled");
  await edit.rollback();
  assert.equal((await human.read("task", pending.requestId)).status, "pending");
  assert.equal((await human.read("task", unanswered.requestId)).status, "unanswered");
  assert.equal((await human.read("task", cancelled.requestId)).status, "cancelled");
  assert.equal(
    (await human.submitAnswer("task", pending.requestId, "restored decision")).request.answer,
    "restored decision"
  );
});

for (const reason of ["persistence failure", "unrelated pending question"]) {
  test(`rejected edit startup restores old questions after ${reason}`, async (t) => {
    const f = await fixture(t);
    const store = new LocalWorkspaceStore(f.root);
    await store.updateTask("task", { activeRunId: "old-run" });
    await store.transitionTask("task", "running", { runId: "old-run" });
    await store.transitionTask("task", "waiting", { runId: "old-run" });
    const human = new HumanRequestStore(f.root);
    const pending = await human.create({ taskId: "task", runId: "old-run", question: "Old tail" });
    if (reason === "unrelated pending question")
      await human.create({ taskId: "task", runId: "another-run", question: "Unrelated decision" });
    const service = createDashboardRunService({
      projectRoot: f.root,
      tabStorePath: join(f.root, "tabs.json"),
      dashboardUrl: "http://127.0.0.1:1",
      coordinator: {},
      locateTask: async () => ({ workspaceRoot: f.root, store, task: await store.readTask("task") }),
      resolveMainModel: singleConnectionMainModel(),
      normalizeModel: () => "fixture",
      appendRunEvent: async () => {
        throw new Error("isolated persistence failure");
      },
      readJsonFile
    });
    t.after(() => service.stop());
    await assert.rejects(
      service.editMainMessage("task", f.request, "replacement", []),
      reason === "persistence failure" ? /isolated persistence failure/ : /请先回答/
    );
    assert.equal(service.activeRuns.size, 0);
    assert.equal((await store.readTask("task")).activeRunId, "old-run");
    assert.equal((await store.readTask("task")).status, "waiting");
    assert.equal((await human.read("task", pending.requestId)).status, "pending");
    assert.equal(
      (await latestEditableMessage(f.root, "task", "old-run")).target.messageId,
      f.request.messageId
    );
    assert.equal((await readMessageVersions(f.root, "task")).archives.length, 0);
  });
}

test("rejected pre-spawn edit remains rejected after rollback and reopening real stores", async (t) => {
  const f = await fixture(t);
  const old = JSON.parse(await readFile(mainInputPath(f.root, "task", "old-run"), "utf8"));
  await saveAcceptedMainMessage(f.root, "task", { ...old, taskId: "task", runId: "old-run" });
  const prepared = await prepareMessageEdit(f.root, "task", f.request, "replacement", "new-run");
  const next = {
    ...old,
    prompt: "replacement",
    body: "replacement",
    taskId: "task",
    runId: "new-run",
    messageId: randomUUID(),
    submittedAt: old.submittedAt + 10
  };
  await saveMainInput(mainInputPath(f.root, "task", "new-run"), next);
  await saveAcceptedMainMessage(f.root, "task", next);
  await writeFile(
    join(f.root, "task", "runs", "new-run", "run_events.jsonl"),
    JSON.stringify({
      type: "main.run_waiting",
      taskId: "task",
      runId: "new-run",
      payload: { reason: "desktop_shutdown_before_spawn" }
    }) + "\n"
  );
  await rejectAcceptedMainMessage(f.root, "task", next.messageId);
  await prepared.rollback();
  const latest = await latestEditableMessage(f.root, "task", "old-run");
  assert.equal(latest?.target.messageId, f.request.messageId);
  assert.equal(latest?.target.body, old.body);
  assert.equal(
    JSON.parse(await readFile(mainInputPath(f.root, "task", "new-run"), "utf8")).messageId,
    next.messageId
  );
  assert.equal(
    JSON.parse(
      await readFile(
        join(f.root, "task", "sessions", "main", "user-inputs", `${next.messageId}.json`),
        "utf8"
      )
    ).accepted,
    false
  );
});

async function childProcess(code, killAtReady = false) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "",
    errors = "";
  child.stderr.on("data", (bytes) => {
    errors += bytes;
  });
  child.stdout.on("data", (bytes) => {
    output += bytes;
    if (killAtReady && output.includes("READY_TO_KILL")) child.kill("SIGKILL");
  });
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => {
      if (killAtReady ? signal === "SIGKILL" : status === 0) resolve();
      else reject(new Error(`child failed ${status}/${signal}: ${errors}`));
    });
  });
  return output;
}
for (const stage of ["prepared", "input", "task", "launch_ready"]) {
  test(`SIGKILL at edit transaction ${stage} recovers consistently in a fresh runtime`, async (t) => {
    const f = await fixture(t);
    const store = new LocalWorkspaceStore(f.root);
    await store.updateTask("task", { activeRunId: "old-run", model: "old-model", goal: "old-goal" });
    await store.transitionTask("task", "running", { runId: "old-run" });
    await store.transitionTask("task", "failed", { runId: "old-run" });
    const old = JSON.parse(await readFile(mainInputPath(f.root, "task", "old-run"), "utf8"));
    await saveAcceptedMainMessage(f.root, "task", { ...old, taskId: "task", runId: "old-run" });
    const retry = join(f.root, "task", "sessions", "main", "request-retry.json");
    await writeFile(retry, "OLD_EXACT_RETRY_BYTES");
    const context = mainContextPaths(f.root, "task");
    const beforeContext = await readFile(context.state, "utf8");
    const original = await readFile(f.session.getSessionFile(), "utf8");
    const human = new HumanRequestStore(f.root);
    const pending = await human.create({
      taskId: "task",
      runId: "old-run",
      question: "Pending old question"
    });
    const unanswered = await human.create({
      taskId: "task",
      runId: "old-run",
      question: "Unanswered old question"
    });
    await human.markUnanswered("task", unanswered.requestId);
    const moduleUrl = (path) => JSON.stringify(pathToFileURL(resolve(path)).href);
    const common = `
      import { prepareMessageEdit, saveAcceptedMainMessage } from ${moduleUrl("dist/src/runtime/main-message-edit.js")};
      import { readyMessageEditTransaction, recoverMessageEditTransaction } from ${moduleUrl("dist/src/runtime/main-message-edit-transaction.js")};
      import { saveMainInput, mainInputPath } from ${moduleUrl("dist/src/runtime/main-continuation.js")};
      import { LocalWorkspaceStore } from ${moduleUrl("dist/src/workspace/workspace-store.js")};
      import { createWorkspaceDirectory } from ${moduleUrl("dist/src/dashboard/workspace-directory.js")};
      import { rm } from "node:fs/promises";
      const root = ${JSON.stringify(f.root)};
    `;
    const input = {
      ...old,
      prompt: "edited body",
      body: "edited body",
      taskId: "task",
      runId: "new-run",
      messageId: randomUUID(),
      submittedAt: Date.now()
    };
    await childProcess(
      common +
        `
      await prepareMessageEdit(root, "task", ${JSON.stringify(f.request)}, "edited body", "new-run");
      if (${JSON.stringify(stage)} !== "prepared") {
        const input = ${JSON.stringify(input)};
        await saveMainInput(mainInputPath(root, "task", "new-run"), input);
        await saveAcceptedMainMessage(root, "task", input);
      }
      if (["task", "launch_ready"].includes(${JSON.stringify(stage)})) {
        const store = new LocalWorkspaceStore(root);
        await rm(${JSON.stringify(retry)}, { force: true });
        await store.transitionTask("task", "running", { runId: "new-run" });
        await store.updateTask("task", { activeRunId: "new-run", goal: "edited goal", model: "new-model" });
        await store.createRun("task", "new-run");
      }
      if (${JSON.stringify(stage)} === "launch_ready") await readyMessageEditTransaction(root, "task");
      console.log("READY_TO_KILL");
      setInterval(() => {}, 1000);
    `,
      true
    );
    await childProcess(
      common +
        'const directory = createWorkspaceDirectory(root, root + "/global/workspaces.json", () => undefined); await directory.locateTask("task");'
    );
    const restored = await store.readTask("task");
    assert.equal(await readFile(f.session.getSessionFile(), "utf8"), original);
    if (stage === "launch_ready") {
      assert.equal((await human.read("task", pending.requestId)).status, "cancelled");
      assert.equal((await human.read("task", unanswered.requestId)).status, "cancelled");
      assert.equal(restored.activeRunId, "new-run");
      assert.equal(restored.status, "waiting");
      assert.equal(restored.model, "new-model");
      assert.equal((await readMessageVersions(f.root, "task")).edits[0].editId, f.request.editId);
      assert.equal(
        JSON.parse(
          await readFile(
            join(f.root, "task", "sessions", "main", "user-inputs", `${input.messageId}.json`),
            "utf8"
          )
        ).accepted,
        true
      );
      await assert.rejects(readFile(retry), { code: "ENOENT" });
    } else {
      assert.equal((await human.read("task", pending.requestId)).status, "pending");
      assert.equal((await human.read("task", unanswered.requestId)).status, "unanswered");
      assert.equal(restored.activeRunId, "old-run");
      assert.equal(restored.status, "failed");
      assert.equal(restored.goal, "old-goal");
      assert.equal(restored.model, "old-model");
      assert.equal(await readFile(retry, "utf8"), "OLD_EXACT_RETRY_BYTES");
      assert.equal(await readFile(context.state, "utf8"), beforeContext);
      assert.equal(
        (await latestEditableMessage(f.root, "task", "old-run")).target.messageId,
        f.request.messageId
      );
    }
    await childProcess(common + 'await recoverMessageEditTransaction(root, "task");');
    assert.deepEqual(await store.readTask("task"), restored);
  });
}

test("editing archives a merged v1 request snapshot that independently passes validation and rollback restores both base and sidecar", async (t) => {
  const f = await fixture(t);
  const project = join(f.root, "project");
  await mkdir(project, { recursive: true });
  const env = await mainRequestEnvironment(f.root, "task", project);
  const reqStore = new MainRequestStore(mainRequestPath(f.root, "task"), "task");
  await reqStore.begin({
    runId: "old-run",
    requestId: "req-before-edit",
    model: {
      id: "gpt-test",
      name: "gpt-test",
      api: "openai-completions",
      provider: "local",
      baseUrl: "http://127.0.0.1:41234/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096
    },
    context: { systemPrompt: "sys", messages: [{ role: "user", content: "old", timestamp: f.time }] },
    environment: { projectDirectory: env.projectDirectory },
    executionScope: env.executionScope,
    endpoint: "http://127.0.0.1:41234/v1/chat/completions",
    piVersion: installedPiVersion,
    body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "old" }] })
  });
  await reqStore.settle("req-before-edit", "completed");
  const baseBefore = await readFile(reqStore.filePath, "utf8");
  const sidecarBefore = await readFile(reqStore.statePath, "utf8");

  const edit = await prepareMessageEdit(f.root, "task", f.request, "replacement", "new-run");
  const versions = await readMessageVersions(f.root, "task");
  const archivePath = versions.archives[0].retrySnapshotPath;
  const archived = await new MainRequestStore(archivePath, "task").read();
  assert.equal(archived.requestId, "req-before-edit");
  assert.equal(archived.state, "completed");

  await reqStore.clear();
  await edit.rollback();
  assert.equal(await readFile(reqStore.filePath, "utf8"), baseBefore);
  assert.equal(await readFile(reqStore.statePath, "utf8"), sidecarBefore);
  assert.equal((await reqStore.read()).state, "completed");
});

test("legacy 5-path edit transaction rolls back cleanly and clears extraneous sidecar", async (t) => {
  const f = await fixture(t);
  const txPath = join(f.root, "task", "sessions", "main", "edit-transaction.json");
  const reqPath = mainRequestPath(f.root, "task");
  const statePath = mainRequestStatePath(f.root, "task");
  const context = mainContextPaths(f.root, "task");
  await writeFile(reqPath, "LEGACY_BASE_BYTES");
  await writeFile(statePath, "EXTRANEOUS_SIDECAR");
  const legacyTx = {
    version: 1,
    taskId: "task",
    runId: "new-run",
    phase: "prepared",
    intent: { editId: f.request.editId, prompt: "replacement" },
    before: [
      {
        path: join(f.root, "task", "task.json"),
        bytes: await readFile(join(f.root, "task", "task.json"), "utf8")
      },
      { path: join(f.root, "task", "sessions", "main", "versions.json"), bytes: null },
      { path: context.messages, bytes: await readFile(context.messages, "utf8") },
      { path: context.state, bytes: await readFile(context.state, "utf8") },
      { path: reqPath, bytes: "LEGACY_BASE_BYTES" }
    ]
  };
  await writeFile(txPath, JSON.stringify(legacyTx));
  await writeFile(reqPath, "MUTATED_BASE");
  await assert.equal(await recoverMessageEditTransaction(f.root, "task"), true);
  assert.equal(await readFile(reqPath, "utf8"), "LEGACY_BASE_BYTES");
  await assert.rejects(readFile(statePath), { code: "ENOENT" });
  await assert.rejects(readFile(txPath), { code: "ENOENT" });
});

test("6-path edit transactions recover by phase (prepared & launch_ready) before downgrade without active transaction leftover", async (t) => {
  for (const phase of ["prepared", "launch_ready"]) {
    await t.test(phase, async (t) => {
      const f = await fixture(t);
      const store = new LocalWorkspaceStore(f.root);
      await store.updateTask("task", { activeRunId: "old-run", model: "old-model", goal: "old-goal" });
      await store.transitionTask("task", "running", { runId: "old-run" });
      await store.transitionTask("task", "failed", { runId: "old-run" });
      const old = JSON.parse(await readFile(mainInputPath(f.root, "task", "old-run"), "utf8"));
      await saveAcceptedMainMessage(f.root, "task", { ...old, taskId: "task", runId: "old-run" });
      const reqPath = mainRequestPath(f.root, "task");
      const statePath = mainRequestStatePath(f.root, "task");
      await writeFile(reqPath, "V1_BASE_ONLY");
      await assert.rejects(readFile(statePath), { code: "ENOENT" });
      await prepareMessageEdit(f.root, "task", f.request, "edited", "new-run");
      const txPath = join(f.root, "task", "sessions", "main", "edit-transaction.json");
      const tx = JSON.parse(await readFile(txPath, "utf8"));
      assert.equal(tx.before.length, 6);
      assert.equal(tx.before[5].path, statePath);
      assert.equal(tx.before[5].bytes, null);
      if (phase === "launch_ready") {
        const input = {
          ...old,
          prompt: "edited",
          body: "edited",
          taskId: "task",
          runId: "new-run",
          messageId: randomUUID(),
          submittedAt: Date.now()
        };
        await saveMainInput(mainInputPath(f.root, "task", "new-run"), input);
        await saveAcceptedMainMessage(f.root, "task", input);
        await store.transitionTask("task", "running", { runId: "new-run" });
        await store.updateTask("task", { activeRunId: "new-run" });
        await readyMessageEditTransaction(f.root, "task");
      }
      // Recover in a fresh process (outside this process's live transaction set).
      const modUrl = JSON.stringify(
        pathToFileURL(resolve("dist/src/runtime/main-message-edit-transaction.js")).href
      );
      await childProcess(
        `import { recoverMessageEditTransaction } from ${modUrl}; const recovered = await recoverMessageEditTransaction(${JSON.stringify(f.root)}, "task"); if (!recovered) throw new Error("expected recovery");`
      );
      await assert.rejects(readFile(txPath), { code: "ENOENT" });
      await assert.rejects(readFile(statePath), { code: "ENOENT" });
      const archivedTx = JSON.parse(
        await readFile(join(f.root, "task", "sessions", "main", "edit-transaction-new-run.json"), "utf8")
      );
      assert.equal(archivedTx.phase, phase);
      const after = await store.readTask("task");
      if (phase === "prepared") {
        assert.equal(after.activeRunId, "old-run");
        assert.equal(after.status, "failed");
        assert.equal(await readFile(reqPath, "utf8"), "V1_BASE_ONLY");
      } else {
        assert.equal(after.activeRunId, "new-run");
        assert.equal(after.status, "waiting");
      }
    });
  }
});

test(
  "concurrent settle() interleaving with edit transaction begin/rollback never deadlocks or tears the pair",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const project = join(f.root, "project");
    await mkdir(project, { recursive: true });
    const env = await mainRequestEnvironment(f.root, "task", project);
    const reqStore = new MainRequestStore(mainRequestPath(f.root, "task"), "task");
    const baseInput = {
      runId: "old-run",
      model: {
        id: "gpt-test",
        name: "gpt-test",
        api: "openai-completions",
        provider: "local",
        baseUrl: "http://127.0.0.1:41234/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096
      },
      context: { systemPrompt: "sys", messages: [{ role: "user", content: "old", timestamp: f.time }] },
      environment: { projectDirectory: env.projectDirectory },
      executionScope: env.executionScope,
      endpoint: "http://127.0.0.1:41234/v1/chat/completions",
      piVersion: installedPiVersion,
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "old" }] })
    };
    for (let round = 0; round < 5; round++) {
      const reqId = `req-interleave-${round}`;
      await reqStore.begin({ ...baseInput, requestId: reqId });
      await Promise.all([
        reqStore.settle(reqId, "completed"),
        beginMessageEditTransaction(
          f.root,
          "task",
          `edit-run-${round}`,
          {
            version: 1,
            taskId: "task",
            versionId: "v0",
            sessionFile: f.session.getSessionFile(),
            excludedRuns: [],
            prefixEvents: [],
            archives: [],
            edits: []
          },
          { editId: randomUUID(), prompt: "p" }
        )
      ]);
      const tx = JSON.parse(
        await readFile(join(f.root, "task", "sessions", "main", "edit-transaction.json"), "utf8")
      );
      const baseEntry = tx.before[4];
      const sidecarEntry = tx.before[5];
      assert.ok(baseEntry.bytes !== null);
      if (sidecarEntry.bytes !== null) {
        assert.equal(JSON.parse(sidecarEntry.bytes).snapshotChecksum, JSON.parse(baseEntry.bytes).checksum);
      }
      await Promise.all([reqStore.settle(reqId, "failed"), rollbackMessageEditTransaction(f.root, "task")]);
      // After both settle and rollback finish, store.read() must stay valid and never throw corruption.
      const finalSnapshot = await reqStore.read();
      assert.equal(finalSnapshot.requestId, reqId);
      assert.ok(["pending", "completed", "failed"].includes(finalSnapshot.state));
    }
  }
);

test("edit transaction rollback refuses to archive the journal when directory sync fails during restoration", async (t) => {
  if (process.platform === "win32") return;
  const f = await fixture(t);
  const reqPath = mainRequestPath(f.root, "task");
  await writeFile(reqPath, "BEFORE_ROLLBACK_BYTES");
  await beginMessageEditTransaction(
    f.root,
    "task",
    "rollback-sync-run",
    {
      version: 1,
      taskId: "task",
      versionId: "v0",
      sessionFile: f.session.getSessionFile(),
      excludedRuns: [],
      prefixEvents: [],
      archives: [],
      edits: []
    },
    { editId: randomUUID(), prompt: "p" }
  );
  await writeFile(reqPath, "MUTATED_BYTES");
  const modUrl = JSON.stringify(
    pathToFileURL(resolve("dist/src/runtime/main-message-edit-transaction.js")).href
  );
  const txPath = join(f.root, "task", "sessions", "main", "edit-transaction.json");
  const sessionsDir = join(f.root, "task", "sessions", "main");
  const output = await childProcess(`
    import fsPromises from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const sessionsDir = ${JSON.stringify(sessionsDir)};
    const txPath = ${JSON.stringify(txPath)};
    let failSync = true;
    const origOpen = fsPromises.open;
    fsPromises.open = async function (p, flags, ...rest) {
      const handle = await origOpen.call(this, p, flags, ...rest);
      if (String(p) === sessionsDir && flags === "r") {
        const origSync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (failSync) {
            const err = new Error("EIO: rollback dir sync failed");
            err.code = "EIO";
            throw err;
          }
          return origSync();
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    const { rollbackMessageEditTransaction } = await import(${modUrl});
    let errorCode = null;
    try {
      await rollbackMessageEditTransaction(${JSON.stringify(f.root)}, "task");
    } catch (err) {
      errorCode = err.code ?? err.message;
    }
    const txStillActive = await fsPromises.readFile(txPath, "utf8").then(() => true, () => false);
    failSync = false;
    await rollbackMessageEditTransaction(${JSON.stringify(f.root)}, "task");
    const txAfterRetry = await fsPromises.readFile(txPath, "utf8").then(() => true, () => false);
    console.log(JSON.stringify({ errorCode, txStillActive, txAfterRetry }));
  `);
  const res = JSON.parse(output.trim());
  assert.equal(res.errorCode, "EIO");
  assert.equal(
    res.txStillActive,
    true,
    "active edit-transaction.json must NOT be archived if restoration sync fails"
  );
  assert.equal(
    res.txAfterRetry,
    false,
    "retry rollback must archive edit-transaction.json after sync succeeds"
  );
  assert.equal(await readFile(reqPath, "utf8"), "BEFORE_ROLLBACK_BYTES");
});
