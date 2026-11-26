import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createProjectDevelopmentService } from "../dist/src/dashboard/project-development-service.js";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";
import { SqliteDatabase } from "../dist/src/storage/project-data/sqlite-database.js";
import { independentReviewReason, parseReviewRules } from "../dist/src/domain/review-rules.js";

/**
 * Two routes, and when the program, not the model, decides a change needs an
 * independent Reviewer: the paths a project's AGENTS.md lists, or more files
 * than one person checks. A development stored on the old direct route reads
 * as full.
 */

const run = promisify(execFile);
const git = (cwd, args) => run("git", ["-C", cwd, ...args]).then((result) => result.stdout.trim());

async function commit(directory, files, message) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  await git(directory, ["add", "-A"]);
  await git(directory, ["commit", "-m", message]);
}

const AGENTS = [
  "## 文档",
  "",
  "| 路径 | 类型 | 领域 |",
  "| --- | --- | --- |",
  "| docs | product | 文档 |",
  "",
  "## 独立审查",
  "",
  "| 路径 | 原因 |",
  "| --- | --- |",
  "| `src/storage` | 持久格式 |",
  "| `src/*-routes.js` | HTTP 接口 |",
  ""
].join("\n");

test("the review rules name paths and a size, and leave documents to the self check", () => {
  const rules = parseReviewRules(AGENTS);
  assert.deepEqual(rules, [
    { path: "src/storage", reason: "持久格式" },
    { path: "src/*-routes.js", reason: "HTTP 接口" }
  ]);
  assert.deepEqual(parseReviewRules("## 文档\n\n| a | b | c |\n"), [], "no heading, no rules");
  assert.equal(independentReviewReason(rules, ["docs/guide.md", "src/cli.js"]), undefined);
  assert.match(
    independentReviewReason(rules, ["src/storage/db.js"]),
    /src\/storage（持久格式）：src\/storage\/db\.js/
  );
  assert.match(independentReviewReason(rules, ["src/task-routes.js"]), /HTTP 接口/);
  assert.equal(
    independentReviewReason(rules, ["src/nested/task-routes.js"]),
    undefined,
    "* stays in one name"
  );
  const many = Array.from({ length: 50 }, (_, index) => `src/f${index}.js`);
  assert.equal(independentReviewReason([], many), undefined, "size alone never takes a Reviewer");
});

test("a quick change on a listed path cannot rest on Main's own checks", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-lighter-routes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repository");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "fixture@example.test"]);
  await git(repo, ["config", "user.name", "Fixture"]);
  await commit(repo, { "AGENTS.md": AGENTS, "docs/guide.md": "# Guide\n", "src/cli.js": "1\n" }, "baseline");
  const runtime = new ProjectDataRuntime({
    config: { sqlite: { path: join(root, "project-data.sqlite") } },
    configPath: join(root, "config.json"),
    dataRoot: root,
    env: {}
  });
  t.after(() => runtime.close());
  const gateway = await runtime.service();
  const projectId = "project_rules";
  await gateway.ensureProject({
    projectId,
    projectName: "规则",
    projectDirectory: repo,
    backendId: "backend_rules"
  });
  const requirement = await gateway.createRequirement(projectId, { title: "存储", summary: "改存储" });
  const projectInfo = { projectId, projectName: "规则", projectDirectory: repo };
  const service = createProjectDevelopmentService({
    runtime: { service: async () => gateway },
    backendId: "backend_rules",
    developmentRoot: join(root, "development-workspaces"),
    project: async (id) => (id === projectId ? projectInfo : undefined),
    taskProject: async () => projectInfo,
    call: async () => undefined
  });
  await service.setMergeConfig(projectId, { repository: repo, targetBranch: "main" });
  const development = await service.create(projectId, {
    requirementId: requirement.requirementId,
    goal: "改存储",
    completionCriteria: ["存储可用"],
    route: "quick"
  });
  const { developmentId } = development;
  const checkout = development.workspace.directory;
  const self = () =>
    service.setReviewPlan(projectId, {
      developmentId,
      channel: "self",
      basis: "自检",
      checks: [{ name: "存在", command: "true", exitCode: 0, output: "" }]
    });

  // A listed path the target branch changed, merged into the checkout, is not this change's own.
  await commit(repo, { "src/storage/schema.js": "upstream\n" }, "upstream storage");
  await git(checkout, ["merge", "--no-ff", "--no-edit", "main"]);
  await commit(checkout, { "docs/guide.md": "# Guide\n\nMore.\n" }, "docs");
  assert.equal((await self()).channel, "self");

  await commit(checkout, { "src/storage/db.js": "db\n" }, "storage");
  await assert.rejects(self(), {
    code: "independent_review_required",
    message: /须独立审查[^]*src\/storage（持久格式）：src\/storage\/db\.js[^]*channel=independent/
  });
  // The rules are read at the baseline: the change cannot drop its own.
  await commit(
    checkout,
    { "AGENTS.md": "## 文档\n\n| 路径 | 类型 | 领域 |\n| --- | --- | --- |\n| docs | product | 文档 |\n" },
    "drop"
  );
  await assert.rejects(self(), { code: "independent_review_required" });
  const plan = await service.setReviewPlan(projectId, {
    developmentId,
    channel: "independent",
    basis: "存储改动"
  });
  assert.equal(plan.channel, "independent");
});

test("a version 14 database reads its direct developments as full", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-direct-v14-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const open = async () => {
    const runtime = new ProjectDataRuntime({
      config: { sqlite: { path: join(root, "project-data.sqlite") } },
      env: {},
      configPath: join(root, "config.json"),
      dataRoot: root
    });
    return { runtime, service: await runtime.service() };
  };
  const first = await open();
  await first.service.ensureProject({
    projectId: "project_v14",
    projectName: "旧项目",
    projectDirectory: root,
    backendId: "backend_local"
  });
  const requirement = await first.service.createRequirement("project_v14", {
    title: "旧",
    summary: "旧需求"
  });
  await first.runtime.close();

  const database = await SqliteDatabase.open(join(root, "project-data.sqlite"));
  const at = new Date().toISOString();
  await database.execute(
    `INSERT INTO project_data_developments (project_id, development_id, requirement_id, goal, completion_criteria,
       route, status, revision, baseline_branch, baseline_commit, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'direct', 'merged', 1, 'main', ?, ?, ?)`,
    ["project_v14", "development_old", requirement.requirementId, "旧", '["做完"]', "0".repeat(40), at, at]
  );
  // Back to version 15's developments table before claiming that version.
  await database.execute("DROP INDEX project_data_developments_open");
  await database.execute("ALTER TABLE project_data_developments DROP COLUMN status_reason");
  await database.execute("ALTER TABLE project_data_developments DROP COLUMN continues_development_id");
  await database.execute("UPDATE project_data_migrations SET version = 14 WHERE version = 16");
  await database.close();

  const again = await open();
  t.after(() => again.runtime.close());
  assert.equal(again.service.description.schemaVersion, 16);
  const reopened = await SqliteDatabase.open(join(root, "project-data.sqlite"));
  const rows = await reopened.query("SELECT route FROM project_data_developments WHERE development_id = ?", [
    "development_old"
  ]);
  await reopened.close();
  assert.deepEqual(
    rows.map((row) => row.route),
    ["full"]
  );
});
