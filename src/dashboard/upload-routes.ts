import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./http.js";
import { InputStore, MAX_UPLOAD_BYTES } from "../workspace/input-store.js";
import { readFilePreview } from "../workspace/file-preview.js";
export async function handleUploadRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  store: InputStore
) {
  if (url.pathname === "/api/uploads" && request.method === "POST") {
    if (Number(request.headers["content-length"] || 0) > MAX_UPLOAD_BYTES) {
      sendJson(response, 413, { error: "文件超过25 MB" });
      return true;
    }
    const file = await store.receive(url.searchParams.get("name") || "", request);
    sendJson(response, 201, file);
    return true;
  }
  const preview = url.pathname.match(/^\/api\/uploads\/(upload-[a-f0-9-]{36})\/preview$/);
  if (preview && request.method === "GET") {
    const { file, absolutePath } = await store.read(preview[1]);
    const page = url.searchParams.get("page");
    const raw = `/api/uploads/${file.uploadId}`;
    sendJson(response, 200, {
      file,
      path: file.name,
      ...(await readFilePreview({
        absolutePath,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        ...(page === null ? {} : { page: Math.max(1, Math.floor(Number(page)) || 1) })
      })),
      version: file.sha256,
      rawUrl: raw,
      downloadUrl: raw
    });
    return true;
  }
  const match = url.pathname.match(/^\/api\/uploads\/(upload-[a-f0-9-]{36})$/);
  if (match && request.method === "GET") {
    const { file, bytes } = await store.read(match[1]);
    response.writeHead(200, {
      "content-type": file.mimeType,
      "content-length": bytes.length,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-disposition": `${file.kind === "image" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`
    });
    response.end(bytes);
    return true;
  }
  return false;
}
