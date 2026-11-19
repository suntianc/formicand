import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createComposerService, fuzzyScore } from "../dist/src/dashboard/composer-service.js";
import { referencesBlock, stripReferencesBlock } from "../dist/src/runtime/composer-references.js";
import { decideProjectTrust } from "../dist/src/runtime/project-trust.js";
import { writeMcpServers } from "../dist/src/runtime/mcp-config.js";

const echo = { command: process.execPath, args: [resolve("test/fixtures/mcp-echo-server.mjs")] };

async function skill(root, name, description) {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nDo it.\n`
  );
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "cowork-composer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const userHome = join(root, "user");
  const harness = join(root, "harness");
  const project = join(root, "project");
  await Promise.all([home, userHome, harness, project].map((folder) => mkdir(folder, { recursive: true })));
  const service = createComposerService({
    harnessRoot: harness,
    home,
    userHome,
    projectForId: async (projectId) => (projectId === "p1" ? { projectDirectory: project } : null)
  });
  return { root, home, project, service };
}

test("the / menu lists Main's skills and prompt templates, project ones over global ones", async (t) => {
  const { home, project, service } = await setup(t);
  await skill(join(home, "skills"), "pg-migration", "PostgreSQL 迁移");
  await skill(join(project, ".atria", "skills"), "local-only", "项目技能");
  await mkdir(join(home, "prompts"), { recursive: true });
  await mkdir(join(project, ".atria", "prompts"), { recursive: true });
  await writeFile(join(home, "prompts", "review.md"), "---\ndescription: 全局审查\n---\n按规范审查。\n");
  await writeFile(join(home, "prompts", "plan.md"), "# 先列计划\n再动手。\n");
  await writeFile(join(home, "prompts", "bad name.md"), "忽略");
  await writeFile(join(project, ".atria", "prompts", "review.md"), "按团队规范审查迁移 PR。\n");

  const global = await service.slash();
  assert.deepEqual(
    global.skills.map((entry) => [entry.name, entry.source]),
    [["pg-migration", "global"]]
  );
  assert.deepEqual(
    global.prompts.map((entry) => [entry.name, entry.description, entry.source]),
    [
      ["plan", "先列计划", "global"],
      ["review", "全局审查", "global"]
    ]
  );

  // Project skills wait for trust; project templates are only text the person sees before sending.
  let scoped = await service.slash("p1");
  assert.deepEqual(
    scoped.skills.map((entry) => entry.name),
    ["pg-migration"]
  );
  assert.equal(scoped.prompts.find((entry) => entry.name === "review").body, "按团队规范审查迁移 PR。");
  await decideProjectTrust(home, project, "trusted");
  scoped = await service.slash("p1");
  assert.deepEqual(
    scoped.skills.map((entry) => entry.name),
    ["local-only", "pg-migration"]
  );
});

test("the @ menu searches project files, from git or the folder itself", async (t) => {
  const { project, service } = await setup(t);
  await mkdir(join(project, "src", "storage", "migrations"), { recursive: true });
  await mkdir(join(project, "node_modules", "x"), { recursive: true });
  await writeFile(join(project, "src", "storage", "migrations", "0007_add_task_index.sql"), "");
  await writeFile(join(project, "src", "storage", "migrations", "0007_add_task_index.down.sql"), "");
  await writeFile(join(project, "src", "index.ts"), "");
  await writeFile(join(project, "node_modules", "x", "0007.js"), "");

  let found = await service.files("p1", "0007");
  assert.deepEqual(found.files, [
    "src/storage/migrations/0007_add_task_index.sql",
    "src/storage/migrations/0007_add_task_index.down.sql"
  ]);
  assert.equal((await service.files("p1", "sidx")).files[0], "src/index.ts");
  assert.deepEqual((await service.files(undefined, "")).files, []);

  // In a repository the listing follows .gitignore.
  const { project: repo, service: gitService } = await setup(t);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  await writeFile(join(repo, ".gitignore"), "secret.txt\n");
  await writeFile(join(repo, "secret.txt"), "");
  await writeFile(join(repo, "notes.md"), "");
  found = await gitService.files("p1", "");
  assert.deepEqual(found.files.sort(), [".gitignore", "notes.md"]);

  assert.ok(fuzzyScore("a/readme.md", "read") < fuzzyScore("readme/a.md", "read"));
  assert.equal(fuzzyScore("a/b.md", "zz"), undefined);
});

test("MCP resources come from enabled servers; App interfaces are left out", async (t) => {
  const { home, service } = await setup(t);
  await writeMcpServers(home, [
    { name: "pg", config: { ...echo, env: { ECHO_RESOURCES: "1" } } },
    { name: "plain", config: echo },
    { name: "off", config: { ...echo, env: { ECHO_RESOURCES: "1" }, enabled: false } },
    { name: "needs-env", config: { ...echo, env: { ECHO_RESOURCES: "${COMPOSER_TEST_UNSET}" } } }
  ]);
  const { resources } = await service.resources();
  assert.deepEqual(resources, [
    { server: "pg", uri: "schema://public/tasks", name: "public.tasks", description: "Tasks table" }
  ]);
});

test("references keep what resolves and the manifest goes in front of the words", async (t) => {
  const { home, project, service } = await setup(t);
  await skill(join(home, "skills"), "pg-migration", "迁移");
  await writeFile(join(project, "a.sql"), "");
  await writeFile(join(project, "..", "outside.sql"), "");
  await writeMcpServers(home, [{ name: "pg", config: echo }]);
  const resolved = await service.resolve(project, [
    { kind: "skill", name: "pg-migration" },
    { kind: "skill", name: "pg-migration" },
    { kind: "skill", name: "missing" },
    { kind: "file", path: "a.sql" },
    { kind: "file", path: "./a.sql" },
    { kind: "file", path: "../outside.sql" },
    { kind: "file", path: "nope.sql" },
    { kind: "mcp_resource", server: "pg", uri: "schema://public/tasks" },
    { kind: "mcp_resource", server: "other", uri: "x://y" }
  ]);
  assert.deepEqual(resolved, [
    { kind: "skill", name: "pg-migration", path: join(home, "skills", "pg-migration", "SKILL.md") },
    { kind: "file", path: "a.sql" },
    { kind: "mcp_resource", server: "pg", uri: "schema://public/tasks" }
  ]);
  assert.deepEqual(await service.resolve(undefined, [{ kind: "file", path: "a.sql" }]), []);

  const message = referencesBlock(project, resolved.slice(0, 2)) + "用 /pg-migration 处理 @a.sql";
  assert.match(message, /^<atria_references>\n\{"version":1,"note":"[^"]*read the SKILL\.md/);
  assert.equal(stripReferencesBlock(message), "用 /pg-migration 处理 @a.sql");
  assert.equal(stripReferencesBlock("没有清单"), "没有清单");
  assert.equal(referencesBlock(project, []), "");
});
