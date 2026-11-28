import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createMcpService } from "../dist/src/dashboard/mcp-service.js";
import { enabledMcpServers, parseMcpImport, readMcpServers } from "../dist/src/runtime/mcp-config.js";

const echo = { command: process.execPath, args: [resolve("test/fixtures/mcp-echo-server.mjs")] };

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "formicand-mcp-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const piAgentDir = join(root, "pi");
  await mkdir(home, { recursive: true });
  return {
    root,
    home,
    piAgentDir,
    service: createMcpService({ home, userHome: home, piAgentDir, harnessRoot: resolve(".") })
  };
}

test("entries are validated the way Pi reads them", async () => {
  assert.deepEqual(
    parseMcpImport(JSON.stringify({ mcpServers: { a: { command: "npx", args: ["x"] } } })).map(
      (entry) => entry.name
    ),
    ["a"]
  );
  assert.equal(
    parseMcpImport(JSON.stringify({ servers: { b: { type: "http", url: "https://x.dev/mcp" } } }))[0].name,
    "b"
  );
  assert.throws(() => parseMcpImport("{"), /不是有效的 JSON/);
  assert.throws(
    () => parseMcpImport(JSON.stringify({ c: { type: "sse", url: "https://x.dev/sse" } })),
    /不支持 SSE/
  );
  assert.throws(() => parseMcpImport(JSON.stringify({ d: { command: "x", url: "https://x.dev" } })), /之一/);
  assert.throws(() => parseMcpImport(JSON.stringify({ "e f": { command: "x" } })), /名称只能/);
  assert.throws(
    () => parseMcpImport(JSON.stringify({ g: { command: "x", exposure: "codemode" } })),
    /可见方式/
  );
  assert.throws(() => parseMcpImport(JSON.stringify({ h: { url: "ftp://x" } })), /http/);
});

test("a server is saved, checked through Pi, renamed, switched off and removed", async (t) => {
  const { home, piAgentDir, service } = await setup(t);
  const draft = await service.test("echoes", echo);
  assert.equal(draft.state, "connected", draft.error);
  assert.deepEqual(draft.tools, ["echo", "erase"]);

  await service.save("echoes", { ...echo, description: "Echo" });
  let list = await service.list();
  assert.equal(list.servers[0].status.state, "unchecked");
  list = await service.check();
  assert.equal(list.servers[0].status.state, "connected");
  assert.deepEqual(list.servers[0].status.tools, ["echo", "erase"]);
  assert.equal(list.servers[0].exposure, "deferred");
  assert.equal(list.servers[0].oauth, false);

  // The file is the user's only; Pi's own stays empty and the probe folder is cleaned.
  assert.equal((await readFile(join(home, "mcp.json"), "utf8")).includes("echoes"), true);
  assert.equal(existsSync(join(piAgentDir, "mcp.json")), false);
  assert.deepEqual(await readdir(join(home, "runtime", "mcp-probe")), []);
  const trust = JSON.parse(await readFile(join(piAgentDir, "trust.json"), "utf8"));
  assert.deepEqual(trust, { [await realpath(join(home, "runtime", "mcp-probe"))]: true });

  await assert.rejects(service.save("echoes", echo), /已存在同名服务：echoes/);
  await assert.rejects(service.save("echoes", { command: "" }), /命令不能为空/);
  await service.save("echo_box", echo, "echoes");
  await assert.rejects(service.save("echo-box", echo), /已存在同名服务：echo_box/);
  list = await service.list();
  assert.deepEqual(
    list.servers.map((server) => server.name),
    ["echo_box"]
  );

  await service.setExposure("echo_box", { exposure: "direct", tools: { erase: "hidden" } });
  let stored = (await readMcpServers(home))[0].config;
  assert.equal(stored.exposure, "direct");
  assert.deepEqual(stored.toolExposure, { erase: "hidden" });
  await service.setExposure("echo_box", { exposure: "deferred", tools: { erase: null } });
  stored = (await readMcpServers(home))[0].config;
  assert.equal(stored.exposure, undefined);
  assert.equal(stored.toolExposure, undefined);

  await service.setEnabled("echo_box", false);
  assert.deepEqual(enabledMcpServers(await readMcpServers(home)), []);
  assert.equal((await service.list()).servers[0].status.state, "disabled");
  await service.setEnabled("echo_box", true);
  assert.equal((await readMcpServers(home))[0].config.enabled, undefined);

  await assert.rejects(service.login("echo_box"), /不使用 OAuth/);
  await service.remove("echo_box");
  assert.deepEqual((await service.list()).servers, []);
  await assert.rejects(service.remove("echo_box"), /没有名为 echo_box/);
});

test("import adds several servers, refuses clashes unless replacing, and failures are reported", async (t) => {
  const { home, service } = await setup(t);
  const text = JSON.stringify({
    mcpServers: {
      echoes: echo,
      broken: { command: join(home, "missing-binary") },
      remote: { url: "https://mcp.example.invalid/mcp" }
    }
  });
  const result = await service.importJson(text, false);
  assert.deepEqual(result.imported, ["echoes", "broken", "remote"]);
  await assert.rejects(service.importJson(JSON.stringify({ echoes: echo }), false), /已存在同名服务/);
  await service.importJson(JSON.stringify({ echoes: { ...echo, description: "again" } }), true);
  assert.equal(
    (await readMcpServers(home)).find((record) => record.name === "echoes").config.description,
    "again"
  );

  const list = await service.check(["echoes", "broken"]);
  const byName = Object.fromEntries(list.servers.map((server) => [server.name, server]));
  assert.equal(byName.echoes.status.state, "connected");
  assert.equal(byName.broken.status.state, "failed");
  assert.match(byName.broken.status.error, /missing-binary/);
  assert.equal(byName.remote.status.state, "unchecked");
  assert.equal(byName.remote.oauth, true);

  // A hand-edited invalid entry is listed with its reason and can still be removed.
  await writeFile(
    join(home, "mcp.json"),
    JSON.stringify({ mcpServers: { bad: { type: "sse", url: "https://x" } } })
  );
  const invalid = (await service.list()).servers[0];
  assert.equal(invalid.status.state, "invalid");
  assert.match(invalid.status.error, /SSE/);
  await service.save("echoes", echo);
  assert.equal(
    (await service.list()).servers.find((server) => server.name === "bad").status.state,
    "invalid"
  );
  await service.remove("bad");
  assert.deepEqual(
    (await service.list()).servers.map((server) => server.name),
    ["echoes"]
  );
});
