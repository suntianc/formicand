import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { MCP_EXPOSURES } from "../runtime/mcp-config.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import type { McpService } from "./mcp-service.js";

const name = z.string().trim().min(1).max(64);
const exposure = z.enum(MCP_EXPOSURES);
const schemas = {
  check: z.object({ names: z.array(name).max(500).optional() }).strict(),
  test: z.object({ name, config: z.unknown() }).strict(),
  save: z.object({ name, config: z.unknown(), previousName: name.optional() }).strict(),
  import: z.object({ text: z.string().min(1).max(1_000_000), replace: z.boolean().optional() }).strict(),
  named: z.object({ name }).strict(),
  enabled: z.object({ name, enabled: z.boolean() }).strict(),
  exposure: z
    .object({
      name,
      exposure: exposure.optional(),
      tools: z.record(z.string().min(1), exposure.nullable()).optional()
    })
    .strict()
};

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, "MCP 请求参数不合法", "mcp_input_invalid");
  return result.data;
}

/** MCP settings: the servers in `~/.formicand/mcp.json`, their connection checks and OAuth sign-in. */
export async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  mcp: McpService | undefined
): Promise<boolean> {
  if (!mcp || !(url.pathname === "/api/mcp" || url.pathname.startsWith("/api/mcp/"))) return false;
  if (url.pathname === "/api/mcp") {
    if (request.method !== "GET") throw new HttpError(405, "method not allowed");
    sendJson(response, 200, await mcp.list());
    return true;
  }
  if (request.method !== "POST") throw new HttpError(405, "method not allowed");
  const action = url.pathname.slice("/api/mcp/".length);
  const body = await readJsonBody(request);
  const reply = async (value: Promise<unknown>) => {
    sendJson(response, 200, await value);
    return true;
  };
  switch (action) {
    case "check":
      return reply(mcp.check(parsed(schemas.check, body).names));
    case "test": {
      const input = parsed(schemas.test, body);
      return reply(mcp.test(input.name, input.config));
    }
    case "save": {
      const input = parsed(schemas.save, body);
      return reply(mcp.save(input.name, input.config, input.previousName));
    }
    case "import": {
      const input = parsed(schemas.import, body);
      return reply(mcp.importJson(input.text, input.replace ?? false));
    }
    case "remove":
      return reply(mcp.remove(parsed(schemas.named, body).name));
    case "enabled": {
      const input = parsed(schemas.enabled, body);
      return reply(mcp.setEnabled(input.name, input.enabled));
    }
    case "exposure": {
      const input = parsed(schemas.exposure, body);
      return reply(mcp.setExposure(input.name, { exposure: input.exposure, tools: input.tools }));
    }
    case "login":
      return reply(mcp.login(parsed(schemas.named, body).name));
    case "logout":
      return reply(mcp.logout(parsed(schemas.named, body).name));
    default:
      return false;
  }
}
