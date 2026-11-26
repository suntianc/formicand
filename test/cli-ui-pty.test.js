import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCliBranding } from "../scripts/cli-branding.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";

const node = process.env.TEST_FORMICAND_NODE || process.execPath;

test(
  "interactive manual shell uses Formicand tool identity and a real Formicand output file",
  { skip: process.platform === "win32", timeout: 35000 },
  async (t) => {
    const f = await fixture(t);
    const temp = join(f.root, "shell-output");
    await mkdir(temp);
    const command =
      "!" +
      JSON.stringify(node) +
      " -e " +
      JSON.stringify(
        'console.log("ENV="+process.env.AI_AGENT+";ENGINE="+process.env.PI_CODING_AGENT);process.stdout.write("A".repeat(180000));'
      );
    const result = await f.run({
      publicEntry: true,
      extraEnv: { TMPDIR: temp },
      actions: [
        { text: command + "\r", waitFor: "formicand-bash-", seconds: 12, required: true },
        { text: "/quit\r", seconds: 0.5 }
      ]
    });
    assert.equal(result.exitCode, 0, result.plain);
    assert.equal(result.ready, true, result.plain.slice(-3000));
    assert.equal(result.actions[0]?.matched, true, result.plain.slice(-3000));
    assert.match(result.plain, /Full output:[\s\S]{0,2000}?formicand-bash-[a-f0-9]+\.log/);
    const files = await readdir(temp);
    const output = files.find((name) => /^formicand-bash-[a-f0-9]+\.log$/.test(name));
    assert.ok(output, JSON.stringify(files));
    assert.equal(
      await readFile(join(temp, output), "utf8"),
      "ENV=formicand;ENGINE=true\n" + "A".repeat(180000)
    );
  }
);

const harnessRoot = resolve(process.env.TEST_FORMICAND_CLI_ROOT || ".");
const sdkRoot = process.env.TEST_FORMICAND_CLI_ROOT
  ? join(harnessRoot, "node_modules/@earendil-works/pi-coding-agent")
  : fileURLToPath(new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent")));
const extensionSource = `import {CustomEditor} from "@earendil-works/pi-coding-agent";
export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.TEST_FORMICAND_CUSTOM_EDITOR === "1") {
      ctx.ui.setEditorComponent((tui,theme,keybindings) => {
        const editor = new CustomEditor(tui,theme,keybindings);
        const render = editor.render.bind(editor);
        editor.render = width => ["CUSTOM_EDITOR_ACTIVE", ...render(width)];
        return editor;
      });
    }
    ctx.ui.notify("EXTENSION_STARTING", "info");
    await new Promise(r => setTimeout(r, 900));
    ctx.ui.notify("SDK_UI_READY", "info");
  });
  pi.on("session_before_compact", async (_event, ctx) => {
    ctx.ui.notify("COMPACTION_STARTED", "info");
    await new Promise(r => setTimeout(r, 900));
  });
  pi.registerCommand("fixture-crash", {handler: async () => {
    setTimeout(() => { throw new Error("FIXTURE_UI_CRASH"); }, 30);
  }});
  pi.registerCommand("fixture-command-list", {handler: async (_args, ctx) => {
    ctx.ui.notify("FIXTURE_FORMICAND_BUG=" + pi.getCommands().some(c => c.name === "formicand-bug"), "info");
  }});
}`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "formicand-ui-pty-"));
  const project = join(root, "project"),
    profile = join(root, "profile"),
    requests = [];
  await mkdir(project);
  await mkdir(profile);
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    if (JSON.stringify(body.messages).includes("REQUEST_MODEL_ERROR")) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "FIXTURE_MODEL_FAILURE", type: "invalid_request_error" } })
      );
    } else {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const stream = protocolStream("openai-completions", { text: "FIXTURE_TASK_COMPLETED" });
      if (JSON.stringify(body.messages).includes("HOLD_STREAM")) {
        response.write(stream.slice(0, stream.indexOf("\n\n") + 2));
        setTimeout(() => response.end(stream.slice(stream.indexOf("\n\n") + 2)), 1200);
      } else response.end(stream);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await writeFile(
    join(profile, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl,
          api: "openai-completions",
          apiKey: "fixture-local",
          models: [
            {
              id: "fixture",
              name: "fixture",
              contextWindow: 32768,
              maxTokens: 1024,
              input: ["text"],
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    })
  );
  await writeFile(
    join(profile, "settings.json"),
    JSON.stringify({ quietStartup: false, retry: { enabled: false } })
  );
  const extension = join(root, "fixture-extension.ts");
  await writeFile(extension, extensionSource);
  const branding = await ensureCliBranding({
    agentDir: profile,
    piPackageDir: sdkRoot,
    version: "0.1.2-test"
  });
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(FORMICAND_|PI_|FORMICAND_|NODE_OPTIONS)/.test(key))
    ),
    ...branding,
    HOME: root,
    FORMICAND_HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: profile,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    TERM: "xterm-256color",
    NODE_DISABLE_COMPILE_CACHE: "1"
  };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  async function run({
    actions = [],
    args = [],
    ready = "SDK_UI_READY",
    extraEnv = {},
    publicEntry = false,
    formicandCommands = publicEntry
  } = {}) {
    const child = spawn("python3", [resolve("test/fixtures/cli-ui-pty.py")], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.stdin.end(
      JSON.stringify({
        command: [
          node,
          join(harnessRoot, publicEntry ? "scripts/formicand.mjs" : "scripts/cli-ui-boot.mjs"),
          "--provider",
          "fixture",
          "--model",
          "fixture",
          "--no-approve",
          "--extension",
          extension,
          ...(formicandCommands ? ["--extension", join(harnessRoot, ".pi/extensions/formicand.ts")] : []),
          ...args
        ],
        cwd: project,
        env: {
          ...env,
          FORMICAND_HARNESS_ROOT: harnessRoot,
          FORMICAND_WORKSPACE: join(root, "workspace"),
          FORMICAND_DISABLE_MAIN_GUARDIAN: "1",
          FORMICAND_API_BASE: baseUrl,
          FORMICAND_API_KEY: "fixture-local",
          FORMICAND_MODEL: "fixture",
          FORMICAND_MODEL_API: "openai-completions",
          ...extraEnv
        },
        ready,
        actions
      })
    );
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    result.requests = structuredClone(requests);
    if (process.env.TEST_FORMICAND_IDENTITY_EVIDENCE_DIR) {
      await mkdir(process.env.TEST_FORMICAND_IDENTITY_EVIDENCE_DIR, { recursive: true });
      await writeFile(
        join(
          process.env.TEST_FORMICAND_IDENTITY_EVIDENCE_DIR,
          `${t.name.replace(/[^a-zA-Z0-9]+/g, "-")}-${Date.now()}.json`
        ),
        JSON.stringify(result, null, 2)
      );
    }
    assert.equal(result.ready, true, result.plain.slice(-3000));
    assert.equal(result.actions.length, actions.length, result.plain.slice(-3000));
    return result;
  }
  return { root, project, profile, requests, env, run };
}

for (const mode of ["regular", "fullscreen"])
  test(
    `real ${mode} TUI handles hidden commands during slow startup and reload without model calls`,
    { skip: process.platform === "win32", timeout: 30000 },
    async (t) => {
      const f = await fixture(t);
      const result = await f.run({
        args: ["--tui-mode", mode],
        ready: "EXTENSION_STARTING",
        actions: [
          { text: "/dementedelves\r", waitFor: "Formicand 不支持此命令", seconds: 4 },
          { text: "", waitFor: "SDK_UI_READY", seconds: 4 },
          { text: "/reload\r", waitFor: "Reloaded keybindings, extensions", seconds: 8 },
          { text: "/dementedelves\r", waitFor: "Formicand 不支持此命令", seconds: 3 },
          { text: "/quit\r", seconds: 2 }
        ]
      });
      assert.equal(result.exitCode, 0, result.plain.slice(-2000));
      assert.equal(result.terminalRestored, true);
      assert.ok(
        result.actions.every((action) => action.matched),
        JSON.stringify(result.actions) + result.plain.slice(-3000)
      );
      assert.equal(f.requests.length, 0);
      assert.doesNotMatch(result.plain, /pi has joined Earendil|What.s New|earendil-works\/pi/);
    }
  );

test(
  "public Formicand TUI preserves preferences across three starts and saves local feedback and a resumable session",
  { skip: process.platform === "win32", timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    // Retain a legacy overlay without touching its bytes or reusing its resources.
    const old = join(f.profile, ".formicand-runtime", "pi-legacy");
    await mkdir(old, { recursive: true });
    await writeFile(join(old, "CHANGELOG.md"), "## 9.9.9\nLegacy Pi release\n");
    for (let attempt = 0; attempt < 3; attempt++) {
      const actions =
        attempt === 2
          ? [
              { text: "/changelog\r", waitFor: "Formicand 更新记录", seconds: 4 },
              { text: "/bug Pi user description\r", waitFor: "报告未自动上传", seconds: 4 },
              { text: "Pi user material\r", waitFor: "FIXTURE_TASK_COMPLETED", seconds: 6 },
              { text: "/quit\r", seconds: 2 }
            ]
          : [{ text: "/quit\r", seconds: 2 }];
      const result = await f.run({ publicEntry: true, args: attempt === 1 ? ["--verbose"] : [], actions });
      assert.equal(result.exitCode, 0, result.plain.slice(-3000));
      assert.equal(result.terminalRestored, true);
      assert.ok(
        result.actions.every((a) => a.matched),
        JSON.stringify(result.actions) + result.plain.slice(-3000)
      );
      assert.doesNotMatch(
        result.plain,
        /What.s New|earendil-works\/pi|pi has joined Earendil|Press Enter to continue/
      );
      assert.equal(JSON.parse(await readFile(join(f.profile, "settings.json"), "utf8")).quietStartup, false);
    }
    assert.equal(await readFile(join(old, "CHANGELOG.md"), "utf8"), "## 9.9.9\nLegacy Pi release\n");
    const report = (await readdir(f.project)).find((name) => name.startsWith("formicand-feedback-"));
    assert.ok(report);
    assert.match(await readFile(join(f.project, report), "utf8"), /Pi user description/);
    assert.equal(f.requests.length, 1);
    assert.match(JSON.stringify(f.requests[0].messages), /Pi user material/);
    assert.doesNotMatch(JSON.stringify(f.requests[0].messages), /trained by Pujiang Laboratory/);
    const result = await f.run({
      publicEntry: true,
      args: ["--continue"],
      actions: [{ text: "/quit\r", seconds: 2 }]
    });
    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(result.plain, /What.s New|earendil-works\/pi/);
    assert.equal(f.requests.length, 1);
  }
);

test(
  "hidden command stays local during streaming and compaction while near commands and Pi body reach the model",
  { skip: process.platform === "win32", timeout: 40000 },
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      join(f.profile, "settings.json"),
      JSON.stringify({
        quietStartup: false,
        retry: { enabled: false },
        compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 16384 }
      })
    );
    const result = await f.run({
      actions: [
        { text: "HOLD_STREAM Pi task\r", seconds: 0.25 },
        { text: "/dementedelves\r", waitFor: "Formicand 不支持此命令", seconds: 3 },
        { text: "", waitFor: "FIXTURE_TASK_COMPLETED", seconds: 5 },
        { text: "/dementedelves extra Pi\r", waitFor: "FIXTURE_TASK_COMPLETED", seconds: 5 },
        { text: "/compact\r", waitFor: "COMPACTION_STARTED", seconds: 4 },
        { text: "/dementedelves\r", waitFor: "Formicand 不支持此命令", seconds: 4 },
        { text: "", waitFor: "Compacted", seconds: 8 },
        {
          text: "\u001b[200~Pi quoted\n/dementedelves\nbody\u001b[201~\r",
          waitFor: "FIXTURE_TASK_COMPLETED",
          seconds: 5
        },
        { text: "/quit\r", seconds: 2 }
      ]
    });
    assert.equal(result.exitCode, 0, result.plain.slice(-3000));
    assert.equal(result.terminalRestored, true);
    assert.ok(
      result.actions.every((a) => a.matched),
      JSON.stringify(result.actions) + result.plain.slice(-3000)
    );
    const serialized = f.requests.map((r) => JSON.stringify(r.messages));
    assert.ok(serialized.some((r) => r.includes("/dementedelves extra Pi")));
    assert.ok(serialized.some((r) => r.includes("Pi quoted\\n/dementedelves\\nbody")));
    const normal = f.requests.filter((r) => !JSON.stringify(r.messages[0]).includes("summarization"));
    // Native compaction can summarize both a conversation and its split turn.
    // Exact hidden commands must never become a standalone provider message.
    for (const request of f.requests)
      for (const message of request.messages) {
        const content =
          typeof message.content === "string"
            ? message.content
            : message.content?.map((part) => part.text ?? "").join("\n");
        assert.notEqual(content?.trim(), "/dementedelves");
      }
    assert.equal(normal.length, 3, JSON.stringify(f.requests.map((r) => r.messages[0])));
  }
);

test(
  "real TUI preserves trust behavior and simulated tmux instructions with Formicand wording",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.project, ".pi/extensions"), { recursive: true });
    await writeFile(
      join(f.project, ".pi/extensions/ignored.ts"),
      "throw new Error('UNTRUSTED_RESOURCE_EXECUTED');"
    );
    const bin = join(f.root, "bin");
    await mkdir(bin);
    const tmux = join(bin, "tmux");
    await writeFile(tmux, '#!/bin/sh\ncase "$*" in *extended-keys-format*) echo xterm;; *) echo on;; esac\n');
    await chmod(tmux, 0o755);
    const result = await f.run({
      extraEnv: { TMUX: "fixture-tmux", PATH: `${bin}:${f.env.PATH}` },
      actions: [
        { text: "", waitFor: "Formicand works best with csi-u", seconds: 4 },
        { text: "/quit\r", seconds: 2 }
      ]
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.plain, /then restart formicand/);
    assert.match(result.plain, /Formicand works best with csi-u/);
    assert.doesNotMatch(result.plain, /then restart pi|Pi works best|UNTRUSTED_RESOURCE_EXECUTED/);
    assert.equal(f.requests.length, 0);
  }
);

test(
  "extension-only TUI error and startup crash hints condition local feedback on Formicand commands",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      join(f.profile, "crashes.json"),
      JSON.stringify([
        {
          timestamp: new Date().toISOString(),
          message: "FIXTURE_PREVIOUS_CRASH",
          kind: "uncaughtException",
          sessionFile: null,
          cwd: f.project
        }
      ])
    );
    const result = await f.run({
      publicEntry: true,
      formicandCommands: false,
      actions: [
        { text: "/fixture-command-list\r", waitFor: "FIXTURE_FORMICAND_BUG=false", seconds: 4 },
        { text: "REQUEST_MODEL_ERROR\r", waitFor: "saves a local feedback file", seconds: 8 },
        { text: "/quit\r", seconds: 2 }
      ]
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.plain, /FIXTURE_FORMICAND_BUG=false/);
    assert.match(result.plain, /FIXTURE_PREVIOUS_CRASH/);
    assert.match(result.plain, /FIXTURE_MODEL_FAILURE/);
    // The hint shares the status line with the crash notice; a narrow terminal
    // may wrap it mid-phrase, so only the words are fixed.
    assert.match(result.plain, /review\s+the\s+file before submitting it manually/);
    assert.match(result.plain, /saves a local feedback file/);
    assert.match(result.plain, /When Formicand commands are enabled, \/formicand-bug/);
    assert.match(result.plain, /Run \/formicand-bug when Formicand commands are enabled/);
    assert.doesNotMatch(result.plain, /attached automatically|sends a report to the developers/);
    assert.equal(f.requests.length, 1);
    assert.equal(
      (await readdir(f.project)).some((name) => name.startsWith("formicand-feedback-")),
      false
    );
    const crashes = JSON.parse(await readFile(join(f.profile, "crashes.json"), "utf8"));
    assert.equal(crashes[0].notified, true);
    assert.equal(crashes[0].message, "FIXTURE_PREVIOUS_CRASH");
  }
);

for (const noSession of [false, true])
  test(
    `real injected fatal ${noSession ? "without" : "with"} session uses truthful restart and local feedback hints`,
    { skip: process.platform === "win32", timeout: 30000 },
    async (t) => {
      const f = await fixture(t),
        result = await f.run({
          args: noSession ? ["--no-session"] : [],
          actions: [{ text: "/fixture-crash\r", seconds: 3 }]
        });
      assert.equal(result.exitCode, 1, result.plain.slice(-2000));
      assert.match(result.plain, /FIXTURE_UI_CRASH/);
      assert.match(result.plain, /Review the saved file before submitting it manually/);
      assert.match(result.plain, /run \/formicand-bug when Formicand commands are enabled/);
      assert.doesNotMatch(result.plain, /start pi and|attached automatically/);
      if (noSession) assert.match(result.plain, /start formicand and/);
      else assert.match(result.plain, /formicand -r/);
      assert.equal(f.requests.length, 0);
    }
  );

test(
  "public TUI retains an external custom editor through Formicand command adaptation and reload",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const result = await f.run({
      publicEntry: true,
      extraEnv: { TEST_FORMICAND_CUSTOM_EDITOR: "1" },
      actions: [
        { text: "", waitFor: "CUSTOM_EDITOR_ACTIVE", seconds: 4 },
        { text: "/help\r", waitFor: "Formicand 命令", seconds: 4 },
        { text: "/reload\r", waitFor: "Reloaded keybindings, extensions", seconds: 8 },
        { text: "/bug custom editor Pi\r", waitFor: "报告未自动上传", seconds: 4 },
        { text: "/dementedelves\r", waitFor: "Formicand 不支持此命令", seconds: 4 },
        { text: "/quit\r", seconds: 2 }
      ]
    });
    assert.equal(result.exitCode, 0, result.plain.slice(-3000));
    assert.equal(result.terminalRestored, true);
    assert.ok(
      result.actions.every((a) => a.matched),
      JSON.stringify(result.actions) + result.plain.slice(-3000)
    );
    assert.equal(f.requests.length, 0);
    assert.ok((await readdir(f.project)).some((name) => name.startsWith("formicand-feedback-")));
  }
);

test(
  "public launcher reports invalid settings in Formicand wording without leaking bad JSON or altering it",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      settings = join(f.profile, "settings.json");
    for (const debug of ["0", "1"]) {
      const raw = '{"credential":"fixture-private-json-value",invalid}';
      await writeFile(settings, raw);
      const result = await f.run({
        publicEntry: true,
        ready: "Formicand 的 Agent 设置无法读取",
        extraEnv: { FORMICAND_DEBUG: debug }
      });
      assert.equal(result.exitCode, 1, result.plain);
      assert.match(result.plain, /Formicand 的 Agent 设置无法读取/);
      assert.doesNotMatch(result.plain, /fixture-private-json-value|SyntaxError|Unexpected token|启动 Pi/);
      if (debug === "0") assert.doesNotMatch(result.plain, /file:\/\/|at ensurePiRetryDefaults/);
      assert.equal(await readFile(settings, "utf8"), raw);
      assert.equal(f.requests.length, 0);
    }
  }
);

test(
  "real Formicand CLI completes a fuzzy @ file fragment through the FFF index",
  { skip: process.platform === "win32", timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.project, "plans"), { recursive: true });
    await mkdir(join(f.project, "src"), { recursive: true });
    await mkdir(join(f.project, ".git"), { recursive: true });
    await writeFile(join(f.project, "plans/quarterly-summary.md"), "# quarterly summary\n");
    await writeFile(join(f.project, "src/app.ts"), "export const app = 1;\n");
    await writeFile(join(f.project, "README.md"), "# fixture project\n");

    // "qurtly-smry" is a typo subsequence of plans/quarterly-summary.md. Pi's
    // built-in fd completion filters on a literal substring, so only FFF's
    // fuzzy index can offer this file; Tab applies the single suggestion or
    // selects it from the open list, and the mention reaches the model as the
    // cwd-relative path.
    const result = await f.run({
      publicEntry: true,
      actions: [
        { text: "@qurtly-smry", seconds: 2 },
        { text: "\t", waitFor: "@plans/quarterly-summary.md", seconds: 10 },
        { text: "\r", waitFor: "FIXTURE_TASK_COMPLETED", seconds: 8 },
        { text: "/quit\r", seconds: 2 }
      ]
    });
    assert.equal(result.exitCode, 0, result.plain.slice(-3000));
    assert.equal(result.terminalRestored, true);
    assert.equal(
      result.actions[1].matched,
      true,
      "Tab did not insert the FFF suggestion; tail:\n" + result.plain.slice(-3000)
    );
    assert.equal(result.plain.includes(`@${join(f.project, "plans/quarterly-summary.md")}`), false);
    const userText = f.requests
      .flatMap((request) => request.messages)
      .filter((message) => message.role === "user")
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : (message.content ?? []).map((part) => part.text ?? "").join("\n")
      )
      .join("\n");
    assert.match(userText, /@plans\/quarterly-summary\.md/);
    assert.doesNotMatch(userText, /@qurtly-smry|@\//);
  }
);
