import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const exec = promisify(execFile);

test(
  "real Main Pi reaches ~/.formicand/mcp.json servers through tool_search only",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "formicand-mcp-pi-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "home"),
      project = join(root, "project"),
      workspace = join(root, "workspace");
    await mkdir(home, { recursive: true });
    await mkdir(join(project, ".pi"), { recursive: true });
    await mkdir(workspace);
    const server = resolve("test/fixtures/mcp-echo-server.mjs");
    await writeFile(
      join(home, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          echoes: { command: process.execPath, args: [server], toolExposure: { erase: "hidden" } },
          idle: { command: process.execPath, args: [server], enabled: false }
        }
      })
    );
    // A project's own Pi MCP file must not add servers.
    await writeFile(
      join(project, ".pi", "mcp.json"),
      JSON.stringify({
        mcpServers: { planted: { command: process.execPath, args: [server], exposure: "direct" } }
      })
    );
    const toolSets = [];
    const results = [];
    const provider = await modelProtocolFixture("openai-completions", (body, requests) => {
      toolSets.push(body.tools?.map((tool) => tool.function.name) ?? []);
      const last = body.messages.findLast((message) => message.role === "tool");
      if (last) results.push(typeof last.content === "string" ? last.content : JSON.stringify(last.content));
      switch (requests.length) {
        case 1:
          return { name: "tool_search", arguments: { query: "echo text" } };
        case 2:
          return { name: "mcp__echoes__echo", arguments: { text: "hello" } };
        default:
          return { text: "MCP_VERIFIED" };
      }
    });
    t.after(() => provider.close());
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        baseUrl: provider.baseUrl,
        apiKey: "local-mcp",
        model: "fixture",
        reasoningEffort: "off",
        supportsReasoningEffort: false
      })
    );
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(FORMICAND_|PI_|FORMICAND_)/.test(name))
    );
    const pending = exec(
      process.execPath,
      ["scripts/start-pi.mjs", "--print", "--mode", "json", "Echo hello with the MCP tool."],
      {
        cwd: resolve("."),
        timeout: 45000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...inherited,
          FORMICAND_HOME: home,
          FORMICAND_CONFIG: configPath,
          FORMICAND_PROJECT_DIR: project,
          FORMICAND_WORKSPACE: workspace,
          FORMICAND_TASK_ID: "mcp",
          FORMICAND_RUN_ID: "mcp-run",
          PI_CODING_AGENT_DIR: join(root, "pi"),
          FORMICAND_DISABLE_MAIN_GUARDIAN: "1",
          PI_OFFLINE: "1"
        }
      }
    );
    pending.child.stdin.end();
    const { stdout, stderr } = await pending;
    assert.ok(stdout.includes("MCP_VERIFIED"), stderr);
    const mcpTools = (tools) => tools.filter((name) => name.startsWith("mcp__"));
    assert.ok(toolSets[0].includes("tool_search"), toolSets[0].join(","));
    assert.deepEqual(mcpTools(toolSets[0]), []);
    assert.deepEqual(mcpTools(toolSets[1]), ["mcp__echoes__echo"]);
    assert.match(results[0], /mcp__echoes__echo/);
    assert.doesNotMatch(results[0], /erase|planted|idle/);
    assert.match(results[1], /echo:hello/);
  }
);

test(
  "real Main uses the skills, MCP servers and extra prompt set for it, the project's over the host's",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "formicand-main-settings-pi-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "home"),
      project = join(root, "project"),
      workspace = join(root, "workspace");
    for (const name of ["keep", "drop"]) {
      await mkdir(join(home, "skills", name), { recursive: true });
      await writeFile(
        join(home, "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name} skill\n---\nUse it.\n`
      );
    }
    await mkdir(project, { recursive: true });
    await mkdir(workspace);
    const server = resolve("test/fixtures/mcp-echo-server.mjs");
    await writeFile(
      join(home, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          echoes: { command: process.execPath, args: [server], exposure: "direct" },
          other: { command: process.execPath, args: [server], exposure: "direct" }
        }
      })
    );
    const requests = [];
    const provider = await modelProtocolFixture("openai-completions", (body) => {
      requests.push(body);
      return { text: "SETTINGS_VERIFIED" };
    });
    t.after(() => provider.close());
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        baseUrl: provider.baseUrl,
        apiKey: "local-main-settings",
        model: "fixture",
        reasoningEffort: "off",
        supportsReasoningEffort: false,
        roleModels: {
          version: 1,
          host: { main: { skills: ["keep"], mcp: ["other"], prompt: "HOST_MAIN_MARK" } },
          projects: { [project]: { main: { prompt: "PROJECT_MAIN_MARK" } } }
        }
      })
    );
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(FORMICAND_|PI_|FORMICAND_)/.test(name))
    );
    const pending = exec(process.execPath, ["scripts/start-pi.mjs", "--print", "--mode", "json", "Hello."], {
      cwd: resolve("."),
      timeout: 45000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...inherited,
        FORMICAND_HOME: home,
        FORMICAND_CONFIG: configPath,
        FORMICAND_PROJECT_DIR: project,
        FORMICAND_WORKSPACE: workspace,
        FORMICAND_TASK_ID: "settings",
        FORMICAND_RUN_ID: "settings-run",
        PI_CODING_AGENT_DIR: join(root, "pi"),
        FORMICAND_DISABLE_MAIN_GUARDIAN: "1",
        PI_OFFLINE: "1"
      }
    });
    pending.child.stdin.end();
    const { stdout, stderr } = await pending;
    assert.ok(stdout.includes("SETTINGS_VERIFIED"), stderr);
    const tools = requests[0].tools.map((tool) => tool.function.name);
    assert.ok(tools.includes("mcp__other__echo"), tools.join(","));
    assert.ok(!tools.some((name) => name.startsWith("mcp__echoes__")), tools.join(","));
    const system = requests[0].messages
      .filter((message) => message.role === "system")
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content)
      )
      .join("\n");
    assert.match(system, /<user_main_instructions>\s*PROJECT_MAIN_MARK/);
    assert.doesNotMatch(system, /HOST_MAIN_MARK/);
    assert.match(system, /<name>keep<\/name>/);
    assert.doesNotMatch(system, /<name>drop<\/name>/);
  }
);
