import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { readFilePreview } from "../workspace/file-preview.js";
import { mimeTypeOf } from "../workspace/file-types.js";
import { HttpError } from "./http.js";

/** A file one source has already resolved and contained, ready to be served. */
export interface ServedFile {
  absolutePath: string;
  stat: Stats;
  /** The path the request named, echoed in the preview. */
  path: string;
  mimeType?: string;
  /** Changes whenever the bytes do; the ETag and the client's cache key. */
  version: string;
  /** This file's own URL without the raw/download/page parameters. */
  endpoint: string;
}

/** The request's PDF page, when it asks for one. */
function requestedPage(url: URL): number | undefined {
  const value = url.searchParams.get("page");
  if (value === null) return undefined;
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1) throw new HttpError(400, "页码不合法");
  return page;
}

/**
 * Serve one file: its bounded preview by default, its bytes with `raw=1`
 * (ranges supported) or as an attachment with `download=1`.
 */
export async function serveFile(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  file: ServedFile
): Promise<void> {
  const { absolutePath, stat } = file;
  const mimeType = file.mimeType ?? mimeTypeOf(file.path);
  const version = file.version;
  const raw = url.searchParams.get("raw") === "1";
  const download = url.searchParams.get("download") === "1";
  const separator = file.endpoint.includes("?") ? "&" : "?";
  if (!raw && !download) {
    const preview = await readFilePreview({
      absolutePath,
      name: file.path,
      size: stat.size,
      mimeType,
      page: requestedPage(url)
    });
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-cache"
    });
    response.end(
      JSON.stringify({
        path: file.path,
        ...preview,
        version,
        rawUrl: `${file.endpoint}${separator}raw=1`,
        downloadUrl: `${file.endpoint}${separator}download=1`
      })
    );
    return;
  }
  const disposition = readKind(mimeType);
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const rawMime = mimeType === "text/html" ? "text/plain; charset=utf-8" : mimeType;
    const filename = encodeURIComponent(basename(file.path)).replace(
      /['()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    );
    const headers: Record<string, string | number> = {
      "content-type": rawMime,
      "content-disposition": `${download || disposition === "download" ? "attachment" : "inline"}; filename*=UTF-8''${filename}`,
      "x-content-type-options": "nosniff",
      "accept-ranges": "bytes",
      "cache-control": "no-cache",
      etag: `"${version}"`
    };
    if (mimeType === "image/svg+xml")
      headers["content-security-policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
    let start = 0,
      end = stat.size - 1,
      status = 200;
    const ifRange = request.headers["if-range"];
    const sameRangeVersion =
      !ifRange ||
      (typeof ifRange === "string" &&
        (ifRange === headers.etag ||
          (Number.isFinite(Date.parse(ifRange)) &&
            Math.floor(stat.mtimeMs / 1000) <= Math.floor(Date.parse(ifRange) / 1000))));
    if (request.headers.range && sameRangeVersion) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (range && (range[1] || range[2])) {
        start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
        end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      }
      if (
        !range ||
        !(range[1] || range[2]) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start > end ||
        start >= stat.size
      ) {
        response.writeHead(416, { ...headers, "content-range": `bytes */${stat.size}` });
        response.end();
        return;
      }
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers["content-length"] = Math.max(0, end - start + 1);
    response.writeHead(status, headers);
    if (stat.size === 0) {
      response.end();
      return;
    }
    await pipeline(handle.createReadStream({ start, end, autoClose: false }), response);
  } finally {
    await handle.close();
  }
}

/** Raw bytes of a type the browser would run or cannot show are sent as an attachment. */
function readKind(mimeType: string): "inline" | "download" {
  return mimeType === "application/pdf" ||
    mimeType.startsWith("image/") ||
    mimeType.startsWith("text/") ||
    ["application/json", "application/x-ndjson", "application/xml", "application/javascript"].includes(
      mimeType
    )
    ? "inline"
    : "download";
}
