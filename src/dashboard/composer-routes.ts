import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson } from "./http.js";
import type { ComposerService } from "./composer-service.js";

function projectIdOf(url: URL): string | undefined {
  const projectId = url.searchParams.get("projectId")?.trim();
  if (projectId && projectId.length > 200) throw new HttpError(400, "项目参数不合法");
  return projectId || undefined;
}

/** The composer's `/` and `@` menus: skills and prompt templates, project files, MCP resources. */
export async function handleComposerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  composer: ComposerService | undefined
): Promise<boolean> {
  if (!composer || !url.pathname.startsWith("/api/composer/")) return false;
  if (request.method !== "GET") throw new HttpError(405, "method not allowed");
  switch (url.pathname) {
    case "/api/composer/slash":
      sendJson(response, 200, await composer.slash(projectIdOf(url)));
      return true;
    case "/api/composer/files": {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (query.length > 200) throw new HttpError(400, "搜索内容过长");
      sendJson(response, 200, await composer.files(projectIdOf(url), query));
      return true;
    }
    case "/api/composer/agents":
      sendJson(response, 200, await composer.agents(projectIdOf(url)));
      return true;
    case "/api/composer/resources":
      sendJson(response, 200, await composer.resources());
      return true;
    default:
      return false;
  }
}
