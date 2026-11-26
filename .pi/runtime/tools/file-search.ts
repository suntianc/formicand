import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  truncateHead,
  formatSize
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { IndexedFileSearch } from "../../../dist/src/runtime/indexed-file-search.js";
import { assertPattern, resultLimit, runDiskSearch } from "../../../scripts/file-search.mjs";

interface SearchDetails {
  resultLimitReached?: number;
  matchLimitReached?: number;
  skippedFiles?: string[];
  linesTruncated?: boolean;
  outputLimitReached?: boolean;
  truncation?: ReturnType<typeof truncateHead>;
}

function output(text: string, details: SearchDetails) {
  const truncation = truncateHead(text, { maxLines: Number.MAX_SAFE_INTEGER });
  const notices: string[] = [];
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(truncation.maxBytes)} limit reached`);
  }
  if (details.resultLimitReached) notices.push(`${details.resultLimitReached} results limit reached`);
  if (details.matchLimitReached) notices.push(`${details.matchLimitReached} matches limit reached`);
  if (details.outputLimitReached) notices.push("64KB search output limit reached");
  if (details.linesTruncated) notices.push("Some lines truncated. Use read to see full lines");
  if (details.skippedFiles?.length) notices.push(`${details.skippedFiles.length} oversized files skipped`);
  return {
    content: [
      {
        type: "text" as const,
        text: truncation.content + (notices.length ? `\n\n[${notices.join(". ")}]` : "")
      }
    ],
    details: Object.keys(details).length ? details : undefined
  };
}

export function registerSearchTools(pi: ExtensionAPI, cwd: string): void {
  const index = new IndexedFileSearch(resolve(cwd));
  const find = createFindToolDefinition(cwd);
  const grep = createGrepToolDefinition(cwd);
  pi.on("session_shutdown", () => index.close());
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.addAutocompleteProvider((current) => ({
      ...current,
      async getSuggestions(lines, line, col, options) {
        const prefix = lines[line].slice(0, col).match(/(?:^|\s)(@(?:"[^"]*|[^\s"]*))$/)?.[1];
        if (prefix) {
          try {
            const query = prefix.slice(prefix.startsWith('@"') ? 2 : 1);
            const { paths } = await index.names(query, 20, undefined, options.signal);
            if (paths.length && !options.signal.aborted)
              return {
                prefix,
                items: paths.map((path) => ({
                  value: /\s/.test(path) ? `@"${path}"` : `@${path}`,
                  label: basename(path),
                  description: path
                }))
              };
          } catch (error) {
            if (options.signal.aborted) return null;
            ctx.ui.notify(
              `File completion: ${error instanceof Error ? error.message : String(error)}`,
              "warning"
            );
          }
        }
        return current.getSuggestions(lines, line, col, options);
      },
      applyCompletion: current.applyCompletion.bind(current),
      shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current)
    }));
  });
  pi.registerTool({
    ...find,
    description: "Find files by fuzzy name or by an exact path or glob relative to the search directory.",
    parameters: Type.Object({
      ...find.parameters.properties,
      pattern: Type.String({ description: "Fuzzy filename, exact path, or glob such as './src/*.ts'." })
    }),
    async execute(_id, params, signal) {
      const pattern = assertPattern(params.pattern);
      const limit = resultLimit(params.limit, 1000);
      if (
        !pattern.trim() ||
        /[\\/*?[{]|[!+@]\(/.test(pattern) ||
        (params.path && !(await stat(resolve(cwd, params.path))).isDirectory())
      ) {
        const result = await runDiskSearch("find", params, { cwd, signal });
        const body = result.paths.join("\n") || "No files found matching pattern";
        return output(body, result.limitReached ? { resultLimitReached: limit } : {});
      }
      const result = await index.names(pattern, limit, params.path, signal);
      return output(
        result.paths.join("\n") || "No files found matching pattern",
        result.truncated ? { resultLimitReached: limit } : {}
      );
    }
  });
  pi.registerTool({
    ...grep,
    description:
      "Search file contents. Default exploration suggests similar lines on a miss. Use mode 'exact' to search current files on disk, case-sensitive and literal by default.",
    parameters: Type.Object({
      ...grep.parameters.properties,
      literal: Type.Optional(
        Type.Boolean({
          description: "Match literal text (exact mode default). Set false to use a regular expression."
        })
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("explore"), Type.Literal("exact")], {
          description: "Choose indexed exploration or exact disk search."
        })
      )
    }),
    async execute(_id, params, signal) {
      const pattern = assertPattern(params.pattern);
      const limit = resultLimit(params.limit, 100);
      const disk =
        !pattern.trim() ||
        params.mode === "exact" ||
        params.glob !== undefined ||
        params.literal !== undefined ||
        params.ignoreCase !== undefined ||
        params.context !== undefined ||
        (params.mode !== "explore" && /[.*+?^${}()|[\]\\]/.test(params.pattern));
      if (disk) {
        const result = await runDiskSearch(
          "grep",
          { ...params, literal: params.literal ?? params.mode === "exact" },
          { cwd, signal }
        );
        const body = result.text || "No matches found";
        return output(body, {
          ...(result.limitReached ? { matchLimitReached: limit } : {}),
          ...(result.linesTruncated ? { linesTruncated: true } : {}),
          ...(result.outputLimitReached ? { outputLimitReached: true } : {}),
          ...(result.skippedFiles.length ? { skippedFiles: result.skippedFiles } : {})
        });
      }
      const result = await index.content(pattern, limit, params.path, signal);
      return output(result.text, {
        ...(result.truncated ? { matchLimitReached: limit } : {}),
        ...(result.linesTruncated ? { linesTruncated: true } : {})
      });
    }
  });
}
