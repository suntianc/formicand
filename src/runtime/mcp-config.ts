import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite } from "../storage/atomic-file.js";

/**
 * The one MCP configuration, `~/.atria/mcp.json`, shared by every project.
 *
 * The file uses the `mcpServers` shape other MCP clients use, so an entry can
 * be copied between them. Pi's own `mcp.json` stays empty: the extension
 * registers the servers a process may use with `pi.registerMcpServer`. Only
 * three exposures are offered: tools declared to the model (`direct`), found
 * through `tool_search` (`deferred`, the default) or unreachable (`hidden`).
 * Codemode is not enabled in CoworkOS, so its exposure is refused.
 */
export const MCP_EXPOSURES = ["direct", "deferred", "hidden"] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];
export const DEFAULT_MCP_EXPOSURE: McpExposure = "deferred";

/** Letters, digits, `_` and `-`, as Pi requires; tools are named `mcp__<server>__<tool>`. */
export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const exposure = z.enum(MCP_EXPOSURES, {
  error: () => "可见方式只能是 direct、deferred 或 hidden"
});
const stringMap = z.record(z.string(), z.string());
const common = {
  enabled: z.boolean().optional(),
  exposure: exposure.optional(),
  toolExposure: z.record(z.string().min(1), exposure).optional(),
  description: z.string().max(500).optional(),
  timeout: z.number().positive().max(3600).optional()
};
const stdioSchema = z
  .object({
    type: z.literal("stdio").optional(),
    command: z.string().trim().min(1, "命令不能为空"),
    args: z.array(z.string()).optional(),
    env: stringMap.optional(),
    cwd: z.string().min(1).optional(),
    ...common
  })
  .strip();
const httpSchema = z
  .object({
    type: z.enum(["http", "streamable-http"]).optional(),
    url: z
      .string()
      .trim()
      .refine(
        (value) => /^https?:\/\//i.test(value) && URL.canParse(value),
        "地址必须以 http:// 或 https:// 开头"
      ),
    headers: stringMap.optional(),
    oauth: z.record(z.string(), z.unknown()).optional(),
    ...common
  })
  .strip();

export type McpStdioServer = z.infer<typeof stdioSchema>;
export type McpHttpServer = z.infer<typeof httpSchema>;
export type McpServerConfig = McpStdioServer | McpHttpServer;

export interface McpServerRecord {
  name: string;
  /** Absent when the entry is invalid; `error` then says why. */
  config?: McpServerConfig;
  error?: string;
  /** An invalid entry as written, so saving other changes keeps it. */
  raw?: unknown;
}

export function mcpConfigPath(home: string): string {
  return join(home, "mcp.json");
}

export function isHttpServer(config: McpServerConfig): config is McpHttpServer {
  return "url" in config;
}

/** Validate one entry. Messages are shown in the settings page as they are. */
export function parseMcpServer(name: string, raw: unknown): { config: McpServerConfig } | { error: string } {
  if (!MCP_SERVER_NAME.test(name)) return { error: "名称只能包含字母、数字、_ 和 -" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "配置必须是一个对象" };
  const entry = raw as Record<string, unknown>;
  if (entry.type === "sse") return { error: "不支持 SSE 连接，请改用服务提供的 streamable HTTP 地址" };
  if (entry.exposure === "codemode" || entry.exposure === "codemode-deferred")
    return { error: "可见方式只能是 direct、deferred 或 hidden" };
  const hasCommand = "command" in entry;
  const hasUrl = "url" in entry;
  if (hasCommand === hasUrl) return { error: "需要且只能填写 command（本地命令）或 url（远程地址）之一" };
  const result = (hasCommand ? stdioSchema : httpSchema).safeParse(entry);
  if (!result.success) return { error: result.error.issues[0]?.message ?? "配置不合法" };
  return { config: result.data };
}

/** Two names that differ only in `-` and `_` are the same server to Pi. */
export function sameMcpServerName(left: string, right: string): boolean {
  return left.replaceAll("-", "_") === right.replaceAll("-", "_");
}

function parseFile(text: string, path: string): McpServerRecord[] {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${path}: 必须是一个对象`);
  const servers = (parsed as { mcpServers?: unknown }).mcpServers ?? {};
  if (typeof servers !== "object" || Array.isArray(servers))
    throw new Error(`${path}: "mcpServers" 必须是一个对象`);
  return Object.entries(servers).map(([name, raw]) => {
    const result = parseMcpServer(name, raw);
    return "config" in result ? { name, config: result.config } : { name, error: result.error, raw };
  });
}

export async function readMcpServers(home: string): Promise<McpServerRecord[]> {
  const path = mcpConfigPath(home);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return parseFile(text, path);
}

export function readMcpServersSync(home: string): McpServerRecord[] {
  const path = mcpConfigPath(home);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return parseFile(text, path);
}

/** The file may hold tokens in `env` and `headers`, so only the owner can read it. */
export async function writeMcpServers(home: string, servers: Array<{ name: string; config: unknown }>) {
  const mcpServers = Object.fromEntries(servers.map((server) => [server.name, server.config]));
  await atomicWrite(mcpConfigPath(home), `${JSON.stringify({ mcpServers }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Entries pasted from another client: `{ "mcpServers": {...} }`, VS Code's
 * `{ "servers": {...} }`, or the bare map of servers.
 */
export function parseMcpImport(text: string): Array<{ name: string; config: McpServerConfig }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("不是有效的 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("JSON 必须是一个对象");
  const object = parsed as Record<string, unknown>;
  const map = (object.mcpServers ?? object.servers ?? object) as unknown;
  if (typeof map !== "object" || map === null || Array.isArray(map)) throw new Error("没有找到服务列表");
  const entries = Object.entries(map);
  if (entries.length === 0) throw new Error("没有找到服务");
  return entries.map(([name, raw]) => {
    const result = parseMcpServer(name, raw);
    if ("error" in result) throw new Error(`${name}：${result.error}`);
    return { name, config: result.config };
  });
}

/** What Pi receives for one server: the stored entry with CoworkOS's default exposure. */
export function piMcpServerConfig(config: McpServerConfig): McpServerConfig {
  const { enabled: _enabled, ...rest } = config;
  return { ...rest, exposure: config.exposure ?? DEFAULT_MCP_EXPOSURE };
}

/** The servers a Main process registers: every valid, enabled entry. */
export function enabledMcpServers(
  records: McpServerRecord[]
): Array<{ name: string; config: McpServerConfig }> {
  return records.flatMap((record) =>
    record.config && record.config.enabled !== false ? [{ name: record.name, config: record.config }] : []
  );
}
