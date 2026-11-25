import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createLoadSkillTool,
  listSkillEntries,
  resolveSkillCatalog,
  skillRootsFor
} from "../dist/src/runtime/skill-registry.js";
import { removeSkillFromIndex, restoreSkillToIndex } from "../dist/src/runtime/skill-index.js";
import {
  decideProjectTrust,
  projectDefinitionFolders,
  projectTrustDecision,
  projectTrustPath
} from "../dist/src/runtime/project-trust.js";
import { privateDataRefusal } from "../dist/src/tools/private-data.js";
import { configuredProtectedPaths } from "../dist/src/tools/protected-paths.js";

async function layout(t) {
  const root = await mkdtemp(join(tmpdir(), "formicand-skill-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = {
    harnessRoot: join(root, "install"),
    home: join(root, "user", ".formicand"),
    userHome: join(root, "user"),
    repository: join(root, "repo"),
    projectDirectory: join(root, "repo", "packages", "app")
  };
  await mkdir(join(paths.repository, ".git"), { recursive: true });
  await mkdir(paths.projectDirectory, { recursive: true });
  return paths;
}

async function skill(directory, name, description = `Use ${name} from ${directory}`) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}\n`
  );
  return directory;
}

const locations = (paths, projectTrusted = true) => ({ ...paths, projectTrusted });

test("five sources resolve to one catalog, higher sources winning on the same name", async (t) => {
  const paths = await layout(t);
  const bundled = await skill(join(paths.harnessRoot, ".pi", "skills", "shared"), "shared");
  await skill(join(paths.harnessRoot, ".pi", "skills", "cua"), "cua");
  const sharedAgents = await skill(join(paths.userHome, ".agents", "skills", "shared"), "shared");
  await skill(join(paths.userHome, ".agents", "skills", "pdf"), "pdf");
  const installed = await skill(join(paths.home, "skills", "pdf"), "pdf");
  const repoAgents = await skill(join(paths.repository, ".agents", "skills", "release"), "release");
  const nearAgents = await skill(join(paths.projectDirectory, ".agents", "skills", "release"), "release");
  const projectOwn = await skill(join(paths.projectDirectory, ".formicand", "skills", "shared"), "shared");
  // Pi's own locations are no longer read.
  await skill(join(paths.projectDirectory, ".pi", "skills", "legacy"), "legacy");
  await skill(join(paths.home, "pi", "skills", "legacy-state"), "legacy-state");

  const catalog = await resolveSkillCatalog(locations(paths));
  assert.deepEqual(
    catalog.map((entry) => [entry.name, entry.directory]),
    [
      ["cua", join(paths.harnessRoot, ".pi", "skills", "cua")],
      ["pdf", installed],
      ["release", nearAgents],
      ["shared", projectOwn]
    ]
  );

  const entries = await listSkillEntries(skillRootsFor(locations(paths)), new Set());
  const byDirectory = new Map(entries.map((entry) => [entry.directory, entry]));
  assert.equal(byDirectory.get(repoAgents).source, "project-agents");
  assert.equal(byDirectory.get(repoAgents).shadowedBy, nearAgents);
  assert.equal(byDirectory.get(sharedAgents).shadowedBy, projectOwn);
  assert.equal(byDirectory.get(bundled).source, "bundled");
  assert.equal(byDirectory.get(installed).source, "global");
});

test("an untrusted project contributes no skills until the user trusts it", async (t) => {
  const paths = await layout(t);
  await skill(join(paths.projectDirectory, ".formicand", "skills", "deploy"), "deploy");
  await skill(join(paths.repository, ".agents", "skills", "release"), "release");
  await skill(join(paths.home, "skills", "pdf"), "pdf");

  assert.deepEqual(
    (await resolveSkillCatalog(locations(paths, false))).map((entry) => entry.name),
    ["pdf"]
  );
  assert.equal(await projectTrustDecision(paths.home, paths.projectDirectory), undefined);
  assert.deepEqual(projectDefinitionFolders(paths.projectDirectory), [
    join(paths.projectDirectory, ".formicand", "skills"),
    join(paths.repository, ".agents", "skills")
  ]);

  await decideProjectTrust(paths.home, paths.projectDirectory, "trusted");
  assert.equal(await projectTrustDecision(paths.home, paths.projectDirectory), "trusted");
  await decideProjectTrust(paths.home, paths.repository, "untrusted");
  assert.equal(await projectTrustDecision(paths.home, paths.repository), "untrusted");
  const saved = JSON.parse(await readFile(projectTrustPath(paths.home), "utf8"));
  assert.deepEqual(Object.keys(saved.projects).sort(), [paths.projectDirectory, paths.repository].sort());
});

test("a removed skill leaves every catalog but keeps its files, and a restore brings it back", async (t) => {
  const paths = await layout(t);
  const shared = await skill(join(paths.userHome, ".agents", "skills", "docx"), "docx");
  const bundled = await skill(join(paths.harnessRoot, ".pi", "skills", "docx"), "docx", "Bundled docx");

  await removeSkillFromIndex(paths.home, { directory: shared, name: "docx" });
  const catalog = await resolveSkillCatalog(locations(paths));
  // The lower source with the same name takes its place.
  assert.deepEqual(
    catalog.map((entry) => entry.directory),
    [bundled]
  );
  await removeSkillFromIndex(paths.home, { directory: bundled, name: "docx" });
  assert.deepEqual(await resolveSkillCatalog(locations(paths)), []);
  assert.match(await readFile(join(shared, "SKILL.md"), "utf8"), /Body of docx/);

  const tool = createLoadSkillTool(await resolveSkillCatalog(locations(paths)));
  await assert.rejects(tool.execute({ name: "docx" }), /unknown skill: docx/);

  assert.equal(await restoreSkillToIndex(paths.home, shared), true);
  assert.equal(await restoreSkillToIndex(paths.home, shared), false);
  const restored = await resolveSkillCatalog(locations(paths));
  assert.deepEqual(
    restored.map((entry) => entry.directory),
    [shared]
  );
  const loaded = await createLoadSkillTool(restored).execute({ name: "docx" });
  assert.equal(loaded.directory, shared);
});

test("Agents may read installed skills but file tools never write them", () => {
  const userHome = "/Users/example";
  const home = "/Users/example/.formicand";
  assert.equal(privateDataRefusal({ path: `${home}/skills/pdf/SKILL.md` }, home, userHome), undefined);
  assert.equal(
    privateDataRefusal({ command: "cat ~/.formicand/skills/pdf/scripts/run.py" }, home, userHome),
    undefined
  );
  assert.ok(privateDataRefusal({ command: "cat ~/.formicand/skills/../config.json" }, home, userHome));

  const guard = configuredProtectedPaths("/Users/example/project", {}, [`${home}/skills`]);
  assert.throws(() => guard.assertWritable(`${home}/skills/pdf/SKILL.md`), /read-only for agents/);
});
