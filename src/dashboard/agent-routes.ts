import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import type { AgentScope, AgentService } from "./agent-service.js";

const scopeSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("global") }).strict(),
  z.object({ scope: z.literal("project"), projectId: z.string().trim().min(1).max(200) }).strict()
]);
const name = z.string().trim().min(1).max(64);

const saveSchema = z
  .object({ target: scopeSchema, definition: z.unknown(), previousName: name.optional() })
  .strict();
const entrySchema = z.object({ target: scopeSchema, name }).strict();
const enabledSchema = z.object({ target: scopeSchema, name, enabled: z.boolean() }).strict();
const trustSchema = z
  .object({ projectId: z.string().trim().min(1).max(200), trust: z.enum(["trusted", "untrusted"]) })
  .strict();

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, "Agent 请求参数不合法", "agent_input_invalid");
  return result.data;
}

function scopeFromQuery(url: URL): AgentScope {
  const scope = url.searchParams.get("scope");
  return parsed(
    scopeSchema,
    scope === "project" ? { scope, projectId: url.searchParams.get("projectId") } : { scope }
  );
}

/** Settings → Agent: lists, editor options, save, switch on/off, delete, and project trust. */
export async function handleAgentRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  agents: AgentService | undefined
): Promise<boolean> {
  if (!agents || !url.pathname.startsWith("/api/agents")) return false;
  const get = () => {
    if (request.method !== "GET") throw new HttpError(405, "method not allowed");
  };
  const post = async () => {
    if (request.method !== "POST") throw new HttpError(405, "method not allowed");
    return readJsonBody(request);
  };
  switch (url.pathname) {
    case "/api/agents":
      get();
      sendJson(response, 200, await agents.list(scopeFromQuery(url)));
      return true;
    case "/api/agents/options":
      get();
      sendJson(response, 200, await agents.options(scopeFromQuery(url)));
      return true;
    case "/api/agents/trust-preview": {
      get();
      const projectId = url.searchParams.get("projectId")?.trim();
      if (!projectId || projectId.length > 200) throw new HttpError(400, "项目参数不合法");
      sendJson(response, 200, await agents.trustPreview(projectId));
      return true;
    }
    case "/api/agents/save": {
      const body = parsed(saveSchema, await post());
      sendJson(response, 200, await agents.save(body.target, body.definition, body.previousName));
      return true;
    }
    case "/api/agents/enabled": {
      const body = parsed(enabledSchema, await post());
      sendJson(response, 200, await agents.setEnabled(body.target, body.name, body.enabled));
      return true;
    }
    case "/api/agents/delete": {
      const body = parsed(entrySchema, await post());
      sendJson(response, 200, await agents.delete(body.target, body.name));
      return true;
    }
    case "/api/agents/trust": {
      const body = parsed(trustSchema, await post());
      sendJson(response, 200, await agents.trust(body.projectId, body.trust));
      return true;
    }
    default:
      return false;
  }
}
