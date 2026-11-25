import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFileTarget, resolveProtectedTarget } from "../dist/src/tools/file-path.js";
import {
  ProtectedPaths,
  configuredProtectedPaths,
  projectWritesEnabled,
  formicandInstallRoot,
  DEFAULT_PROTECTED_PATHS
} from "../dist/src/tools/protected-paths.js";

async function project(t) {
  // Resolve symlinks: on macOS /var is /private/var, and `pwd` reports the real path.
  const base = await realpath(await mkdtemp(join(tmpdir(), "formicand-guard-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  // The agent's workspace sits outside the project, as it does in a real run.
  const workDir = join(base, "workspace", "agent");
  await mkdir(join(root, "pipeline"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(join(root, "pipeline", "synth.py"), "# synthesis\n");
  await writeFile(join(root, ".git", "config"), "[core]\n");
  return { root, workDir };
}

test("the guard protects version control, but not the project's own code", async (t) => {
  const { root } = await project(t);
  const guard = new ProtectedPaths({ root });
  for (const path of [".git/config", ".git/hooks/pre-commit"])
    assert.ok(guard.match(join(root, path)), `${path} must be protected`);
  // The patterns resolve against the user's project, which is what the agent
  // is here to change.
  for (const path of [
    "pipeline/synth.py",
    "eval/score.py",
    "benchmarks/run.sh",
    "test/cli.test.js",
    "src/synth/mix.py",
    "dist/bundle.js",
    "README.md"
  ]) {
    assert.equal(guard.match(join(root, path)), undefined, `${path} must stay writable`);
  }
  // A name that merely starts with a protected one is a different path.
  assert.equal(guard.match(join(root, ".github/workflows/ci.yml")), undefined);
  // Paths outside the guarded root are some other check's business.
  assert.equal(guard.match("/tmp/elsewhere/file.txt"), undefined);
});

test("the harness install is protected by absolute path, wherever it sits", async (t) => {
  const { root } = await project(t);
  const install = "/opt/formicand";
  const guard = new ProtectedPaths({ root, protectedRoots: [install] });
  // An agent must not edit the runtime it runs in, even from outside the project.
  assert.equal(guard.match("/opt/formicand/src/runtime/role-models.ts"), install);
  assert.equal(guard.match("/opt/formicand/.pi/extensions/formicand.ts"), install);
  assert.equal(
    guard.match(join(root, "src/synth/mix.py")),
    undefined,
    "the project's own src/ is untouched by this"
  );

  // Emptying the project patterns is allowed; the runtime stays protected.
  const opened = configuredProtectedPaths(root, { FORMICAND_PROTECTED_PATHS: "" }, [install]);
  assert.equal(opened.match(join(root, ".git/config")), undefined);
  assert.equal(opened.match("/opt/formicand/src/x.ts"), install, "the runtime is never a write target");
});

test("formicandInstallRoot points at the harness, not at dist", () => {
  const root = formicandInstallRoot();
  assert.ok(existsSync(join(root, "package.json")), `${root} should be the install root`);
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name, "formicand");
});

test("the environment preset can grant project writes for a preconfigured run", () => {
  // The normal path is a Task grant. This exists for a run configured ahead of
  // time — an unattended job — and is off unless set.
  assert.equal(projectWritesEnabled({}), false, "an ordinary task gets the sandbox");
  assert.equal(projectWritesEnabled({ FORMICAND_PROJECT_WRITE: "1" }), true);
  assert.equal(projectWritesEnabled({ FORMICAND_PROJECT_WRITE: "0" }), false);
  assert.equal(projectWritesEnabled({ FORMICAND_PROJECT_WRITE: "false" }), false);
});

test("the protected set is configurable, and can be emptied deliberately", () => {
  const root = "/project";
  assert.ok(configuredProtectedPaths(root, {}).match("/project/.git/config"), "defaults apply when unset");

  const custom = configuredProtectedPaths(root, { FORMICAND_PROTECTED_PATHS: "scoring/, golden.json" });
  assert.ok(custom.match("/project/scoring/run.py"));
  assert.ok(custom.match("/project/golden.json"));
  assert.equal(
    custom.match("/project/.git/config"),
    undefined,
    "an override replaces the defaults rather than adding to them"
  );

  assert.equal(
    configuredProtectedPaths(root, { FORMICAND_PROTECTED_PATHS: "" }).match("/project/.git/config"),
    undefined,
    "the guard can be turned off, but only by saying so"
  );
});

test("the default set is version control only, not the project's own layout", () => {
  assert.deepEqual(DEFAULT_PROTECTED_PATHS, [".git/"]);
});

test("protected target resolution bounds link chains and ordinary files still reject cycles", async (t) => {
  const { root } = await project(t);
  for (let index = 0; index < 40; index += 1)
    await symlink(index === 39 ? "future" : `link-${index + 1}`, join(root, `link-${index}`));
  assert.equal(await resolveProtectedTarget(join(root, "link-0")), join(root, "future"));
  await symlink("link-0", join(root, "too-long"));
  await assert.rejects(resolveProtectedTarget(join(root, "too-long")), /too many symbolic links/);
  await symlink("cycle-b", join(root, "cycle-a"));
  await symlink("cycle-a", join(root, "cycle-b"));
  await assert.rejects(resolveProtectedTarget(join(root, "cycle-a")), /too many symbolic links/);
  await assert.rejects(resolveFileTarget(join(root, "cycle-a")), { code: "ELOOP" });
});
