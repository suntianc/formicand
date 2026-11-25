import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formicandHome, formicandDataPaths } from "../scripts/data-home.cjs";
import { configuredWorkspaceRoot } from "../dist/src/runtime/runtime-settings.js";
import { readFormicandConfig, formicandConfigPath } from "../dist/src/runtime/config.js";
import { createRequire } from "node:module";
const { desktopPaths } = createRequire(import.meta.url)("../desktop/paths.cjs");

test("App, CLI and direct runtime use the same default paths with explicit overrides", () => {
  const env = { FORMICAND_HOME: "/private-fixture/formicand" };
  const shared = formicandDataPaths(env, {}, "/project");
  assert.equal(formicandHome({}, "/test-user"), "/test-user/.formicand");
  assert.equal(shared.workspaceRoot, "/private-fixture/formicand/workspace");
  assert.equal(shared.piAgentDir, "/private-fixture/formicand/pi");
  const desktop = desktopPaths("/install", shared.home, env);
  for (const key of ["workspaceRoot", "piAgentDir", "globalIndex", "logs"])
    assert.equal(desktop[key], shared[key]);
  assert.equal(configuredWorkspaceRoot({}, env, "/project"), shared.workspaceRoot);
  assert.equal(
    formicandDataPaths(env, { workspaceRoot: "old-data" }, "/project").workspaceRoot,
    "/project/old-data"
  );
  const explicit = formicandDataPaths({
    ...env,
    FORMICAND_WORKSPACE: "/workspace",
    PI_CODING_AGENT_DIR: "/pi",
    FORMICAND_GLOBAL_INDEX: "/indexes/catalog.json"
  });
  assert.equal(explicit.workspaceRoot, "/workspace");
  assert.equal(explicit.piAgentDir, "/pi");
  assert.equal(explicit.globalIndex, "/indexes/catalog.json");
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
