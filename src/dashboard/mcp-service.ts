import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isHttpServer,
  mcpConfigPath,
  parseMcpImport,
  parseMcpServer,
  piMcpServerConfig,
  readMcpServers,
  sameMcpServerName,
  writeMcpServers,
  DEFAULT_MCP_EXPOSURE,
  type McpExposure,
  type McpServerConfig,
  type McpServerRecord
} from "../runtime/mcp-config.js";
import { atomicWrite } from "../storage/atomic-file.js";
import { displayPath } from "../runtime/display-path.js";
import { HttpError } from "./http.js";

export type McpState = "connected" | "needs-auth" | "failed" | "disabled" | "unchecked" | "invalid";

export interface McpStatus {
  state: McpState;
  tools: string[];
  error?: string;
  checkedAt?: string;
  durationMs?: number;
}

export interface McpLogin {
  state: "waiting" | "failed";
  url?: string;
  error?: string;
}

/** A server as the settings screen shows it. */
export interface McpServerView {
  name: string;
  kind: "stdio" | "http";
  config?: McpServerConfig;
  enabled: boolean;
  exposure: McpExposure;
  status: McpStatus;
  /** An HTTP server without an Authorization header signs in with OAuth. */
  oauth: boolean;
  login?: McpLogin;
}

export interface McpServiceOptions {
  home: string;
  userHome: string;
  /** Pi's agent folder, where Pi keeps the OAuth credentials Main also reads. */
  piAgentDir: string;
  harnessRoot: string;
  /** Pi's command-line entry; resolved from the installation when omitted. */
  piEntry?: string;
}

const PROBE_TIMEOUT_MS = 120_000;
const LOGIN_TIMEOUT_SECONDS = 300;

interface PiListReport {
  name: string;
  state: string;
  tools?: string[];
  error?: string;
}

function resolvePiEntry(harnessRoot: string): string {
  const local = join(
    harnessRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "cli.js"
  );
  if (existsSync(local)) return local;
  // npm may hoist the package outside the installation.
  return join(
    dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
    "bundle",
    "cli.js"
  );
}

function usesOAuth(config: McpServerConfig | undefined): boolean {
  if (!config || !isHttpServer(config)) return false;
  return !Object.keys(config.headers ?? {}).some((key) => key.toLowerCase() === "authorization");
}

function lastLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

/**
 * MCP settings: `~/.atria/mcp.json` and what Pi reports about each server.
 *
 * Checking a connection and signing in run Pi's own `pi mcp list` and
 * `pi mcp login` against a scratch folder whose `.pi/mcp.json` holds only the
 * servers in question. That folder is trusted in Pi's agent folder once; the
 * agent folder's own `mcp.json` stays empty, and OAuth credentials land in its
 * `mcp-auth.json`, keyed by server name and URL, where Main finds them.
 */
export function createMcpService(options: McpServiceOptions) {
  const piEntry = options.piEntry ?? resolvePiEntry(options.harnessRoot);
  const probeRoot = join(options.home, "runtime", "mcp-probe");
  const statuses = new Map<string, { signature: string; status: McpStatus }>();
  const logins = new Map<string, McpLogin>();
  let writes: Promise<unknown> = Promise.resolve();

  /** Config writes are serialized so two quick edits cannot drop each other. */
  const update = <T>(change: (records: McpServerRecord[]) => Promise<T> | T): Promise<T> => {
    const next = writes.then(async () => change(await readMcpServers(options.home)));
    // eslint-disable-next-line no-restricted-syntax -- 失败已经由这次修改的调用方收到，队列只需让下一次修改继续
    writes = next.catch(() => undefined);
    return next;
  };
  const save = (records: McpServerRecord[]) =>
    writeMcpServers(
      options.home,
      records.map((record) => ({ name: record.name, config: record.config ?? record.raw }))
    );

  const signature = (config: McpServerConfig) => JSON.stringify(piMcpServerConfig(config));

  const statusOf = (record: McpServerRecord): McpStatus => {
    if (!record.config) return { state: "invalid", tools: [], error: record.error };
    if (record.config.enabled === false) return { state: "disabled", tools: [] };
    const cached = statuses.get(record.name);
    return cached?.signature === signature(record.config) ? cached.status : { state: "unchecked", tools: [] };
  };

  const view = (record: McpServerRecord): McpServerView => ({
    name: record.name,
    kind: record.config && isHttpServer(record.config) ? "http" : "stdio",
    ...(record.config ? { config: record.config } : {}),
    enabled: record.config?.enabled !== false,
    exposure: record.config?.exposure ?? DEFAULT_MCP_EXPOSURE,
    status: statusOf(record),
    oauth: usesOAuth(record.config),
    ...(logins.has(record.name) ? { login: logins.get(record.name) } : {})
  });

  async function trustProbeRoot() {
    await mkdir(probeRoot, { recursive: true });
    const trustPath = join(options.piAgentDir, "trust.json");
    const key = realpathSync(probeRoot);
    let trust: Record<string, unknown> = {};
    try {
      trust = JSON.parse(await readFile(trustPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (trust[key] === true) return;
    trust[key] = true;
    await atomicWrite(trustPath, `${JSON.stringify(trust, null, 2)}\n`);
  }

  /** Run one `pi mcp` command in a scratch folder that defines `servers`. */
  async function piMcp(
    servers: Array<{ name: string; config: McpServerConfig }>,
    args: string[],
    onStdout?: (text: string) => void
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    await trustProbeRoot();
    const folder = join(probeRoot, randomUUID());
    await mkdir(join(folder, ".pi"), { recursive: true });
    const mcpServers = Object.fromEntries(
      servers.map((server) => [server.name, { ...piMcpServerConfig(server.config), enabled: true }])
    );
    try {
      await writeFile(join(folder, ".pi", "mcp.json"), JSON.stringify({ mcpServers }), { mode: 0o600 });
      return await new Promise((done, fail) => {
        const child = spawn(process.execPath, [piEntry, "mcp", ...args], {
          cwd: folder,
          env: { ...process.env, PI_CODING_AGENT_DIR: options.piAgentDir },
          stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(
          () => child.kill("SIGTERM"),
          args[0] === "login" ? (LOGIN_TIMEOUT_SECONDS + 30) * 1000 : PROBE_TIMEOUT_MS
        );
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
          onStdout?.(stdout);
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
        child.on("error", (error) => {
          clearTimeout(timer);
          fail(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          done({ code, stdout, stderr });
        });
      });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  async function probe(
    servers: Array<{ name: string; config: McpServerConfig }>
  ): Promise<Map<string, McpStatus>> {
    const started = Date.now();
    const { stdout, stderr } = await piMcp(servers, ["list", "--json"]);
    const checkedAt = new Date().toISOString();
    const durationMs = Date.now() - started;
    let reports: PiListReport[] = [];
    let errors: string[] = [];
    try {
      const parsed = JSON.parse(stdout) as { servers?: PiListReport[]; errors?: string[] };
      reports = parsed.servers ?? [];
      errors = parsed.errors ?? [];
      // eslint-disable-next-line no-restricted-syntax -- pi mcp list 没有输出 JSON（例如自身启动失败）时，用它的报错作为每个服务的失败原因
    } catch {
      const reason = lastLine(stderr) ?? lastLine(stdout) ?? "检查连接失败";
      return new Map(
        servers.map((server) => [server.name, { state: "failed", tools: [], error: reason, checkedAt }])
      );
    }
    return new Map(
      servers.map((server) => {
        const report = reports.find((entry) => entry.name === server.name);
        const state: McpState =
          report?.state === "connected"
            ? "connected"
            : report?.state === "needs-auth"
              ? "needs-auth"
              : "failed";
        const error =
          report?.error ??
          (report ? undefined : (errors.find((line) => line.includes(server.name)) ?? "没有结果"));
        return [
          server.name,
          { state, tools: report?.tools ?? [], ...(error ? { error } : {}), checkedAt, durationMs }
        ];
      })
    );
  }

  const find = (records: McpServerRecord[], name: string) => {
    const record = records.find((entry) => entry.name === name);
    if (!record) throw new HttpError(404, `没有名为 ${name} 的服务`, "mcp_server_not_found");
    return record;
  };
  const validConfig = (name: string, raw: unknown): McpServerConfig => {
    const result = parseMcpServer(name, raw);
    if ("error" in result) throw new HttpError(400, result.error, "mcp_server_invalid");
    return result.config;
  };

  return {
    async list() {
      const records = await readMcpServers(options.home);
      const path = mcpConfigPath(options.home);
      return {
        path,
        displayPath: displayPath(path, { userHome: options.userHome }),
        servers: records.map(view)
      };
    },

    /** Check enabled servers again; all of them when `names` is omitted. */
    async check(names?: string[]) {
      const records = await readMcpServers(options.home);
      const targets = records.flatMap((record) =>
        record.config && record.config.enabled !== false && (!names || names.includes(record.name))
          ? [{ name: record.name, config: record.config }]
          : []
      );
      if (targets.length) {
        const results = await probe(targets);
        for (const target of targets)
          statuses.set(target.name, {
            signature: signature(target.config),
            status: results.get(target.name)!
          });
      }
      return this.list();
    },

    /** Try a draft before it is saved. */
    async test(name: string, raw: unknown): Promise<McpStatus> {
      const config = validConfig(name, raw);
      return (await probe([{ name, config }])).get(name)!;
    },

    /** Add a server, or replace `previousName` (which may rename it). */
    async save(name: string, raw: unknown, previousName?: string) {
      const config = validConfig(name, raw);
      await update(async (records) => {
        const index = previousName ? records.findIndex((record) => record.name === previousName) : -1;
        if (previousName && index < 0)
          throw new HttpError(404, `没有名为 ${previousName} 的服务`, "mcp_server_not_found");
        const clash = records.find((record, at) => at !== index && sameMcpServerName(record.name, name));
        if (clash) throw new HttpError(409, `已存在同名服务：${clash.name}`, "mcp_server_exists");
        const entry = { name, config };
        if (index >= 0) records.splice(index, 1, entry);
        else records.push(entry);
        await save(records);
      });
      return this.list();
    },

    async importJson(text: string, replace: boolean) {
      let entries: Array<{ name: string; config: McpServerConfig }>;
      try {
        entries = parseMcpImport(text);
      } catch (error) {
        throw new HttpError(400, (error as Error).message, "mcp_import_invalid");
      }
      await update(async (records) => {
        for (const entry of entries) {
          const index = records.findIndex((record) => sameMcpServerName(record.name, entry.name));
          if (index >= 0 && !replace)
            throw new HttpError(409, `已存在同名服务：${records[index].name}`, "mcp_server_exists");
          if (index >= 0) records.splice(index, 1, entry);
          else records.push(entry);
        }
        await save(records);
      });
      return { imported: entries.map((entry) => entry.name), ...(await this.list()) };
    },

    async remove(name: string) {
      await update(async (records) => {
        find(records, name);
        await save(records.filter((record) => record.name !== name));
      });
      statuses.delete(name);
      return this.list();
    },

    async setEnabled(name: string, enabled: boolean) {
      await update(async (records) => {
        const record = find(records, name);
        if (!record.config) throw new HttpError(400, record.error ?? "配置不合法", "mcp_server_invalid");
        const { enabled: _previous, ...rest } = record.config;
        record.config = enabled ? rest : { ...rest, enabled: false };
        await save(records);
      });
      return this.list();
    },

    /** The server's default exposure and per-tool overrides; `null` clears an override. */
    async setExposure(
      name: string,
      change: { exposure?: McpExposure; tools?: Record<string, McpExposure | null> }
    ) {
      await update(async (records) => {
        const record = find(records, name);
        if (!record.config) throw new HttpError(400, record.error ?? "配置不合法", "mcp_server_invalid");
        const config = { ...record.config };
        if (change.exposure) {
          if (change.exposure === DEFAULT_MCP_EXPOSURE) delete config.exposure;
          else config.exposure = change.exposure;
        }
        if (change.tools) {
          const tools = { ...config.toolExposure };
          for (const [tool, value] of Object.entries(change.tools)) {
            if (value === null) delete tools[tool];
            else tools[tool] = value;
          }
          if (Object.keys(tools).length) config.toolExposure = tools;
          else delete config.toolExposure;
        }
        record.config = config;
        await save(records);
      });
      return this.list();
    },

    /**
     * Start an OAuth sign-in. Pi opens the authorization page in the browser and
     * waits for its loopback callback; the page's address is also returned for
     * a browser that did not open.
     */
    async login(name: string) {
      const records = await readMcpServers(options.home);
      const record = find(records, name);
      if (!record.config || !usesOAuth(record.config))
        throw new HttpError(400, "这个服务不使用 OAuth 登录", "mcp_login_unsupported");
      if (logins.get(name)?.state === "waiting") return this.list();
      const config = record.config;
      const login: McpLogin = { state: "waiting" };
      logins.set(name, login);
      let resolveUrl: () => void = () => undefined;
      const urlSeen = new Promise<void>((done) => (resolveUrl = done));
      const finished = piMcp(
        [{ name, config }],
        ["login", name, "-l", "--timeout", String(LOGIN_TIMEOUT_SECONDS)],
        (stdout) => {
          const match = /in your browser:\s*\n(https?:\/\/\S+)/.exec(stdout);
          if (match && !login.url) {
            login.url = match[1];
            resolveUrl();
          }
        }
      ).then(
        async ({ code, stdout, stderr }) => {
          if (code === 0) {
            logins.delete(name);
            await this.check([name]);
          } else {
            logins.set(name, { state: "failed", error: lastLine(stderr) ?? lastLine(stdout) ?? "登录失败" });
          }
        },
        (error: Error) => logins.set(name, { state: "failed", error: error.message })
      );
      // Answer once the page address is known or the attempt is over (for
      // example, a server that is already signed in).
      await Promise.race([urlSeen, finished, new Promise((done) => setTimeout(done, 15_000))]);
      return this.list();
    },

    async logout(name: string) {
      const records = await readMcpServers(options.home);
      const record = find(records, name);
      if (!record.config || !usesOAuth(record.config))
        throw new HttpError(400, "这个服务不使用 OAuth 登录", "mcp_login_unsupported");
      const { code, stdout, stderr } = await piMcp([{ name, config: record.config }], ["logout", name, "-l"]);
      if (code !== 0)
        throw new HttpError(500, lastLine(stderr) ?? lastLine(stdout) ?? "退出登录失败", "mcp_logout_failed");
      logins.delete(name);
      statuses.delete(name);
      return this.list();
    }
  };
}

export type McpService = ReturnType<typeof createMcpService>;
