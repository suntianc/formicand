import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ESLint } from "eslint";
import { piDependencyBoundary } from "../eslint.config.mjs";

/**
 * The repository's import boundaries, asserted through the ESLint rules that
 * enforce them in the build: the layer restrictions (`no-restricted-imports`)
 * and the Pi runtime boundary (`formicand/pi-import-boundary`) whose allowlist
 * must stay identical to the bilingual entry section that documents it.
 */

const PI_BOUNDARY_RULE = "formicand/pi-import-boundary";
const eslint = new ESLint();

async function imports(filePath, source) {
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages.filter((message) => message.ruleId === "no-restricted-imports");
}

async function boundaryReports(filePath, source) {
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages.filter((message) => message.ruleId === PI_BOUNDARY_RULE);
}

test("shared modules cannot import a CLI entrypoint or dashboard orchestration", async () => {
  for (const file of ["src/runtime/subagent-processes.ts", "src/runtime/skill-registry.ts"]) {
    for (const target of ["../cli/formicand.js", "../dashboard/application.js"]) {
      assert.equal((await imports(file, `import { example } from "${target}";`)).length, 1);
    }
  }
  assert.equal(
    (await imports("src/storage/atomic-file.ts", 'import { example } from "../cli/formicand.js";')).length,
    1
  );
  assert.equal(
    (await imports("src/runtime/subagent-processes.ts", 'import { example } from "../domain/types.js";'))
      .length,
    0
  );
  assert.equal(
    (await imports("src/cli/dashboard.ts", 'import { example } from "../dashboard/application.js";')).length,
    0
  );
});

test("HTTP routers cannot launch processes and run orchestration cannot write HTTP responses", async () => {
  for (const file of [
    "src/dashboard/routes.ts",
    "src/dashboard/computer-routes.ts",
    "src/dashboard/upload-routes.ts"
  ]) {
    for (const target of ["node:child_process", "../runtime/process-host.js"]) {
      assert.equal((await imports(file, `import { example } from "${target}";`)).length, 1);
    }
    assert.equal((await imports(file, 'import { example } from "./http.js";')).length, 0);
  }
  for (const target of ["node:http", "./http.js"]) {
    assert.equal(
      (await imports("src/dashboard/run-service.ts", `import { example } from "${target}";`)).length,
      1
    );
  }
  assert.equal(
    (await imports("src/dashboard/run-service.ts", 'import { example } from "../runtime/process-host.js";'))
      .length,
    0
  );
});

test("GUI drivers remain independent of application persistence and CLI hosts", async () => {
  for (const target of ["../dashboard/routes.js", "../cli/formicand.js"]) {
    assert.equal(
      (await imports("src/gui/macos-driver.ts", `import { example } from "${target}";`)).length,
      1
    );
  }
});

test("Pi runtime imports are rejected outside the allowed areas", async () => {
  const cases = [
    [
      "src/runtime/coordinator-runtime.ts",
      'import { SessionManager } from "@earendil-works/pi-coding-agent";'
    ],
    ["src/runtime/coordinator-runtime.ts", 'import "@earendil-works/pi-ai";'],
    ["src/runtime/coordinator-runtime.ts", 'const pi = await import("@earendil-works/pi-ai");'],
    [
      "src/runtime/coordinator-runtime.ts",
      'const { SessionManager } = require("@earendil-works/pi-coding-agent");'
    ],
    ["src/storage/atomic-file.ts", 'export { createModels } from "@earendil-works/pi-ai";'],
    [
      "web/assets/controllers/composer-session.js",
      'import { SessionManager } from "@earendil-works/pi-coding-agent";'
    ]
  ];
  for (const [file, source] of cases) {
    const reports = await boundaryReports(file, source);
    assert.equal(reports.length, 1, `${file}: ${source}`);
    assert.match(reports[0].message, /^Pi runtime imports are only allowed in/);
  }
});

test("type-only imports of Pi packages are unrestricted", async () => {
  const sources = [
    'import type { SessionEntry } from "@earendil-works/pi-coding-agent";',
    'import { type SessionEntry } from "@earendil-works/pi-coding-agent";',
    'import type { Context, Model } from "@earendil-works/pi-ai";',
    'import type { ProviderStreams } from "@earendil-works/pi-ai/api/openai-completions.lazy";',
    'export type { SessionEntry } from "@earendil-works/pi-coding-agent";',
    "let entry: import('@earendil-works/pi-coding-agent').SessionEntry | undefined;"
  ];
  for (const source of sources) {
    assert.deepEqual(await boundaryReports("src/runtime/coordinator-runtime.ts", source), [], source);
  }
});

test("Pi package subpaths are rejected outside model configuration", async () => {
  const allowed = await boundaryReports(
    "src/runtime/model-provider.ts",
    'import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";'
  );
  assert.deepEqual(allowed, []);

  const rejected = [
    [
      "src/runtime/coordinator-runtime.ts",
      'import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";'
    ],
    [
      ".pi/runtime/tools/browser-use.ts",
      'import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";'
    ],
    ["scripts/cli-session.mjs", 'import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";']
  ];
  for (const [file, source] of rejected) {
    const reports = await boundaryReports(file, source);
    assert.equal(reports.length, 1, file);
    assert.match(reports[0].message, /^Pi package subpaths may only be imported by model configuration/);
  }
});

test("Pi runtime imports stay allowed in the boundary areas", async () => {
  const areas = [
    ".pi/runtime/tools/demo.ts",
    "scripts/demo.mjs",
    ...Object.values(piDependencyBoundary.runtimeModules).flat()
  ];
  for (const file of areas) {
    const reports = await boundaryReports(
      file,
      'import { SessionManager } from "@earendil-works/pi-coding-agent";'
    );
    assert.deepEqual(reports, [], file);
  }
});

test("session handoffs need no runtime import exception", async () => {
  const source = 'import { estimateTokens } from "@earendil-works/pi-coding-agent";';
  const denied = await boundaryReports("src/runtime/session-handoff.ts", source);
  assert.equal(denied.length, 1);
  const allowed = await boundaryReports(".pi/runtime/context-windows.ts", source);
  assert.deepEqual(allowed, []);
});

test("the allowlist matches the bilingual entry documentation", async () => {
  const documents = ["AGENTS.md", "AGENTS.en.md"];
  for (const document of documents) {
    const text = await readFile(document, "utf8");
    for (const directory of piDependencyBoundary.runtimeDirectories) {
      assert.ok(text.includes(directory), `${document} does not mention ${directory}`);
    }
    for (const file of Object.values(piDependencyBoundary.runtimeModules).flat()) {
      assert.ok(existsSync(file), `allowlist points at a missing file: ${file}`);
      assert.ok(text.includes(file), `${document} does not mention ${file}`);
    }
  }
});

test("shared runtime and web views read platform capabilities from their owner", async () => {
  const cases = [
    ["src/dashboard/application.ts", "process.platform", 1],
    ["src/platform/directory-picker.ts", "process.platform", 0],
    ["src/runtime/process-identity.ts", "process.platform", 0],
    ["web/app.js", "window.formicandDesktop?.platform", 1],
    ["web/app.js", "globalThis.navigator?.userAgent", 1],
    ["web/app.js", "document.documentElement.dataset.titleBar", 0]
  ];
  for (const [filePath, source, expected] of cases) {
    const [result] = await eslint.lintText(source, { filePath });
    assert.equal(
      result.messages.filter(({ ruleId }) => ruleId === "no-restricted-syntax").length,
      expected,
      source
    );
  }
});
