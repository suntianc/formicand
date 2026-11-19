import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createSkillService } from "../dist/src/dashboard/skill-service.js";
import { resolveSkillCatalog } from "../dist/src/runtime/skill-registry.js";

const run = promisify(execFile);

async function skill(directory, name, extra = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Use ${name}\n---\nBody\n`);
  for (const [file, content] of Object.entries(extra)) {
    await mkdir(join(directory, file, ".."), { recursive: true });
    await writeFile(join(directory, file), content);
  }
  return directory;
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "cowork-skill-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = {
    root,
    harnessRoot: join(root, "install"),
    home: join(root, "user", ".atria"),
    userHome: join(root, "user"),
    projectDirectory: join(root, "project")
  };
  await mkdir(join(paths.projectDirectory, ".git"), { recursive: true });
  const service = createSkillService({
    harnessRoot: paths.harnessRoot,
    home: paths.home,
    userHome: paths.userHome,
    projectForId: async (projectId) =>
      projectId === "p1" ? { projectId, projectName: "Demo", projectDirectory: paths.projectDirectory } : null
  });
  return { paths, service };
}

const global = { scope: "global" };
const project = { scope: "project", projectId: "p1" };

test("the global list shows installed, shared and bundled skills with their source", async (t) => {
  const { paths, service } = await setup(t);
  await skill(join(paths.harnessRoot, ".pi", "skills", "cua"), "cua");
  await skill(join(paths.userHome, ".agents", "skills", "pdf"), "pdf", { "scripts/fill.py": "print(1)" });
  await skill(join(paths.home, "skills", "release-notes"), "release-notes");
  await skill(join(paths.projectDirectory, ".atria", "skills", "deploy"), "deploy");

  const { skills } = await service.list(global);
  assert.deepEqual(
    skills.map((entry) => [entry.name, entry.source, entry.deletable]),
    [
      ["release-notes", "global", true],
      ["pdf", "global-agents", false],
      ["cua", "bundled", false]
    ]
  );
  assert.deepEqual(skills.find((entry) => entry.name === "pdf").scripts, ["fill.py"]);
});

test("a folder is previewed, then the chosen skills are copied into ~/.atria/skills", async (t) => {
  const { paths, service } = await setup(t);
  const source = join(paths.root, "download");
  await skill(join(source, "alpha"), "alpha", { "scripts/run.sh": "echo" });
  await skill(join(source, "nested", "beta"), "beta");

  const preview = await service.previewFolder(source, global);
  assert.deepEqual(preview.skills.map((entry) => [entry.name, entry.exists]).sort(), [
    ["alpha", false],
    ["beta", false]
  ]);
  const result = await service.install(preview.stagingId, ["alpha"], global, false);
  assert.deepEqual(result.installed, ["alpha"]);
  assert.ok(existsSync(join(paths.home, "skills", "alpha", "scripts", "run.sh")));
  assert.ok(!existsSync(join(paths.home, "skills", "beta")));
  // The source folder is only read.
  assert.ok(existsSync(join(source, "alpha", "SKILL.md")));

  const again = await service.previewFolder(source, global);
  assert.equal(again.skills.find((entry) => entry.name === "alpha").exists, true);
  await assert.rejects(service.install(again.stagingId, ["alpha"], global, false), /已存在同名技能：alpha/);
  await service.install(again.stagingId, ["alpha"], global, true);
  await assert.rejects(service.install(again.stagingId, ["alpha"], global, true), /预览已过期/);

  await assert.rejects(service.previewFolder(join(paths.root, "empty-missing"), global), /文件夹不存在/);
  await mkdir(join(paths.root, "empty"));
  await assert.rejects(service.previewFolder(join(paths.root, "empty"), global), /没有找到技能/);
});

test("a zip archive and a Git repository install the same way", async (t) => {
  const { paths, service } = await setup(t);
  const source = join(paths.root, "zip-source");
  await skill(join(source, "zipped"), "zipped");
  const archive = join(paths.root, "skills.zip");
  await run("zip", ["-qr", archive, "zipped"], { cwd: source });
  const fromZip = await service.previewArchive(await readFile(archive), global);
  await service.install(fromZip.stagingId, ["zipped"], global, false);
  assert.ok(existsSync(join(paths.home, "skills", "zipped", "SKILL.md")));
  await assert.rejects(service.previewArchive(Buffer.from("not a zip"), global), /压缩包无法解开/);

  const repository = join(paths.root, "remote");
  await skill(join(repository, "skills", "from-git"), "from-git");
  await run("git", ["init", "-q"], { cwd: repository });
  await run("git", ["add", "."], { cwd: repository });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init"], {
    cwd: repository
  });
  const fromGit = await service.previewGit(repository, global);
  await service.install(fromGit.stagingId, ["from-git"], global, false);
  assert.ok(existsSync(join(paths.home, "skills", "from-git", "SKILL.md")));
  assert.ok(!existsSync(join(paths.home, "skills", "from-git", ".git")));
  await assert.rejects(service.previewGit("ftp://example.com/x", global), /不支持 ftp 协议/);
  // Staged copies are cleaned once installed.
  const staged = join(paths.home, "runtime", "skill-staging");
  assert.deepEqual(existsSync(staged) ? (await run("ls", [staged])).stdout.trim() : "", "");
});

test("removing hides a skill from the catalog, restoring brings it back, and only installed skills delete", async (t) => {
  const { paths, service } = await setup(t);
  const shared = await skill(join(paths.userHome, ".agents", "skills", "docx"), "docx");
  const installed = await skill(join(paths.home, "skills", "notes"), "notes");
  const catalog = () =>
    resolveSkillCatalog({ ...paths, projectTrusted: false }).then((list) => list.map((entry) => entry.name));

  await service.remove(global, shared);
  assert.deepEqual(await catalog(), ["notes"]);
  const listed = (await service.list(global)).skills.find((entry) => entry.name === "docx");
  assert.equal(listed.removed, true);
  await service.restore(global, shared);
  assert.deepEqual(await catalog(), ["docx", "notes"]);

  await assert.rejects(service.delete(global, shared), /只能删除本产品安装的技能/);
  assert.ok(existsSync(shared));
  await service.delete(global, installed);
  assert.ok(!existsSync(installed));
  await assert.rejects(service.remove(global, join(paths.root, "elsewhere")), /技能不存在/);
});

test("a project's skills appear only after it is trusted, and installs go to its .atria/skills", async (t) => {
  const { paths, service } = await setup(t);
  await skill(join(paths.projectDirectory, ".atria", "skills", "deploy"), "deploy");
  await skill(join(paths.projectDirectory, ".agents", "skills", "lint"), "lint");

  const untrusted = await service.list(project);
  assert.equal(untrusted.project.trust, null);
  assert.deepEqual(untrusted.skills, []);
  assert.equal(untrusted.project.folders.length, 2);
  const source = join(paths.root, "download");
  await skill(join(source, "extra"), "extra");
  await assert.rejects(service.previewFolder(source, project), /请先信任这个项目/);

  await service.trust("p1", "trusted");
  const trusted = await service.list(project);
  assert.equal(trusted.project.trust, "trusted");
  assert.deepEqual(
    trusted.skills.map((entry) => [entry.name, entry.source]),
    [
      ["deploy", "project"],
      ["lint", "project-agents"]
    ]
  );
  const preview = await service.previewFolder(source, project);
  await service.install(preview.stagingId, ["extra"], project, false);
  assert.ok(existsSync(join(paths.projectDirectory, ".atria", "skills", "extra", "SKILL.md")));

  await service.trust("p1", "untrusted");
  assert.deepEqual((await service.list(project)).skills, []);
  await assert.rejects(service.list({ scope: "project", projectId: "missing" }), /项目不存在/);
});
