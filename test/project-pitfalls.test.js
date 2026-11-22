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
import { pitfallAnchor, pitfallProblems } from "../dist/src/domain/pitfall-entries.js";

const run = promisify(execFile);
const git = (cwd, args) => run("git", args, { cwd });

async function repository(root, files) {
  const directory = join(root, "repository");
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.email", "fixture@example.test"]);
  await git(directory, ["config", "user.name", "Fixture"]);
  // The document registry every requirement merge checks.
  await writeFile(
    join(directory, "AGENTS.md"),
    "## 文档\n\n| 路径 | 类型 | 领域 |\n| --- | --- | --- |\n| AGENTS.md | instructions | global |\n"
  );
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

const entry = (fields = {}) =>
  [
    "## 合入检查在组合版本上运行",
    "",
    `- **Trigger:** ${fields.trigger ?? "合入检查读取候选里才有的文件。"}`,
    "- **What happens:** 目标分支与候选组合后文件不同，检查失败。",
    "- **Confirm:** 在组合版本上运行同一检查命令。",
    "- **Avoid：** 检查只读组合版本里的文件。",
    `- **Sources:** ${fields.sources ?? "分页修复，2026-11-22"}`,
    ""
  ].join("\n");
const indexFor = (anchor) =>
  `# Pitfalls\n\n| Trigger | Entry |\n| --- | --- |\n| 合入检查 | [组合版本](merge.md#${anchor}) |\n`;

test("pitfall entries keep five short fields, no run details, and a row in the index", () => {
  const anchor = pitfallAnchor("合入检查在组合版本上运行");
  assert.deepEqual(pitfallProblems({ "merge.md": entry() }, indexFor(anchor)), []);
  assert.deepEqual(
    pitfallProblems({ "merge.md": entry() }, indexFor(encodeURIComponent(anchor))),
    [],
    "an encoded anchor is the same link"
  );
  const one = (page, index = indexFor(anchor)) => pitfallProblems({ "merge.md": page }, index).join("\n");
  assert.match(
    one(entry().replace("- **Confirm:** 在组合版本上运行同一检查命令。\n", "")),
    /须且只能依次写五项/
  );
  assert.match(one(entry({ trigger: "提交 1a2b3c4d 之后失败。" })), /Trigger 含 commit SHA/);
  assert.match(one(entry({ trigger: "读取 /opt/app/list.txt 的文件。" })), /Trigger 含 absolute path/);
  assert.match(one(entry({ trigger: "返修 3 轮后才发现。" })), /Trigger 含 round or test count/);
  assert.match(one(entry({ trigger: "第一句。第二句。第三句。" })), /Trigger 超过两句话/);
  assert.match(one(entry({ sources: "分页修复" })), /Sources 须写需求标题和日期/);
  assert.match(one(entry({ sources: "[复盘](x.md) 2026-11-22" })), /Sources 只写需求标题和日期/);
  assert.match(one(entry(), "# Pitfalls\n"), /索引缺少 merge\.md「合入检查在组合版本上运行」/);
  assert.match(one("# Merge\n", indexFor(anchor)), /在页面里没有对应条目/);
  assert.match(pitfallProblems({ "merge.md": undefined }, indexFor(anchor)).join(), /已删除的 merge\.md/);
  assert.deepEqual(pitfallProblems({ "merge.md": entry() }, undefined), ["缺少索引 README.md"]);
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
        summary: "list 命令的分页从第二页开始错位。"
      });
      const { taskId } = await post("/api/tasks", { goal: name, projectId: project.projectId });
      const tool = createProjectDevelopmentTool({ dashboardUrl: dashboard.base, taskId, token });
      return tool.execute({
        action: "create",
        request: "这个功能",
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
    const requirementIds = new Map();
    const requirement = async (title) => {
      const { requirementId } = (
        await post(`/api/projects/${encodeURIComponent(project.projectId)}/ledger`, {
          action: "create",
          title,
          summary: title
        })
      ).requirement;
      requirementIds.set(title, requirementId);
      return requirementId;
    };
    const { taskId } = await post("/api/tasks", { goal: "复盘", projectId: project.projectId });
    const tool = createProjectDevelopmentTool({ dashboardUrl: dashboard.base, taskId, token });
    const selfChecked = async (title, change) => {
      const { development } = await tool.execute({
        action: "create",
        request: "这个功能",
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
      ledger: { summaryUnchanged: "测试不改现状", history: "测试合入", descriptionUnchanged: true },
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
      ledger: { summaryUnchanged: "测试不改现状", history: "测试合入", descriptionUnchanged: true },
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
    await writeFile(join(noisy.checkout, "docs", "pitfalls", "merge.md"), entry({ sources: "第二项" }));
    await writeFile(
      join(noisy.checkout, PITFALLS_INDEX),
      indexFor(pitfallAnchor("合入检查在组合版本上运行"))
    );
    await git(noisy.checkout, ["add", "."]);
    await git(noisy.checkout, ["commit", "-m", "docs(pitfalls): merge checks"]);
    await assert.rejects(
      tool.execute({
        action: "request_merge",
        developmentId: noisy.developmentId,
        ledger: { summaryUnchanged: "测试不改现状", history: "测试合入", descriptionUnchanged: true },
        mergeChecks,
        retro: { pitfalls: "新增一条：合入检查命令在组合版本上运行" }
      }),
      /坑点格式不符[^]*Sources 须写需求标题和日期/
    );
    await writeFile(
      join(noisy.checkout, "docs", "pitfalls", "merge.md"),
      entry({ sources: "第二项，2026-11-22" })
    );
    await git(noisy.checkout, ["commit", "-am", "docs(pitfalls): date the source"]);
    await assert.rejects(
      tool.execute({
        action: "request_merge",
        developmentId: noisy.developmentId,
        ledger: { summaryUnchanged: "测试不改现状", history: "测试合入", descriptionUnchanged: true },
        mergeChecks,
        retro: { nothing: "没有要记的" }
      }),
      /用 retro\.pitfalls 说明写了哪些坑点/
    );
    const improvement = { title: "合入检查加环境预检", content: "第一条合入检查先确认依赖已装。" };
    const merged = await tool.execute({
      action: "request_merge",
      developmentId: noisy.developmentId,
      ledger: { summaryUnchanged: "测试不改现状", history: "测试合入", descriptionUnchanged: true },
      mergeChecks,
      retro: { pitfalls: "新增一条：合入检查命令在组合版本上运行", improvements: [improvement] }
    });
    assert.equal(merged.merge.state, "merged", JSON.stringify(merged.merge));
    assert.equal(merged.merge.acceptance.retro.signals.failedMerges, 1);
    assert.notEqual(merged.merge.acceptance.approvedCommit, merged.merge.candidate.commit);
    assert.match(await git(directory, ["show", `main:${PITFALLS_INDEX}`]).then((r) => r.stdout), /Pitfalls/);
    const { view } = await tool.execute({ action: "delivery_status", developmentId: noisy.developmentId });
    assert.equal(view.retro.outcome, "pitfalls", "the delivery shows the retro");

    // The retro's environment improvement is a new requirement, and the next step after the merge.
    const [registered] = merged.merge.acceptance.retro.improvements;
    assert.equal(registered.title, improvement.title);
    const { requirement: created } = await post(
      `/api/projects/${encodeURIComponent(project.projectId)}/ledger`,
      {
        action: "get",
        requirementId: registered.requirementId
      }
    );
    assert.deepEqual(created.source, {
      kind: "internal",
      reference: `retro:${requirementIds.get("第二项")}`
    });
    const after = await tool.execute({ action: "get", developmentId: noisy.developmentId });
    assert.match(
      after.next,
      new RegExp(`develop the environment improvements[^]*${registered.requirementId}`)
    );

    // An improvement's own retro keeps pitfalls only.
    const { development: nested } = await tool.execute({
      action: "create",
      request: "这个功能",
      requirementId: registered.requirementId,
      goal: improvement.title,
      completionCriteria: [improvement.title],
      route: "quick"
    });
    await writeFile(join(nested.workspace.directory, "list.txt"), "precheck\n");
    await git(nested.workspace.directory, ["commit", "-am", "precheck"]);
    await tool.execute({
      action: "review_plan",
      developmentId: nested.developmentId,
      channel: "self",
      basis: "小改动自检",
      checks: [{ name: "list", command: "cat list.txt", exitCode: 0, output: "precheck" }]
    });
    await assert.rejects(
      tool.execute({
        action: "request_merge",
        developmentId: nested.developmentId,
        ledger: { summaryUnchanged: "测试不改现状", history: "测试合入", descriptionUnchanged: true },
        mergeChecks,
        retro: { nothing: "没有坑", improvements: [{ title: "再改", content: "再改" }] }
      }),
      /复盘登记的环境改进[^]*不能再登记改进/
    );

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
