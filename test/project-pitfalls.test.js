import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { startDashboard } from "./dashboard-fixture.mjs";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";
import { createProjectDevelopmentTool } from "../dist/src/runtime/project-development-tool.js";
import { PITFALLS_INDEX, pitfallsHint } from "../dist/src/runtime/project-pitfalls.js";

const run = promisify(execFile);
const git = (cwd, args) => run("git", args, { cwd });

async function repository(root, files) {
  const directory = join(root, "repository");
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.email", "fixture@example.test"]);
  await git(directory, ["config", "user.name", "Fixture"]);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), text);
  }
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "baseline"]);
  return directory;
}

async function servingToken(root) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const instance = await readBackendInstance(backendPaths(join(root, "home")));
    if (instance.value?.token) return instance.value.token;
    await delay(25);
  }
  assert.fail("the backend did not publish its local credential");
}

test("the pitfalls hint names the index only when the checkout keeps one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pitfalls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await pitfallsHint(root), undefined);
  await mkdir(join(root, PITFALLS_INDEX), { recursive: true });
  assert.equal(await pitfallsHint(root), undefined, "a directory of that name is not an index");
  await rm(join(root, PITFALLS_INDEX), { recursive: true });
  await writeFile(join(root, PITFALLS_INDEX), "# Pitfalls\n");
  assert.match(await pitfallsHint(root), /docs\/pitfalls\/README\.md[^]*the code is right/);
});

test(
  "opening a requirement's checkout tells Main to read the project's pitfalls, and only then",
  { timeout: 120_000 },
  async (t) => {
    const dashboard = await startDashboard({ defaultProject: false });
    t.after(() => dashboard.stop());
    const token = await servingToken(dashboard.root);
    const post = async (path, body) => {
      const response = await fetch(`${dashboard.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const json = await response.json();
      assert.ok(response.ok, `${path} ${response.status} ${JSON.stringify(json)}`);
      return json;
    };
    const open = async (name, files) => {
      const root = await mkdtemp(join(tmpdir(), "pitfalls-project-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const directory = await repository(root, files);
      const { project } = await post("/api/projects", { projectName: name, projectDirectory: directory });
      const { requirement } = await post(`/api/projects/${encodeURIComponent(project.projectId)}/ledger`, {
        action: "create",
        title: "分页修复",
        content: "list 命令的分页从第二页开始错位。"
      });
      const { taskId } = await post("/api/tasks", { goal: name, projectId: project.projectId });
      const tool = createProjectDevelopmentTool({ dashboardUrl: dashboard.base, taskId, token });
      return tool.execute({
        action: "create",
        requirementId: requirement.requirementId,
        goal: "list 分页正确",
        completionCriteria: ["第二页从第 11 条开始"],
        route: "quick"
      });
    };

    const kept = await open("有坑点", {
      "README.md": "# fixture\n",
      [PITFALLS_INDEX]: "# Pitfalls\n\n| Trigger | Entry |\n"
    });
    assert.equal(kept.development.workspace.state, "ready");
    assert.match(kept.pitfalls, /docs\/pitfalls\/README\.md/);

    const none = await open("无坑点", { "README.md": "# fixture\n" });
    assert.equal(none.development.workspace.state, "ready");
    assert.equal("pitfalls" in none, false);
  }
);
