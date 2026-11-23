import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extractDocument } from "./input-reader.js";
import { mimeTypeOf, previewKindOf, type PreviewKind } from "./file-types.js";

/** Longest text a preview reads; the rest stays in the original file. */
export const TEXT_PREVIEW_BYTES = 1024 * 1024;
/** Most characters an Office preview extracts. */
const OFFICE_PREVIEW_CHARS = 20_000;

export interface FilePreview {
  previewKind: PreviewKind;
  mimeType: string;
  size: number;
  /** Text, or the text extracted from an Office file. */
  content?: string;
  truncated: boolean;
  /** Why a file that could have been shown is offered as a download instead. */
  notice?: string;
  /** One rendered PDF page, PNG in base64. */
  image?: string;
  page?: number;
  pages?: number;
}

/**
 * The one reader behind every file preview: artifacts, attachments, project
 * files. The caller has already resolved and contained the path; this decides
 * how the file is shown and reads only a bounded part of it.
 */
export async function readFilePreview(input: {
  absolutePath: string;
  name: string;
  size: number;
  mimeType?: string;
  /** A PDF page to render; without it a PDF preview carries no page. */
  page?: number;
  harnessRoot?: string;
}): Promise<FilePreview> {
  const mimeType = input.mimeType ?? mimeTypeOf(input.name);
  const kind = previewKindOf(mimeType);
  const base = { mimeType, size: input.size, truncated: false };
  if (kind === "pdf") {
    if (input.page === undefined) return { ...base, previewKind: "pdf" };
    const rendered = await extractDocument(input.absolutePath, {
      page: input.page,
      render: true,
      harnessRoot: input.harnessRoot
    });
    return {
      ...base,
      previewKind: "pdf",
      ...(rendered.image ? { image: rendered.image } : {}),
      ...(rendered.page === undefined ? {} : { page: rendered.page }),
      ...(rendered.pages === undefined ? {} : { pages: rendered.pages })
    };
  }
  if (kind === "image" || kind === "download") return { ...base, previewKind: kind };
  if (kind === "office") {
    try {
      const extracted = await extractDocument(input.absolutePath, {
        limit: OFFICE_PREVIEW_CHARS,
        harnessRoot: input.harnessRoot
      });
      return {
        ...base,
        previewKind: "office",
        content: extracted.text ?? "",
        truncated: extracted.nextOffset !== null && extracted.nextOffset !== undefined
      };
    } catch (error) {
      // A damaged file, or a machine without the parser, still downloads.
      return { ...base, previewKind: "download", notice: (error as Error).message };
    }
  }
  const text = await readText(input.absolutePath, input.size);
  if (text === undefined) return { ...base, previewKind: "download" };
  return { ...base, previewKind: "text", content: text.content, truncated: text.truncated };
}

/** The leading text of a file, or undefined when its bytes are not UTF-8 text. */
async function readText(
  absolutePath: string,
  size: number
): Promise<{ content: string; truncated: boolean } | undefined> {
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(Math.min(size, TEXT_PREVIEW_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const data = buffer.subarray(0, bytesRead);
    if (data.includes(0)) return undefined;
    const truncated = size > bytesRead;
    try {
      // Stream decoding leaves an incomplete trailing codepoint of a cut
      // preview out; the full original bytes stay downloadable.
      return {
        content: new TextDecoder("utf-8", { fatal: true }).decode(data, { stream: truncated }),
        truncated
      };
    } catch (error) {
      if (error instanceof TypeError) return undefined;
      throw error;
    }
  } finally {
    await handle.close();
  }
}
