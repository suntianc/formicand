import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { SKILL_ARCHIVE_LIMIT, type SkillScope, type SkillService } from "./skill-service.js";

const scopeSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("global") }).strict(),
  z.object({ scope: z.literal("project"), projectId: z.string().trim().min(1).max(200) }).strict()
]);

const path = z.string().trim().min(1).max(4096);

const previewSchema = z
  .object({
    target: scopeSchema,
    kind: z.enum(["folder", "git"]),
    location: z.string().trim().min(1).max(4096)
  })
  .strict();
const installSchema = z
  .object({
    target: scopeSchema,
    stagingId: z.string().uuid(),
    names: z.array(z.string().min(1).max(100)).min(1).max(200),
    replace: z.boolean().optional()
  })
  .strict();
const entrySchema = z.object({ target: scopeSchema, directory: path }).strict();
const trustSchema = z
  .object({ projectId: z.string().trim().min(1).max(200), trust: z.enum(["trusted", "untrusted"]) })
  .strict();

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, "技能请求参数不合法", "skill_input_invalid");
  return result.data;
}

function scopeFromQuery(url: URL): SkillScope {
  const scope = url.searchParams.get("scope");
  const projectId = url.searchParams.get("projectId");
  return parsed(scopeSchema, scope === "project" ? { scope, projectId } : { scope });
}

async function readArchive(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > SKILL_ARCHIVE_LIMIT) throw new HttpError(413, "压缩包超过 50 MB", "skill_archive_too_large");
    chunks.push(Buffer.from(chunk as Buffer));
  }
  if (!size) throw new HttpError(400, "压缩包为空", "skill_archive_invalid");
  return Buffer.concat(chunks);
}

/** Skill settings: list by scope, add from a folder, zip or Git, delete, and the index and trust decisions. */
export async function handleSkillRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  skills: SkillService | undefined
): Promise<boolean> {
  if (!skills || !url.pathname.startsWith("/api/skills")) return false;
  const post = async () => {
    if (request.method !== "POST") throw new HttpError(405, "method not allowed");
    return readJsonBody(request);
  };
  switch (url.pathname) {
    case "/api/skills":
      if (request.method !== "GET") throw new HttpError(405, "method not allowed");
      sendJson(response, 200, await skills.list(scopeFromQuery(url)));
      return true;
    case "/api/skills/preview": {
      const body = parsed(previewSchema, await post());
      sendJson(
        response,
        200,
        body.kind === "folder"
          ? await skills.previewFolder(body.location, body.target)
          : await skills.previewGit(body.location, body.target)
      );
      return true;
    }
    case "/api/skills/preview-archive":
      if (request.method !== "POST") throw new HttpError(405, "method not allowed");
      sendJson(response, 200, await skills.previewArchive(await readArchive(request), scopeFromQuery(url)));
      return true;
    case "/api/skills/install": {
      const body = parsed(installSchema, await post());
      sendJson(
        response,
        200,
        await skills.install(body.stagingId, body.names, body.target, body.replace ?? false)
      );
      return true;
    }
    case "/api/skills/remove":
    case "/api/skills/restore":
    case "/api/skills/delete": {
      const body = parsed(entrySchema, await post());
      const action = url.pathname.slice("/api/skills/".length) as "remove" | "restore" | "delete";
      sendJson(response, 200, await skills[action](body.target, body.directory));
      return true;
    }
    case "/api/skills/trust": {
      const body = parsed(trustSchema, await post());
      sendJson(response, 200, await skills.trust(body.projectId, body.trust));
      return true;
    }
    default:
      return false;
  }
}
