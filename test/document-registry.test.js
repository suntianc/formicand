import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { startDashboard } from "./dashboard-fixture.mjs";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";
import { createProjectDevelopmentTool } from "../dist/src/runtime/project-development-tool.js";
import {
  parseRegistry,
  registryProblems,
  tidyDocumentsInput,
  withoutRegistry
} from "../dist/src/domain/project-documents.js";

const run = promisify(execFile);
const git = (cwd, args) => run("git", args, { cwd });

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
  assert.equal(
    withoutRegistry(text),
    withoutRegistry(table("| README.md | product | global |") + "## Next\n\n| a | b |\n")
  );
  assert.notEqual(withoutRegistry(text), withoutRegistry(text.replace("Be brief.", "Be long.")));

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

test("a tidy's verdict on the documents is an update list or a reason", () => {
  assert.deepEqual(tidyDocumentsInput({ unchanged: "只改了内部实现" }), { unchanged: "只改了内部实现" });
  assert.deepEqual(tidyDocumentsInput({ update: [{ path: "README.md", reason: "命令改名" }] }), {
    update: [{ path: "README.md", reason: "命令改名" }]
  });
  assert.equal(tidyDocumentsInput(undefined), undefined);
  assert.throws(() => tidyDocumentsInput({ unchanged: "x", update: [] }), /二选一/);
  assert.throws(() => tidyDocumentsInput({ update: [{ path: "README.md" }] }), /reason/);
});

async function servingToken(root) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const instance = await readBackendInstance(backendPaths(join(root, "home")));
    if (instance.value?.token) return instance.value.token;
    await delay(25);
  }
  assert.fail("the backend did not publish its local credential");
}

test(
  "a requirement's merge builds the registry first, then registers what it adds",
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
    const root = await mkdtemp(join(tmpdir(), "registry-project-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "repository");
    await mkdir(join(directory, "docs"), { recursive: true });
    await git(directory, ["init", "-b", "main"]);
    await git(directory, ["config", "user.email", "fixture@example.test"]);
    await git(directory, ["config", "user.name", "Fixture"]);
    await writeFile(join(directory, "AGENTS.md"), "# Agents\n\nBe brief.\n");
    await writeFile(join(directory, "README.md"), "# fixture\n");
    await writeFile(join(directory, "docs", "guide.md"), "# Guide\n");
    await writeFile(join(directory, "list.txt"), "1\n");
    await git(directory, ["add", "."]);
    await git(directory, ["commit", "-m", "baseline"]);
    const { project } = await post("/api/projects", { projectName: "登记", projectDirectory: directory });
    const { taskId } = await post("/api/tasks", { goal: "登记", projectId: project.projectId });
    const tool = createProjectDevelopmentTool({ dashboardUrl: dashboard.base, taskId, token });
    const selfChecked = async (title, files) => {
      const { requirement } = await post(`/api/projects/${encodeURIComponent(project.projectId)}/ledger`, {
        action: "create",
        title,
        summary: title
      });
      const { development } = await tool.execute({
        action: "create",
        request: "这个功能",
        requirementId: requirement.requirementId,
        goal: title,
        completionCriteria: [title],
        route: "quick"
      });
      const checkout = development.workspace.directory;
      for (const [path, text] of Object.entries(files)) await writeFile(join(checkout, path), text);
      await git(checkout, ["add", "."]);
      await git(checkout, ["commit", "-m", title]);
      await tool.execute({
        action: "review_plan",
        developmentId: development.developmentId,
        channel: "self",
        basis: "小改动自检",
        checks: [{ name: "list", command: "cat list.txt", exitCode: 0, output: "" }]
      });
      return { developmentId: development.developmentId, checkout };
    };
    const commit = async (checkout, path, text, message) => {
      await writeFile(join(checkout, path), text);
      await git(checkout, ["add", "."]);
      await git(checkout, ["commit", "-m", message]);
    };
    const merge = (developmentId) =>
      tool.execute({
        action: "request_merge",
        developmentId,
        ledger: { summaryUnchanged: "测试不改现状", history: "测试合入", descriptionUnchanged: true },
        mergeChecks: [{ name: "list", command: "test -f list.txt" }]
      });

    // No registry yet: the first merge builds one and registers every document.
    const first = await selfChecked("第一项", { "list.txt": "1\n2\n" });
    await assert.rejects(merge(first.developmentId), /还没有文档登记表[^]*tidy-docs/);
    await commit(first.checkout, "AGENTS.md", table("| README.md | product | global |"), "docs: registry");
    await assert.rejects(merge(first.developmentId), /没有登记：docs\/guide\.md/);
    // Anything in AGENTS.md beyond the table is a change the approval does not carry.
    await commit(
      first.checkout,
      "AGENTS.md",
      table("| README.md | product | global |").replace("Be brief.", "Be long."),
      "docs: more"
    );
    await assert.rejects(merge(first.developmentId), /交付资格还不满足：self_check_stale/);
    await commit(
      first.checkout,
      "AGENTS.md",
      table("| README.md | product | global |", "| docs/guide.md | product | guide |"),
      "docs: register the guide"
    );
    const merged = await merge(first.developmentId);
    assert.equal(merged.merge.state, "merged", JSON.stringify(merged.merge));
    assert.notEqual(merged.merge.acceptance.approvedCommit, merged.merge.candidate.commit);

    // With a registry, only what the requirement adds is checked.
    const second = await selfChecked("第二项", {
      "list.txt": "1\n2\n3\n",
      "PLAN.md": "# Plan\n",
      "docs/api.md": "# API\n"
    });
    await assert.rejects(merge(second.developmentId), /没有登记：PLAN\.md、docs\/api\.md/);
    await unlink(join(second.checkout, "PLAN.md"));
    await commit(
      second.checkout,
      "AGENTS.md",
      table(
        "| README.md | product | global |",
        "| docs/guide.md | product | guide |",
        "| docs/api.md | product | guide |"
      ),
      "docs: register the api"
    );
    await assert.rejects(merge(second.developmentId), /同类同领域只许一份：docs\/guide\.md 与 docs\/api\.md/);
    await commit(
      second.checkout,
      "AGENTS.md",
      table(
        "| README.md | product | global |",
        "| docs/guide.md | product | guide |",
        "| docs/api.md | product | api |"
      ),
      "docs: the api is its own domain"
    );
    const done = await merge(second.developmentId);
    assert.equal(done.merge.state, "merged", JSON.stringify(done.merge));
    const tracked = (await git(directory, ["ls-tree", "-r", "--name-only", "main"])).stdout;
    assert.doesNotMatch(tracked, /PLAN\.md/, "the requirement's own process document is gone");
  }
);
