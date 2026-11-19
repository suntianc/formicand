import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { atriaHome } from "../../scripts/data-home.cjs";
import {
  enabledMcpServers,
  piMcpServerConfig,
  readMcpServers,
  type McpServerConfig
} from "../../dist/src/runtime/mcp-config.js";

/**
 * Keep this process's MCP servers in step with `~/.atria/mcp.json`.
 *
 * Pi's own `mcp.json` stays empty; servers reach Pi only through
 * `registerMcpServer`, so the configuration CoworkOS manages is the only
 * source. A resident Main outlives the settings page, so `sync` runs again
 * at every turn: servers added or changed since are registered (registering a
 * name again replaces it), and servers removed or switched off are dropped.
 */
export function createMcpRegistration(
  pi: ExtensionAPI,
  home = atriaHome(),
  /** A custom Agent's servers: only these are registered. Omitted: every enabled server. */
  only?: readonly string[]
) {
  const registered = new Map<string, string>();
  /** Returns a problem to show the user; the turn goes on with the servers already registered. */
  const sync = async (): Promise<string | undefined> => {
    let records;
    try {
      records = await readMcpServers(home);
    } catch (error) {
      return `MCP 配置读取失败，本轮沿用已有服务：${error instanceof Error ? error.message : String(error)}`;
    }
    const wanted = new Map<string, McpServerConfig>(
      enabledMcpServers(records)
        .filter((server) => !only || only.includes(server.name))
        .map((server) => [server.name, piMcpServerConfig(server.config)])
    );
    const problems: string[] = [];
    for (const name of registered.keys()) {
      if (wanted.has(name)) continue;
      pi.unregisterMcpServer(name);
      registered.delete(name);
    }
    for (const [name, config] of wanted) {
      const signature = JSON.stringify(config);
      if (registered.get(name) === signature) continue;
      try {
        pi.registerMcpServer(name, config as Parameters<ExtensionAPI["registerMcpServer"]>[1]);
        registered.set(name, signature);
      } catch (error) {
        problems.push(`${name}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return problems.length ? `MCP 服务未能注册：${problems.join("；")}` : undefined;
  };
  return { sync, registered: () => [...registered.keys()] };
}
