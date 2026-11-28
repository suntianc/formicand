import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { formicandHome, formicandDataPaths } from "../scripts/data-home.cjs";
import { configuredWorkspaceRoot } from "../dist/src/runtime/runtime-settings.js";
import { readFormicandConfig, formicandConfigPath } from "../dist/src/runtime/config.js";
import { createRequire } from "node:module";
const { desktopPaths } = createRequire(import.meta.url)("../desktop/paths.cjs");

test("App, CLI and direct runtime use the same default paths with explicit overrides", () => {
  const env = { FORMICAND_HOME: resolve("/private-fixture/formicand") };
  const shared = formicandDataPaths(env, {}, resolve("/project"));
  assert.equal(formicandHome({}, resolve("/test-user")), resolve("/test-user/.formicand"));
  assert.equal(shared.workspaceRoot, resolve("/private-fixture/formicand/workspace"));
  assert.equal(shared.piAgentDir, resolve("/private-fixture/formicand/pi"));
  const desktop = desktopPaths("/install", shared.home, env);
  for (const key of ["workspaceRoot", "piAgentDir", "globalIndex", "logs"])
    assert.equal(desktop[key], shared[key]);
  assert.equal(configuredWorkspaceRoot({}, env, resolve("/project")), shared.workspaceRoot);
  assert.equal(
    formicandDataPaths(env, { workspaceRoot: "old-data" }, resolve("/project")).workspaceRoot,
    resolve("/project/old-data")
  );
  const explicit = formicandDataPaths({
    ...env,
    FORMICAND_WORKSPACE: resolve("/workspace"),
    PI_CODING_AGENT_DIR: resolve("/pi"),
    FORMICAND_GLOBAL_INDEX: resolve("/indexes/catalog.json")
  });
  assert.equal(explicit.workspaceRoot, resolve("/workspace"));
  assert.equal(explicit.piAgentDir, resolve("/pi"));
  assert.equal(explicit.globalIndex, resolve("/indexes/catalog.json"));
});

test("all source entrypoints honor user config fallback and existing explicit/project config", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-data-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"),
    project = join(root, "project");
  await mkdir(home);
  await mkdir(project);
  const env = { FORMICAND_HOME: home };
  await writeFile(join(home, "config.json"), JSON.stringify({ model: "home-fixture" }));
  assert.equal(readFormicandConfig(project, env).model, "home-fixture");
  assert.equal(formicandConfigPath(project, env), join(home, "config.json"));
  await writeFile(join(project, "config.json"), JSON.stringify({ model: "project-fixture" }));
  assert.equal(readFormicandConfig(project, env).model, "project-fixture");
  const explicit = join(root, "explicit.json");
  await writeFile(explicit, JSON.stringify({ model: "explicit-fixture" }));
  assert.equal(
    readFormicandConfig(project, { ...env, FORMICAND_CONFIG: explicit }).model,
    "explicit-fixture"
  );
  assert.equal(await readFile(join(home, "config.json"), "utf8"), '{"model":"home-fixture"}');
});
