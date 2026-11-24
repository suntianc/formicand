import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson } from "./http.js";
import { LinkPreviewRefused, type LinkPreviewService } from "./link-preview-service.js";

/** `GET /api/link-preview?url=…`: the icon and title behind a web link in a message. */
export async function handleLinkPreviewRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  previews: LinkPreviewService | undefined
): Promise<boolean> {
  if (!previews || url.pathname !== "/api/link-preview") return false;
  if (request.method !== "GET") throw new HttpError(405, "method not allowed");
  const address = url.searchParams.get("url") ?? "";
  if (!address || address.length > 2048)
    throw new HttpError(400, "链接地址缺失或过长", "link_preview_invalid");
  try {
    response.setHeader("cache-control", "private, max-age=3600");
    sendJson(response, 200, await previews.preview(address));
  } catch (error) {
    if (error instanceof LinkPreviewRefused) throw new HttpError(422, error.message, "link_preview_refused");
    throw error;
  }
  return true;
}
