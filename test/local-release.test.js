import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runLocalRelease } from "../scripts/release-local.mjs";

const version = "0.1.3";
const tag = `v${version}`;
const repo = "suntianc/formicand";

test("local release builds once and uploads candidate archives without publishing them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-local-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const commandRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  };
  await runLocalRelease({ tag, repository: repo, root, platform: "darwin", arch: "arm64", commandRunner });
  assert.deepEqual(
    calls.map(({ command, args }) => `${command} ${args.join(" ")}`),
    [
      "node scripts/release-metadata.mjs",
      "npm run desktop:dist",
      "npm run cli:pack",
      "node scripts/release-artifacts.mjs",
      "node scripts/release-draft.mjs upload"
    ]
  );
  assert.equal(calls[3].options.env.RELEASE_TAG, tag);
  assert.equal(calls[3].options.env.GITHUB_REPOSITORY, repo);
});

test("local release rejects unsupported architectures before invoking commands", async () => {
  let invoked = false;
  await assert.rejects(
    runLocalRelease({ tag, platform: "linux", arch: "arm64", commandRunner: () => (invoked = true) }),
    /macOS arm64/
  );
  assert.equal(invoked, false);
});

test("native x64 runners prepare their installer for a shared draft", async () => {
  for (const platform of ["win32", "linux"]) {
    const calls = [];
    await runLocalRelease({
      tag,
      platform,
      arch: "x64",
      commandRunner: (cmd, args) => calls.push([cmd, ...args])
    });
    assert.deepEqual(calls, [
      ["node", "scripts/release-metadata.mjs"],
      ["npm", "run", "desktop:dist"],
      ["node", "scripts/release-artifacts.mjs", "--stage-desktop"]
    ]);
  }
});
