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

test(
  "a requirement's last merge waits for its retro, and the retro's pitfalls commit merges with it",
  { timeout: 180_000 },
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
    const root = await mkdtemp(join(tmpdir(), "retro-project-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = await repository(root, { "list.txt": "1\n" });
    const { project } = await post("/api/projects", { projectName: "复盘", projectDirectory: directory });
    const requirement = async (title) =>
      (
        await post(`/api/projects/${encodeURIComponent(project.projectId)}/ledger`, {
          action: "create",
          title,
          content: title
        })
      ).requirement.requirementId;
    const { taskId } = await post("/api/tasks", { goal: "复盘", projectId: project.projectId });
    const tool = createProjectDevelopmentTool({ dashboardUrl: dashboard.base, taskId, token });
    const selfChecked = async (title, change) => {
      const { development } = await tool.execute({
        action: "create",
        requirementId: await requirement(title),
        goal: title,
        completionCriteria: [title],
        route: "quick"
      });
      const checkout = development.workspace.directory;
      await writeFile(join(checkout, "list.txt"), change);
      await git(checkout, ["commit", "-am", title]);
      await tool.execute({
        action: "review_plan",
        developmentId: development.developmentId,
        channel: "self",
        basis: "小改动自检",
        checks: [{ name: "list", command: "cat list.txt", exitCode: 0, output: change }]
      });
      return { developmentId: development.developmentId, checkout };
    };
    const mergeChecks = [{ name: "list", command: "test -f list.txt" }];

    // Nothing in the records to look back on: the program records the retro itself.
    const quiet = await selfChecked("第一项", "1\n2\n");
    const plain = await tool.execute({
      action: "request_merge",
      developmentId: quiet.developmentId,
      mergeChecks
    });
    assert.equal(plain.merge.state, "merged", JSON.stringify(plain.merge));
    assert.deepEqual(
      { outcome: plain.merge.acceptance.retro.outcome, auto: plain.merge.acceptance.retro.auto },
      { outcome: "nothing", auto: true }
    );

    // A failed merge is a signal: the next request needs the requirement's retro.
    const noisy = await selfChecked("第二项", "1\n2\n3\n");
    const failed = await tool.execute({
      action: "request_merge",
      developmentId: noisy.developmentId,
      mergeChecks: [{ name: "fails", command: "false" }]
    });
    assert.equal(failed.merge.state, "check_failed");
    const { next } = await tool.execute({ action: "get", developmentId: noisy.developmentId });
    assert.match(next, /load the retro skill[^]*1 failed merges/);
    await assert.rejects(
      tool.execute({ action: "request_merge", developmentId: noisy.developmentId, mergeChecks }),
      /合入前先复盘这个需求[^]*合入失败 1 次/
    );

    // The retro writes its pitfalls on top of the approved version; only that directory may change.
    await mkdir(join(noisy.checkout, "docs", "pitfalls"), { recursive: true });
    await writeFile(join(noisy.checkout, PITFALLS_INDEX), "# Pitfalls\n\n| Trigger | Entry |\n");
    await git(noisy.checkout, ["add", "."]);
    await git(noisy.checkout, ["commit", "-m", "docs(pitfalls): merge checks"]);
    await assert.rejects(
      tool.execute({
        action: "request_merge",
        developmentId: noisy.developmentId,
        mergeChecks,
        retro: { nothing: "没有要记的" }
      }),
      /用 retro\.pitfalls 说明写了哪些坑点/
    );
    const merged = await tool.execute({
      action: "request_merge",
      developmentId: noisy.developmentId,
      mergeChecks,
      retro: { pitfalls: "新增一条：合入检查命令在组合版本上运行" }
    });
    assert.equal(merged.merge.state, "merged", JSON.stringify(merged.merge));
    assert.equal(merged.merge.acceptance.retro.signals.failedMerges, 1);
    assert.notEqual(merged.merge.acceptance.approvedCommit, merged.merge.candidate.commit);
    assert.match(await git(directory, ["show", `main:${PITFALLS_INDEX}`]).then((r) => r.stdout), /Pitfalls/);
    const { view } = await tool.execute({ action: "delivery_status", developmentId: noisy.developmentId });
    assert.equal(view.retro.outcome, "pitfalls", "the delivery shows the retro");

    // Anything outside the pitfalls after approval still voids it.
    const third = await selfChecked("第三项", "1\n2\n3\n4\n");
    await writeFile(join(third.checkout, "list.txt"), "changed after the self-check\n");
    await git(third.checkout, ["commit", "-am", "late change"]);
    await assert.rejects(
      tool.execute({ action: "request_merge", developmentId: third.developmentId, mergeChecks }),
      /self_check_stale/
    );
  }
);
