import { deferCleanup } from "./fixtures/cleanup.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createProjectDevelopmentService } from "../dist/src/dashboard/project-development-service.js";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";
import { prepareWorkItemSite } from "../dist/src/workspace/work-item-workspace.js";
import {
  parseRegistry,
  problemsSince,
  registryProblems,
  tidyDocumentsInput
} from "../dist/src/domain/project-documents.js";

const run = promisify(execFile);
const git = (cwd, args) => run("git", ["-C", cwd, ...args]).then((result) => result.stdout.trim());

const table = (...rows) =>
  [
    "# Agents",
    "",
    "Be brief.",
    "",
    "## 文档",
    "",
    "| 路径 | 类型 | 领域 |",
    "| --- | --- | --- |",
    ...rows,
    ""
  ].join("\n");

test("the registry table parses, and its problems are named", () => {
  const text =
    table("| `docs/adr` | adr | global |", "| README.md | product | global |") + "## Next\n\n| a | b |\n";
  assert.deepEqual(parseRegistry(text).rows, [
    { path: "docs/adr", type: "adr", domain: "global" },
    { path: "README.md", type: "product", domain: "global" }
  ]);
  assert.equal(parseRegistry("# Agents\n"), undefined);
  assert.match(parseRegistry(table("| x.md | notes | global |")).problems.join(), /类型 notes 不在/);

  const documents = ["AGENTS.md", "README.md", "docs/adr/0001-x.md", "docs/pitfalls/README.md", "PLAN.md"];
  const problems = registryProblems(
    table(
      "| docs/adr | adr | global |",
      "| README.md | product | global |",
      "| docs/old.md | product | global |",
      "| docs/api.md | product | global |"
    ),
    documents,
    documents
  );
  assert.deepEqual(problems.unregistered, ["PLAN.md"], "root instructions and pitfalls need no row");
  assert.deepEqual(problems.stale, ["docs/old.md", "docs/api.md"]);
  assert.match(problems.duplicates.join(), /README\.md 与 docs\/old\.md（product\/global）/);
  assert.equal(registryProblems(undefined, documents, documents).missing, true);
});

test("a requirement answers only for the registry problems it brought", () => {
  const registry = table(
    "| README.md | product | global |",
    "| old.md | product | api |",
    "| guide.md | product | ui |"
  );
  const base = registryProblems(registry, ["AGENTS.md", "README.md", "guide.md"], []);
  assert.deepEqual(base.stale, ["old.md"]);
  // Only code changed: the row that went stale before is not this requirement's.
  const unchanged = problemsSince(
    registryProblems(registry, ["AGENTS.md", "README.md", "guide.md"], []),
    base
  );
  assert.deepEqual(unchanged.stale, []);
  // Deleting a registered document but keeping its row is.
  const deleted = problemsSince(registryProblems(registry, ["AGENTS.md", "README.md"], []), base);
  assert.deepEqual(deleted.stale, ["guide.md"]);
});

test("a tidy's verdict on the documents is an update list or a reason", () => {
  assert.deepEqual(tidyDocumentsInput({ unchanged: "只改了内部实现" }), { unchanged: "只改了内部实现" });
  assert.deepEqual(tidyDocumentsInput({ update: [{ path: "README.md", reason: "命令改名" }] }), {
    update: [{ path: "README.md", reason: "命令改名" }]
  });
  assert.equal(tidyDocumentsInput(undefined), undefined);
  assert.throws(() => tidyDocumentsInput({ unchanged: "x", update: [] }), /二选一/);
  assert.throws(() => tidyDocumentsInput({ update: [{ path: "README.md" }] }), /reason/);
});

async function commit(directory, files, message) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  await git(directory, ["add", "-A"]);
  await git(directory, ["commit", "-m", message]);
}

/** A project with documents and no registry, and the program's development service over it. */
async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "registry-project-"));
  deferCleanup(t, () => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repository");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "fixture@example.test"]);
  await git(repo, ["config", "user.name", "Fixture"]);
  await commit(
    repo,
    { "AGENTS.md": "# Agents\n\nBe brief.\n", "README.md": "# fixture\n", "docs/guide.md": "# Guide\n" },
    "baseline"
  );
  const runtime = new ProjectDataRuntime({
    config: { sqlite: { path: join(root, "project-data.sqlite") } },
    configPath: join(root, "config.json"),
    dataRoot: root,
    env: {}
  });
  deferCleanup(t, () => runtime.close());
  const gateway = await runtime.service();
  const projectId = "project_registry";
  await gateway.ensureProject({
    projectId,
    projectName: "登记",
    projectDirectory: repo,
    backendId: "backend_r"
  });
  const info = { projectId, projectName: "登记", projectDirectory: repo };
  const calls = {};
  const developmentRoot = join(root, "development-workspaces");
  const service = createProjectDevelopmentService({
    runtime: { service: async () => gateway },
    backendId: "backend_r",
    developmentRoot,
    project: async (id) => (id === projectId ? info : undefined),
    taskProject: async (id) => (id === "task-r" ? info : undefined),
    call: async (_taskId, callId) => calls[callId]
  });
  await service.setMergeConfig(projectId, { repository: repo, targetBranch: "main" });
  return { repo, gateway, projectId, calls, developmentRoot, service };
}

const ledger = { summaryUnchanged: "测试不改现状", history: "测试合入", descriptionUnchanged: true };

test("a small change is not held to the registry, as in Workloop", { timeout: 60_000 }, async (t) => {
  const { repo, gateway, projectId, service } = await project(t);
  const requirement = await gateway.createRequirement(projectId, { title: "计划", summary: "小改动" });
  const development = await service.create(projectId, {
    requirementId: requirement.requirementId,
    goal: "加一份说明",
    completionCriteria: ["有说明"],
    route: "quick"
  });
  await commit(development.workspace.directory, { "PLAN.md": "# Plan\n" }, "plan");
  await service.setReviewPlan(projectId, {
    developmentId: development.developmentId,
    channel: "self",
    basis: "小改动自检",
    checks: [{ name: "说明", command: "test -f PLAN.md", exitCode: 0, output: "" }]
  });
  const merge = await service.requestMerge(projectId, {
    developmentId: development.developmentId,
    ledger,
    checks: [{ name: "说明", command: "test -f PLAN.md" }]
  });
  assert.equal(merge.state, "merged", JSON.stringify(merge));
  assert.match(await git(repo, ["ls-tree", "-r", "--name-only", "main"]), /PLAN\.md/);
});

test(
  "the full route's final review waits for the registry, built and fixed by fix tickets",
  { timeout: 120_000 },
  async (t) => {
    const { gateway, projectId, calls, developmentRoot, service } = await project(t);
    const requirement = await gateway.createRequirement(projectId, { title: "接口", summary: "两张票" });
    const development = await service.create(projectId, {
      requirementId: requirement.requirementId,
      goal: "接口文档",
      completionCriteria: ["有接口文档"],
      route: "full"
    });
    const { developmentId } = development;
    const integration = development.workspace.directory;
    const passing = [{ name: "存在", command: "ls", exitCode: 0, output: "ok" }];
    const mapping = [{ requirement: "有接口文档", evidence: "test -f docs/api.md" }];
    // One ticket through its review into the requirement checkout, the way p48-ticket-flow does it.
    const deliver = async (ticketId, files) => {
      let set = await service.writeTickets(projectId, developmentId, {
        op: "propose",
        tickets: [
          {
            ticketId,
            title: `票 ${ticketId}`,
            scope: Object.keys(files),
            criteria: Object.keys(files).map((file) => ({ text: `${file} 存在`, command: `test -f ${file}` }))
          }
        ]
      });
      set = await service.writeTickets(projectId, developmentId, {
        op: "confirm",
        expectedRevision: set.revision
      });
      await service.ticketForDispatch("task-r", developmentId, ticketId);
      const callId = `call-e${ticketId}`;
      const directory = join(developmentRoot, "work-items", callId);
      await prepareWorkItemSite({
        developmentDirectory: integration,
        directory,
        branch: `formicand/work/${callId}`
      });
      await service.ticketStarted("task-r", developmentId, ticketId, {
        callId,
        agentId: `agent-${callId}`,
        workspace: directory
      });
      calls[callId] = {
        callId,
        agentId: `agent-${callId}`,
        role: "executor",
        workspace: directory,
        developmentId
      };
      await commit(directory, files, `ticket ${ticketId}`);
      calls[callId].status = "completed";
      const review = await service.startReview(projectId, "task-r", { developmentId, ticketId });
      const reviewerId = `call-r${ticketId}`;
      const site = join(developmentRoot, "work-items", reviewerId);
      await git(integration, ["worktree", "add", "--detach", site, review.candidate.commit]);
      calls[reviewerId] = {
        callId: reviewerId,
        agentId: `agent-${reviewerId}`,
        role: "reviewer",
        workspace: site,
        developmentId,
        status: "completed"
      };
      await service.attachReviewer(projectId, "task-r", { reviewId: review.reviewId, callId: reviewerId });
      await service.completeReview(projectId, {
        reviewId: review.reviewId,
        verdict: "passed",
        summary: "可以",
        checks: passing
      });
      const done = await service.integrateTicket(projectId, {
        developmentId,
        ticketId,
        checks: [{ name: "项目检查", command: "test -f README.md" }]
      });
      assert.equal(done.integrated, true, JSON.stringify(done));
    };
    const freeze = () => service.startReview(projectId, "task-r", { developmentId, mapping });

    await deliver("01", { "docs/api.md": "# API\n" });
    // No registry yet: this requirement builds one, registering every document, before its final review.
    await assert.rejects(freeze(), /还没有文档登记表[^]*修复票/);
    await deliver("02", { "AGENTS.md": table("| README.md | product | global |") });
    await assert.rejects(freeze(), /没有登记：docs\/api\.md、docs\/guide\.md/);
    await deliver("03", {
      "AGENTS.md": table(
        "| README.md | product | global |",
        "| docs/guide.md | product | guide |",
        "| docs/api.md | product | guide |"
      )
    });
    await assert.rejects(freeze(), /同类同领域只许一份：docs\/guide\.md 与 docs\/api\.md/);
    await deliver("04", {
      "AGENTS.md": table(
        "| README.md | product | global |",
        "| docs/guide.md | product | guide |",
        "| docs/api.md | product | api |"
      )
    });
    const final = await freeze();
    assert.equal(final.state, "in_review");
  }
);

test("documents are listed by their raw names, quotes and backslashes included", async (t) => {
  const { documentsAdded, documentsAt } = await import("../dist/src/workspace/development-workspace.js");
  const repo = await mkdtemp(join(tmpdir(), "formicand-doc-names-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const run = (args) =>
    promisify(execFile)("git", ["-C", repo, ...args]).then((result) => result.stdout.trim());
  await run(["init", "-q", "-b", "main"]);
  await run(["config", "user.email", "fixture@example.test"]);
  await run(["config", "user.name", "Fixture"]);
  await writeFile(join(repo, "README.md"), "x\n");
  await run(["add", "."]);
  await run(["commit", "-qm", "base"]);
  const base = await run(["rev-parse", "HEAD"]);
  // Build the Git index directly so raw Git names are covered even on NTFS.
  const blob = await run(["rev-parse", "HEAD:README.md"]);
  for (const name of ['中"文.md', "a\\b.md"])
    await run([
      "-c",
      "core.protectNTFS=false",
      "update-index",
      "--add",
      "--cacheinfo",
      "100644",
      blob,
      `docs/${name}`
    ]);
  await run(["commit", "-qm", "docs"]);
  const head = await run(["rev-parse", "HEAD"]);
  assert.deepEqual((await documentsAdded(repo, base, head)).sort(), ["docs/a\\b.md", 'docs/中"文.md'].sort());
  assert.deepEqual(
    (await documentsAt(repo, head)).sort(),
    ["README.md", "docs/a\\b.md", 'docs/中"文.md'].sort()
  );
});
