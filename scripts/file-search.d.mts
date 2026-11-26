export interface FindParameters {
  pattern: string;
  path?: string;
  limit?: number;
}
export interface GrepParameters extends FindParameters {
  glob?: string;
  literal?: boolean;
  ignoreCase?: boolean;
  context?: number;
}
export interface AutocompleteParameters {
  pattern?: string;
  path?: string;
  limit?: number;
  glob?: boolean;
  ignoreCase?: boolean;
  fullPath?: boolean;
  follow?: boolean;
  maxDepth?: number;
  types?: ("f" | "d")[];
  exclude?: string[];
}
export interface FindResult {
  paths: string[];
  limitReached: boolean;
}
export interface GrepResult {
  text: string;
  matchCount: number;
  limitReached: boolean;
  skippedFiles: string[];
  outputLimitReached: boolean;
  linesTruncated: boolean;
  matches: { path: string; lineNumber: number; line: string }[];
  lines: { path: string; lineNumber: number; line: string; isMatch: boolean }[];
}
export interface SearchOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export function resultLimit(value: number | undefined, fallback: number): number;
export function assertPattern(value: unknown): string;
export function findFiles(parameters: FindParameters, cwd?: string): Promise<FindResult>;
export function grepFiles(parameters: GrepParameters, cwd?: string): Promise<GrepResult>;
export function runFileSearch(
  operation: "find",
  parameters: FindParameters,
  options?: SearchOptions
): Promise<FindResult>;
export function runFileSearch(
  operation: "grep",
  parameters: GrepParameters,
  options?: SearchOptions
): Promise<GrepResult>;
export const SEARCH_ADAPTER_MARKER: string;
/**
 * Exact disk search for Main and the Reviewer tools. Uses a real fd (find) or
 * rg (grep) found on PATH and falls back to the portable Node implementation
 * when the tool is missing or the request needs semantics the native tool does
 * not provide. `literal: true` selects literal matching; the default keeps
 * runFileSearch's JavaScript regular-expression behavior.
 */
export function runDiskSearch(
  operation: "find",
  parameters: FindParameters,
  options?: SearchOptions
): Promise<FindResult>;
export function runDiskSearch(
  operation: "grep",
  parameters: GrepParameters,
  options?: SearchOptions
): Promise<GrepResult>;
export function runDiskSearch(
  operation: "autocomplete",
  parameters: AutocompleteParameters,
  options?: SearchOptions
): Promise<FindResult>;
