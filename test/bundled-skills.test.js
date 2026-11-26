import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { FileMatcher } from "app-builder-lib/out/fileMatcher.js";
import {
  discoverSkills,
  createLoadSkillTool,
  skillCatalogPrompt
} from "../dist/src/runtime/skill-registry.js";
import { checkDocumentation } from "../scripts/check-docs.mjs";
import { builtinAgentDefaults } from "../dist/src/runtime/role-models.js";

const names = [
  "cua",
  "task-routing",
  "requirement-delivery",
  "grill-with-docs",
  "grilling",
  "domain-modeling",
  "codebase-design",
  "to-spec",
  "to-tickets",
  "implement",
  "tdd",
  "code-review",
  "diagnosing-bugs",
  "retro",
  "tidy-docs",
  "writing-for-agents"
];
const source = resolve(".");
const require = createRequire(import.meta.url);

async function markdownFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith(".md")) files.push(path);
    }
  }
  for (const name of names) await visit(`.pi/skills/${name}`);
  return files;
}

test("the delegated roles' default skills are all bundled", () => {
  for (const role of ["executor", "reviewer"]) {
    const { skills } = builtinAgentDefaults(role);
    assert.ok(Array.isArray(skills) && skills.length, role);
    for (const name of skills) assert.ok(names.includes(name), `${role}: ${name}`);
  }
});

test("bundled skills load on demand and every local resource survives installed desktop selection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-creative-skills-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = require("../electron-builder.config.cjs");
  const filter = new FileMatcher(source, root, (pattern) => pattern, config.files).createFilter();
  for (const file of await markdownFiles(source))
    assert.equal(
      filter(join(source, file), await stat(join(source, file))),
      true,
      `Package excludes ${file}`
    );
  await cp(join(source, ".pi/skills"), join(root, ".pi/skills"), { recursive: true });
  // The CUA skill links to the shipped documentation entry; both packages place it beside the skills.
  await cp(join(source, "docs/en/README.md"), join(root, "docs/en/README.md"));
  const skills = await discoverSkills([join(root, ".pi/skills")]);
  const catalog = skillCatalogPrompt(skills);
  const loader = createLoadSkillTool(skills);
  for (const name of names) {
    const loaded = await loader.execute({ name });
    assert.equal(loaded.name, name);
    assert.equal(relative(root, loaded.directory), `.pi/skills/${name}`);
    assert.ok(catalog.includes(name));
    assert.ok(!catalog.includes(loaded.content.split("\n\n").at(-1)), "skill body is loaded only on demand");
  }
  const files = await markdownFiles(root);
  assert.deepEqual((await checkDocumentation(root, files)).errors, []);
  for (const file of files) {
    const body = await readFile(join(root, file), "utf8");
    assert.doesNotMatch(
      body,
      /miaoda:|skill-resources|copy_starter_component|invoke_skill|sf3-scmcdn|\/root\//
    );
  }
});
