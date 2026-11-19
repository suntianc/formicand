import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  agentToolNames,
  availableAgents,
  customAgentsPrompt,
  listAgentEntries,
  parseAgentDefinition,
  resolveAgent,
  serializeAgentDefinition
} from "../dist/src/runtime/agent-definitions.js";
import { parseSkillFrontmatter } from "../dist/src/runtime/skill-frontmatter.js";
import { createAgentService } from "../dist/src/dashboard/agent-service.js";
import { decideProjectTrust } from "../dist/src/runtime/project-trust.js";
import { writeMcpServers } from "../dist/src/runtime/mcp-config.js";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "cowork-agents-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  const userHome = join(root, "user");
  for (const folder of [home, project, userHome]) await mkdir(folder, { recursive: true });
  return { root, home, project, userHome };
}

async function agentFile(folder, name, header, body = "") {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${name}.md`), `---\nname: ${name}\n${header}\n---\n${body}`);
}

test("a definition is read from its header and body, and written back the same", () => {
  assert.deepEqual(parseSkillFrontmatter("---\na: [x, \"y z\"]\nb:\n  - p\n  - 'q'\n---\n").frontmatter, {
    a: ["x", "y z"],
    b: ["p", "q"]
  });
  const text = `---\nname: db-migrator\ndescription: "涉及表结构变更: 迁移脚本时派给它"\npermission: write\nmodel: glm-5.3\ntools: [read, bash, edit]\nskills: [pg-migration]\nmcp:\n  - postgres\n---\n先在临时库演练。\n`;
  const parsed = parseAgentDefinition(text, "db-migrator.md");
  assert.ok("definition" in parsed, parsed.error);
  assert.deepEqual(parsed.definition, {
    name: "db-migrator",
    description: "涉及表结构变更: 迁移脚本时派给它",
    permission: "write",
    model: "glm-5.3",
    tools: ["read", "bash", "edit"],
    skills: ["pg-migration"],
    mcp: ["postgres"],
    prompt: "先在临时库演练。"
  });
  const again = parseAgentDefinition(serializeAgentDefinition(parsed.definition), "db-migrator.md");
  assert.deepEqual(again.definition, parsed.definition);

  // The rules the code holds, whatever the file says.
  assert.match(
    parseAgentDefinition("---\nname: r\ndescription: d\npermission: read\ntools: [read, edit]\n---\n").error,
    /只读 Agent 不能使用 edit/
  );
  assert.match(
    parseAgentDefinition("---\nname: r\ndescription: d\npermission: write\ntools: [call_subagent]\n---\n")
      .error,
    /不能给 Agent 的工具：call_subagent/
  );
  assert.match(
    parseAgentDefinition("---\nname: a b\ndescription: d\npermission: write\n---\n").error,
    /名称/
  );
  assert.match(
    parseAgentDefinition("---\nname: a\ndescription: d\npermission: write\n---\n", "b.md").error,
    /a\.md/
  );
  assert.match(parseAgentDefinition("---\nname: a\npermission: write\n---\n").error, /使用说明/);

  // Channels always; skills loader unless the definition names none; never Main's tools.
  assert.deepEqual(agentToolNames({ name: "a", description: "d", permission: "read", prompt: "" }), [
    "read",
    "bash",
    "grep",
    "find",
    "ls",
    "browse_workspace",
    "search",
    "visit",
    "load_skill",
    "ask_main",
    "send_peer_message"
  ]);
  assert.deepEqual(
    agentToolNames({
      name: "a",
      description: "d",
      permission: "write",
      tools: ["read"],
      skills: [],
      prompt: ""
    }),
    ["read", "ask_main", "send_peer_message"]
  );
});

test("project Agents need trust, win over global ones, and broken or switched-off ones are never delegated", async (t) => {
  const { home, project } = await setup(t);
  const globalRoot = join(home, "agents");
  const projectRoot = join(project, ".atria", "agents");
  await agentFile(globalRoot, "db-migrator", "description: 全局版本\npermission: write");
  await agentFile(globalRoot, "pr-writer", "description: 写 PR\npermission: read");
  await agentFile(globalRoot, "doc-writer", "description: 写文档\npermission: write\nenabled: false");
  await agentFile(globalRoot, "broken", "description: 坏的\npermission: admin");
  await agentFile(projectRoot, "db-migrator", "description: 项目版本\npermission: read");

  const untrusted = { home, projectDirectory: project, projectTrusted: false };
  assert.deepEqual(
    (await availableAgents(untrusted)).map((agent) => [agent.name, agent.description]),
    [
      ["db-migrator", "全局版本"],
      ["pr-writer", "写 PR"]
    ]
  );
  const trusted = { ...untrusted, projectTrusted: true };
  const entries = await listAgentEntries(trusted);
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.source, Boolean(entry.shadowedBy)]),
    [
      ["executor", "builtin", false],
      ["reviewer", "builtin", false],
      ["db-migrator", "project", false],
      ["broken", "global", false],
      ["db-migrator", "global", true],
      ["doc-writer", "global", false],
      ["pr-writer", "global", false]
    ]
  );
  assert.equal((await resolveAgent(trusted, "db-migrator")).definition.description, "项目版本");
  await assert.rejects(resolveAgent(trusted, "doc-writer"), /doc-writer 已停用/);
  await assert.rejects(resolveAgent(trusted, "broken"), /broken 的定义有误/);
  await assert.rejects(resolveAgent(trusted, "nobody"), /没有名为 nobody 的 Agent/);
  assert.match(
    customAgentsPrompt(await availableAgents(trusted)),
    /- db-migrator \(read\): 项目版本\n- pr-writer \(read\): 写 PR$/
  );
});

test("the settings service saves, renames, switches off and deletes, and names broken references", async (t) => {
  const { home, project, userHome, root } = await setup(t);
  const harness = join(root, "harness");
  await mkdir(join(home, "skills", "pg-migration"), { recursive: true });
  await writeFile(
    join(home, "skills", "pg-migration", "SKILL.md"),
    "---\nname: pg-migration\ndescription: d\n---\n"
  );
  await writeMcpServers(home, [
    { name: "postgres", config: { command: "x" } },
    { name: "off", config: { command: "x", enabled: false } }
  ]);
  const service = createAgentService({
    harnessRoot: harness,
    home,
    userHome,
    projectForId: async (id) =>
      id === "p1" ? { projectId: "p1", projectName: "Demo", projectDirectory: project } : null
  });
  const global = { scope: "global" };
  const definition = {
    name: "db-migrator",
    description: "迁移",
    permission: "write",
    tools: ["read", "bash", "edit"],
    skills: ["pg-migration", "gone"],
    mcp: ["postgres", "off", "missing"],
    prompt: "先演练。"
  };
  await service.save(global, definition);
  await assert.rejects(service.save(global, definition), /已有同名 Agent/);
  await assert.rejects(service.save(global, { ...definition, name: "executor" }), /内置 Agent/);
  await assert.rejects(
    service.save(global, { ...definition, permission: "read" }),
    /只读 Agent 不能使用 edit/
  );

  let list = await service.list(global);
  const saved = list.agents.find((agent) => agent.name === "db-migrator");
  assert.deepEqual(saved.problems, [
    "技能 gone 不存在或已从索引移除",
    "MCP 服务 off 已停用",
    "MCP 服务 missing 未配置"
  ]);
  assert.deepEqual(
    list.agents.filter((agent) => agent.readonly).map((agent) => agent.name),
    ["executor", "reviewer"]
  );
  const options = await service.options(global);
  assert.deepEqual(options.skills, ["pg-migration"]);
  assert.ok(!options.tools.read.includes("edit") && options.tools.write.includes("edit"));

  await service.save(
    global,
    { ...definition, name: "migrator", skills: undefined, mcp: ["postgres"] },
    "db-migrator"
  );
  await service.setEnabled(global, "migrator", false);
  assert.match(await readFile(join(home, "agents", "migrator.md"), "utf8"), /enabled: false/);
  list = await service.list(global);
  assert.deepEqual(
    list.agents.filter((agent) => agent.source === "global").map((agent) => [agent.name, agent.problems]),
    [["migrator", []]]
  );
  await service.delete(global, "migrator");
  assert.equal((await service.list(global)).agents.length, 2);

  // A project's Agents are edited only after it is trusted; the question lists what it would bring in.
  const projectScope = { scope: "project", projectId: "p1" };
  await assert.rejects(service.save(projectScope, definition), /请先信任这个项目/);
  await agentFile(join(project, ".atria", "agents"), "tester", "description: 测试\npermission: read");
  await mkdir(join(project, ".agents", "skills", "pdf"), { recursive: true });
  await writeFile(
    join(project, ".agents", "skills", "pdf", "SKILL.md"),
    "---\nname: pdf\ndescription: d\n---\n"
  );
  await mkdir(join(project, ".atria", "skills", "pg-migration"), { recursive: true });
  await writeFile(
    join(project, ".atria", "skills", "pg-migration", "SKILL.md"),
    "---\nname: pg-migration\ndescription: d\n---\n"
  );
  const preview = await service.trustPreview("p1");
  assert.equal(preview.project.trust, null);
  assert.deepEqual(preview.agents, [{ name: "tester", overrides: false }]);
  assert.deepEqual(
    preview.skills.sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: "pdf", overrides: false },
      { name: "pg-migration", overrides: true }
    ]
  );
  assert.deepEqual(
    (await service.list(projectScope)).agents.map((agent) => agent.name),
    []
  );
  await decideProjectTrust(home, project, "trusted");
  assert.deepEqual(
    (await service.list(projectScope)).agents.map((agent) => [agent.name, agent.source]),
    [["tester", "project"]]
  );
});
