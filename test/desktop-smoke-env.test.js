import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { desktopSmokeEnvironment } from "../scripts/desktop-smoke-env.mjs";

test("packaged smoke excludes inherited data/model/credential overrides while leaving caller HOME intact", () => {
  const source = {
    HOME: "/fixture/original-home",
    TMPDIR: "/fixture/tmp",
    PATH: "/fixture/node/bin",
    FORMICAND_HOME: "/fixture/not-the-smoke",
    FORMICAND_DESKTOP_APP: "/fixture/not-the-candidate",
    FORMICAND_COMPONENTS_HOME: "/fixture/not-the-components",
    FORMICAND_COMPONENTS_RELEASE_ROOT: "https://fixture.invalid/not-the-release",
    FORMICAND_COMPONENTS_GITHUB_TOKEN: "fixture-only-component-token",
    FORMICAND_CONFIG: "/fixture/not-the-config",
    FORMICAND_API_KEY: "fixture-only-key",
    FORMICAND_BLENDER_EXECUTABLE: "/fixture/not-the-runtime",
    PI_CODING_AGENT_DIR: "/fixture/not-the-pi",
    PI_MODEL: "fixture-not-the-model",
    OPENAI_API_KEY: "fixture-only-provider",
    ANTHROPIC_AUTH_TOKEN: "fixture-only-token",
    GOOGLE_API_KEY: "fixture-only-speech-key",
    OTHER_API_KEY: "fixture-only-other-key",
    AWS_SHARED_CREDENTIALS_FILE: "/fixture/not-the-credentials",
    CSC_LINK: "fixture-only-certificate",
    APPLE_KEYCHAIN_PROFILE: "fixture-only-profile",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_OPTIONS: "fixture-only-node-options"
  };
  const original = { ...source };
  const env = desktopSmokeEnvironment({ data: "/fixture/owned-data", source });
  assert.deepEqual(source, original);
  assert.deepEqual(env, {
    HOME: "/fixture/original-home",
    TMPDIR: "/fixture/tmp",
    PATH: "/usr/bin:/bin",
    FORMICAND_HOME: "/fixture/owned-data",
    FORMICAND_DESKTOP_DATA: "/fixture/owned-data",
    PI_CODING_AGENT_DIR: "/fixture/owned-data/pi",
    FORMICAND_DISABLE_MAIN_GUARDIAN: "1",
    FORMICAND_DESKTOP_BACKGROUND: "1",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0"
  });
});
