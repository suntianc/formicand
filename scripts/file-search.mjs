import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import ignore from "ignore";
import { minimatch } from "minimatch";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RESULTS = 20_000;
const MAX_LINE_CHARS = 1000;
const NATIVE_HEAD_BYTES = 4096;
const NATIVE_ERROR_BYTES = 64 * 1024;
const NATIVE_KILL_GRACE_MS = 2_000;
const ABORT_MESSAGE = "Operation aborted";
const TIMEOUT_MESSAGE = "File search timed out; narrow the search path or pattern.";

/** Marks the shell wrappers installed by search-tool-adapter.mjs; never treat them as native tools. */
export const SEARCH_ADAPTER_MARKER = "# Formicand Pi search adapter v1";

const normalize = (path) => path.split(sep).join("/");

export function resultLimit(value, fallback) {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS)
    throw new Error(`Search limit must be an integer between 1 and ${MAX_RESULTS}.`);
  return limit;
}

export function assertPattern(value) {
  if (typeof value !== "string" || value.length > 4096)
    throw new Error("Search pattern must be a string of at most 4096 characters.");
  return value;
}

async function readRules(directory) {
  const matcher = ignore();
  for (const name of [".gitignore", ".ignore"]) {
    try {
      matcher.add(await readFile(resolve(directory, name), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { directory, matcher };
}

async function ancestorRules(directory) {
  const ancestors = [];
  for (let current = dirname(directory); ; current = dirname(current)) {
    ancestors.push(current);
    try {
      await stat(resolve(current, ".git"));
      return Promise.all(ancestors.reverse().map(readRules));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (dirname(current) === current) return [];
  }
}

function ignored(path, isDirectory, rules) {
  let excluded = false;
  for (const { directory, matcher } of rules) {
    const local = normalize(relative(directory, path)) + (isDirectory ? "/" : "");
    if (!local || local.startsWith("../") || isAbsolute(local)) continue;
    const result = matcher.test(local);
    if (result.ignored) excluded = true;
    else if (result.unignored) excluded = false;
  }
  return excluded;
}

async function* entriesIn(directory, rules = [], options = {}, depth = 1, ancestors = new Set()) {
  const actual = await realpath(directory);
  if (ancestors.has(actual)) return;
  const visited = new Set([...ancestors, actual]);
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedRepository = rules.length > 0 && entries.some((entry) => entry.name === ".git");
  const localRules = [...(nestedRepository ? [] : rules), await readRules(directory)];
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = resolve(directory, entry.name);
    let info = entry;
    if (entry.isSymbolicLink()) {
      if (!options.follow) continue;
      try {
        info = await stat(path);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
    }
    if (ignored(path, info.isDirectory(), localRules)) continue;
    const local = normalize(relative(options.root || directory, path));
    if (options.exclude?.some((pattern) => globMatches(local, pattern))) continue;
    if (info.isDirectory()) {
      yield { path, directory: true };
      if (depth < (options.maxDepth ?? Infinity))
        yield* entriesIn(path, localRules, options, depth + 1, visited);
    } else if (info.isFile()) yield { path, directory: false };
  }
}

async function* files(directory, rules = []) {
  for await (const entry of entriesIn(directory, rules)) if (!entry.directory) yield entry.path;
}

function globMatches(path, pattern) {
  return minimatch(pattern.includes("/") ? path : basename(path), pattern, { dot: true });
}

/** Pi accepts a leading "./" in relative globs; fd and ripgrep anchor patterns elsewhere. */
function normalizedPattern(pattern) {
  return pattern.replace(/^(?:\.\/)+/, "");
}

/** minimatch supports extglobs, braces and negation that fd's globset and rg's globs read literally. */
function unsupportedGlobSyntax(pattern) {
  return (
    pattern.includes("\0") ||
    pattern.includes("\n") ||
    pattern.includes("\\") ||
    pattern.includes("{") ||
    /^[!#-]/.test(pattern) ||
    /\[[!^]/.test(pattern) ||
    /[?*+@!]\(/.test(pattern)
  );
}

/** fd's --full-path matches the absolute candidate, so relative path globs need the root prefix. */
function nativeGlobPattern(pattern, root) {
  const normalized = normalizedPattern(pattern);
  if (!normalized) return { pattern: "", fullPath: false };
  if (isAbsolute(normalized)) return undefined;
  if (!normalized.includes("/")) return { pattern: normalized, fullPath: false };
  const escapedRoot = root.replace(/\/+$/, "").replace(/[\\*?[\]{}]/g, "\\$&");
  return { pattern: `${escapedRoot}/${normalized}`, fullPath: true };
}

async function readFileHead(path) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(NATIVE_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, NATIVE_HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Locate a real fd/rg on PATH, skipping the shell adapters Formicand (and siblings) install. */
async function findNativeTool(name) {
  if (!["darwin", "linux"].includes(process.platform)) return undefined;
  const adapterPath = Buffer.from("search-tool-adapter.mjs");
  const marker = Buffer.from(SEARCH_ADAPTER_MARKER);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    let info;
    try {
      info = await stat(candidate);
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "ELOOP", "ENAMETOOLONG"].includes(error.code)) continue;
      throw error;
    }
    if (!info.isFile()) continue;
    try {
      await access(candidate, fsConstants.X_OK);
    } catch (error) {
      if (["EACCES", "ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) continue;
      throw error;
    }
    let head;
    try {
      head = await readFileHead(candidate);
    } catch (error) {
      if (["EACCES", "ENOENT", "ELOOP"].includes(error.code)) continue;
      throw error;
    }
    if (
      head.includes(marker) ||
      head.includes(adapterPath) ||
      /Pi (?:fd|rg) adapter/.test(head.toString("utf8"))
    )
      continue;
    return candidate;
  }
  return undefined;
}

async function isInsideRepository(directory) {
  for (let current = directory; ; current = dirname(current)) {
    try {
      await stat(resolve(current, ".git"));
      return true;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    if (dirname(current) === current) return false;
  }
}

/** Split a stream on NUL bytes so fd --print0 can carry file names containing newlines. */
async function* nulRecords(stream) {
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    for (let end = pending.indexOf(0, start); end !== -1; end = pending.indexOf(0, start)) {
      yield pending.toString("utf8", start, end);
      start = end + 1;
    }
    pending = pending.subarray(start);
  }
  if (pending.length) yield pending.toString("utf8");
}

/**
 * Stream a native search tool and stop it as soon as the consumer asks. The
 * child runs in its own process group so a timeout or abort also reaps helpers.
 */
async function runNativeLines({ command, args, cwd, signal, deadline, nul = false, onLine }) {
  if (signal?.aborted) throw new Error(ABORT_MESSAGE);
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });
  const lines = nul ? nulRecords(child.stdout) : createInterface({ input: child.stdout });
  let stderr = "";
  let terminalError;
  let stopped = false;
  let closed = false;
  let deadlineTimer;
  let killTimer;
  const closedPromise = new Promise((resolveClose, rejectClose) => {
    child.once("error", (error) => {
      if (closed) return;
      closed = true;
      rejectClose(error);
    });
    child.once("close", (code, closeSignal) => {
      if (closed) return;
      closed = true;
      resolveClose({ code, signal: closeSignal });
    });
  });
  const terminate = (name) => {
    try {
      if (process.platform === "win32") child.kill(name);
      else process.kill(-child.pid, name);
    } catch (error) {
      // The group is already gone (ESRCH); anything else leaves the close event to settle.
      if (error.code !== "ESRCH") return;
    }
  };
  const stop = () => {
    if (killTimer) return;
    terminate("SIGTERM");
    killTimer = setTimeout(() => terminate("SIGKILL"), NATIVE_KILL_GRACE_MS);
    killTimer.unref?.();
  };
  const onAbort = () => {
    terminalError ??= new Error(ABORT_MESSAGE);
    stop();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    terminalError = new Error(TIMEOUT_MESSAGE);
    stop();
  } else {
    deadlineTimer = setTimeout(() => {
      terminalError ??= new Error(TIMEOUT_MESSAGE);
      stop();
    }, remaining);
  }
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < NATIVE_ERROR_BYTES) stderr += chunk.toString();
  });
  try {
    for await (const line of lines) {
      if (terminalError) break;
      if (!line) continue;
      const shouldStop = await onLine(line);
      if (shouldStop) {
        stopped = true;
        stop();
        break;
      }
    }
  } catch (error) {
    terminalError ??= error;
    stop();
  } finally {
    clearTimeout(deadlineTimer);
    signal?.removeEventListener("abort", onAbort);
    lines.close?.();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  let exit;
  try {
    exit = await closedPromise;
  } catch (error) {
    throw terminalError ?? error;
  } finally {
    // Keep SIGKILL armed until the child has actually closed: a child that
    // ignores SIGTERM would otherwise leak after an early limit stop.
    clearTimeout(killTimer);
  }
  if (terminalError) throw terminalError;
  return { ...exit, stderr, stopped };
}

/** Count empty lines produced by trailing newline bytes, capped at the requested need. */
async function trailingNewlineCount(path, needed) {
  if (needed <= 0) return 0;
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, needed * 2 + 2);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    let count = 0;
    for (let index = buffer.length - 1; index >= 0 && count < needed; index--) {
      if (buffer[index] === 0x0a) count++;
      else if (buffer[index] !== 0x0d) break;
    }
    return count;
  } finally {
    await handle.close();
  }
}

/** A request the native tool cannot answer faithfully; callers rerun the portable backend. */
class NativeFallback extends Error {}

async function searchRoot(path, cwd) {
  const root = resolve(cwd, path || ".");
  try {
    return { root, info: await stat(root) };
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Path not found: ${root}`);
    throw error;
  }
}

/** Portable file-name search, used by both doctor and the Pi tool override. */
export async function findFiles(parameters, cwd = process.cwd()) {
  const pattern = assertPattern(parameters.pattern);
  const limit = resultLimit(parameters.limit, 1000);
  const { root, info } = await searchRoot(parameters.path, cwd);
  if (!info.isDirectory()) throw new Error(`Search path must be a directory: ${root}`);
  const paths = [];
  for await (const path of files(root, await ancestorRules(root))) {
    const local = normalize(relative(root, path));
    if (!globMatches(local, pattern)) continue;
    if (paths.length === limit) return { paths, limitReached: true };
    paths.push(local);
  }
  return { paths, limitReached: false };
}

/** Pi file autocomplete's fd-compatible subset; not a general fd replacement. */
export async function autocompleteFiles(parameters, cwd = process.cwd()) {
  const limit = resultLimit(parameters.limit, 100);
  const { root, info } = await searchRoot(parameters.path, cwd);
  if (!info.isDirectory()) throw new Error(`Search path must be a directory: ${root}`);
  const pattern = assertPattern(parameters.pattern ?? "");
  const expression = parameters.glob ? undefined : new RegExp(pattern, parameters.ignoreCase ? "iu" : "u");
  const types = parameters.types ?? ["f", "d"];
  if (types.some((type) => !["f", "d"].includes(type)))
    throw new Error("Only file and directory search is supported.");
  if (
    parameters.maxDepth !== undefined &&
    (!Number.isInteger(parameters.maxDepth) || parameters.maxDepth < 1)
  )
    throw new Error("Maximum search depth must be a positive integer.");
  const paths = [];
  for await (const entry of entriesIn(root, await ancestorRules(root), { ...parameters, root })) {
    if (!types.includes(entry.directory ? "d" : "f")) continue;
    const local = normalize(relative(root, entry.path));
    // Pi 1.6.1 prefixes relative path globs with the search path and passes
    // --ignore-case when the user's pattern is lowercase; fd then matches the
    // absolute candidate. Keep fd's full-path and smart-case behavior.
    const candidate = parameters.fullPath
      ? isAbsolute(pattern)
        ? normalize(entry.path)
        : local
      : basename(local);
    if (
      parameters.glob
        ? !minimatch(candidate, pattern, {
            dot: true,
            nocase: parameters.ignoreCase === true,
            // fd's globset has literal @(...)/+(...)/!(...) text instead of
            // minimatch's extglob, and treats leading #/! literally. Without
            // noext, an unescaped @(dev) in Pi's absolute prefix hides files.
            noext: true,
            nocomment: true,
            nonegate: true
          })
        : !expression.test(candidate)
    )
      continue;
    if (paths.length === limit) return { paths, limitReached: true };
    paths.push(local + (entry.directory ? "/" : ""));
  }
  return { paths, limitReached: false };
}

/** Portable content search. Regex patterns use JavaScript regular expressions. */
export async function grepFiles(parameters, cwd = process.cwd()) {
  const pattern = assertPattern(parameters.pattern);
  const limit = resultLimit(parameters.limit, 100);
  const context = parameters.context ?? 0;
  if (!Number.isInteger(context) || context < 0 || context > 100)
    throw new Error("Search context must be an integer between 0 and 100.");
  if (parameters.glob !== undefined) assertPattern(parameters.glob);
  const expression = parameters.literal ? undefined : new RegExp(pattern, parameters.ignoreCase ? "iu" : "u");
  const literal = parameters.ignoreCase ? pattern.toLowerCase() : pattern;
  const matches = (line) =>
    expression
      ? expression.test(line)
      : (parameters.ignoreCase ? line.toLowerCase() : line).includes(literal);
  const { root, info } = await searchRoot(parameters.path, cwd);
  if (!info.isDirectory() && !info.isFile())
    throw new Error(`Search path must be a file or directory: ${root}`);
  const candidates = info.isDirectory() ? files(root, await ancestorRules(root)) : [root];
  const output = [];
  const outputLines = [];
  const matchedLines = [];
  const skippedFiles = [];
  let matchCount = 0;
  let outputBytes = 0;
  let limitReached = false;
  let outputLimitReached = false;
  let linesTruncated = false;
  for await (const path of candidates) {
    const local = info.isDirectory() ? normalize(relative(root, path)) : basename(root);
    if (parameters.glob && !globMatches(local, parameters.glob)) continue;
    if ((await stat(path)).size > MAX_FILE_BYTES) {
      skippedFiles.push(local);
      continue;
    }
    const bytes = await readFile(path);
    if (bytes.includes(0)) continue;
    const lines = bytes.toString("utf8").replace(/\r\n?/g, "\n").split("\n");
    const matchedIndexes = new Set();
    const includedIndexes = new Set();
    for (let index = 0; index < lines.length; index++) {
      if (!matches(lines[index])) continue;
      if (matchCount === limit) {
        limitReached = true;
        break;
      }
      matchCount++;
      matchedLines.push({ path, lineNumber: index + 1, line: lines[index] });
      matchedIndexes.add(index);
      for (
        let line = Math.max(index - context, 0);
        line <= Math.min(index + context, lines.length - 1);
        line++
      )
        includedIndexes.add(line);
    }
    for (const line of [...includedIndexes].sort((left, right) => left - right)) {
      const delimiter = matchedIndexes.has(line) ? ":" : "-";
      const text = `${local}${delimiter}${line + 1}${delimiter} ${lines[line].slice(0, 1000)}`;
      if (lines[line].length > 1000) linesTruncated = true;
      const size = Buffer.byteLength(text) + 1;
      if (outputBytes + size > MAX_OUTPUT_BYTES) {
        outputLimitReached = true;
        break;
      }
      output.push(text);
      outputLines.push({
        path,
        lineNumber: line + 1,
        line: lines[line].slice(0, 1000),
        isMatch: matchedIndexes.has(line)
      });
      outputBytes += size;
    }
    if (limitReached || outputLimitReached) break;
  }
  return {
    text: output.join("\n"),
    matchCount,
    limitReached,
    outputLimitReached,
    linesTruncated,
    skippedFiles,
    matches: matchedLines,
    // Adapter JSON needs match and context rows in file order, not only matches.
    lines: outputLines
  };
}

/** JS defines \w, \d and \b over ASCII while Rust's engine uses Unicode classes,
 * and Unicode property names differ between the two engines. */
function usesJavascriptRegexSyntax(pattern) {
  for (let index = 0; index < pattern.length - 1; index++) {
    if (pattern[index] !== "\\") continue;
    if (/[wWdDbBpP]/.test(pattern[index + 1])) return true;
    index++;
  }
  return false;
}

/** Regex constructs JavaScript accepts but Rust's regex engine (used by ripgrep) rejects. */
function usesUnsupportedRegexSyntax(pattern) {
  return /\(\?[=!]|\(\?<[=!]|\(\?>|\\[1-9]|\\k</.test(pattern);
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isTerminalSearchError(error, signal) {
  return signal?.aborted === true || error?.message === ABORT_MESSAGE || error?.message === TIMEOUT_MESSAGE;
}

function remainingTimeoutMs(deadline) {
  if (Date.now() >= deadline) throw new Error(TIMEOUT_MESSAGE);
  return Math.max(1, deadline - Date.now());
}

function emptyGrepResult(skippedFiles = []) {
  return {
    text: "",
    matchCount: 0,
    limitReached: false,
    outputLimitReached: false,
    linesTruncated: false,
    skippedFiles,
    matches: [],
    lines: []
  };
}

async function nativeFind({ fd, root, pattern, limit, signal, deadline }) {
  if (unsupportedGlobSyntax(pattern)) throw new NativeFallback();
  const target = nativeGlobPattern(pattern, root);
  if (!target) throw new NativeFallback();
  if (!target.pattern) return { paths: [], limitReached: false };
  const insideRepository = await isInsideRepository(root);
  const args = [
    "--glob",
    "--hidden",
    "--print0",
    "--case-sensitive",
    "--type",
    "f",
    "--exclude",
    ".git",
    "--exclude",
    "node_modules",
    "--max-results",
    String(limit + 1)
  ];
  if (!insideRepository) args.push("--no-require-git");
  if (target.fullPath) args.push("--full-path");
  args.push("--", target.pattern, root);
  const collected = [];
  let limitReached = false;
  const { code, stderr, stopped } = await runNativeLines({
    command: fd,
    args,
    signal,
    deadline,
    nul: true,
    onLine(line) {
      collected.push(line);
      if (collected.length > limit) {
        limitReached = true;
        return true;
      }
      return false;
    }
  });
  if (code !== 0 && !stopped) throw new NativeFallback(stderr);
  const paths = collected
    .slice(0, limit)
    .map((path) => normalize(relative(root, resolve(path))))
    .sort(comparePaths);
  return { paths, limitReached };
}

function decodeRipgrepText(data) {
  if (typeof data?.text === "string") return data.text;
  if (typeof data?.bytes === "string") return Buffer.from(data.bytes, "base64").toString("utf8");
  return "";
}

function ripgrepLine(data) {
  return decodeRipgrepText(data.lines).replace(/\r?\n$/, "");
}

async function nativeGrep({ rg, root, isDirectory, parameters, glob, limit, context, signal, deadline }) {
  const insideRepository = isDirectory ? await isInsideRepository(root) : false;
  const args = ["--no-config", "--json", "--line-number", "--color=never", "--crlf"];
  if (isDirectory) {
    // ripgrep treats the M suffix as MiB, matching the portable backend's 4 MiB cap.
    args.push("--hidden", "--max-filesize", "4M", "--glob=!.git", "--glob=!node_modules");
    if (!insideRepository) args.push("--no-require-git");
    // A positive --glob makes ripgrep search files that .gitignore excludes,
    // so the portable glob filter below (startFile) keeps ignored files out.
  }
  if (parameters.ignoreCase) args.push("--ignore-case");
  if (parameters.literal) args.push("--fixed-strings");
  if (context > 0) args.push("--context", String(context));
  args.push("--", parameters.pattern, isDirectory ? "." : root);

  const matches = [];
  const outputLines = [];
  const outputTexts = [];
  let matchCount = 0;
  let outputBytes = 0;
  let limitReached = false;
  let outputLimitReached = false;
  let linesTruncated = false;
  let current;
  const base = isDirectory ? root : dirname(root);

  const startFile = (data) => {
    const absolute = resolve(base, decodeRipgrepText(data.path));
    const local = isDirectory ? normalize(relative(root, absolute)) : basename(root);
    if (glob !== undefined && !globMatches(local, glob)) {
      current = { skip: true };
      return;
    }
    current = {
      absolute,
      local,
      lineTexts: new Map(),
      matches: [],
      matchLines: new Set(),
      highestLine: 0,
      highestMatchLine: 0,
      matchLimitReached: false
    };
  };
  const noteLine = (lineNumber, text) => {
    current.lineTexts.set(lineNumber, text);
    if (lineNumber > current.highestLine) current.highestLine = lineNumber;
  };
  const finishFile = async (data) => {
    const file = current;
    current = undefined;
    if (!file || file.skip) return false;
    const binary = data.binary_offset !== null && data.binary_offset !== undefined;
    if (binary || (!file.matches.length && !file.matchLimitReached)) return false;
    let maxIndex = -1;
    for (const match of file.matches) maxIndex = Math.max(maxIndex, match.lineNumber - 1 + context);
    const highestIndex = file.highestLine - 1;
    if (maxIndex > highestIndex) {
      const extra = await trailingNewlineCount(file.absolute, maxIndex - highestIndex);
      maxIndex = Math.min(maxIndex, highestIndex + extra);
    }
    const indexes = new Set();
    for (const match of file.matches) {
      const start = Math.max(0, match.lineNumber - 1 - context);
      const end = Math.min(maxIndex, match.lineNumber - 1 + context);
      for (let index = start; index <= end; index++) indexes.add(index);
    }
    const rows = [];
    const texts = [];
    let fileBytes = 0;
    let fileOutputLimit = false;
    let fileLinesTruncated = false;
    for (const index of [...indexes].sort((left, right) => left - right)) {
      let text = file.lineTexts.get(index + 1);
      if (text === undefined) {
        if (index <= highestIndex) throw new NativeFallback();
        text = "";
      }
      const isMatch = file.matchLines.has(index + 1);
      const delimiter = isMatch ? ":" : "-";
      const snippet = text.slice(0, MAX_LINE_CHARS);
      const rendered = `${file.local}${delimiter}${index + 1}${delimiter} ${snippet}`;
      if (text.length > MAX_LINE_CHARS) fileLinesTruncated = true;
      const size = Buffer.byteLength(rendered) + 1;
      if (outputBytes + fileBytes + size > MAX_OUTPUT_BYTES) {
        fileOutputLimit = true;
        break;
      }
      texts.push(rendered);
      rows.push({ path: file.absolute, lineNumber: index + 1, line: snippet, isMatch });
      fileBytes += size;
    }
    matchCount += file.matches.length;
    for (const match of file.matches) matches.push(match);
    outputBytes += fileBytes;
    for (const row of rows) outputLines.push(row);
    for (const text of texts) outputTexts.push(text);
    if (fileLinesTruncated) linesTruncated = true;
    if (fileOutputLimit) outputLimitReached = true;
    if (file.matchLimitReached) limitReached = true;
    return limitReached || outputLimitReached;
  };

  const { code, stderr, stopped } = await runNativeLines({
    command: rg,
    args,
    cwd: isDirectory ? root : undefined,
    signal,
    deadline,
    async onLine(line) {
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new NativeFallback(error.message);
      }
      if (event.type === "begin") {
        // ripgrep keeps each file's JSON events together; anything else would
        // make per-file binary and context decisions unreliable.
        if (current) throw new NativeFallback("Interleaved ripgrep output.");
        startFile(event.data);
        return false;
      }
      if (event.type === "match") {
        if (!current || current.skip) return false;
        const lineNumber = event.data.line_number;
        const text = ripgrepLine(event.data);
        if (current.matchLimitReached) {
          if (lineNumber - 1 <= current.highestMatchLine - 1 + context) noteLine(lineNumber, text);
          return false;
        }
        noteLine(lineNumber, text);
        if (matchCount + current.matches.length === limit) {
          current.matchLimitReached = true;
          return false;
        }
        current.matches.push({ path: current.absolute, lineNumber, line: text });
        current.matchLines.add(lineNumber);
        if (lineNumber > current.highestMatchLine) current.highestMatchLine = lineNumber;
        return false;
      }
      if (event.type === "context") {
        if (!current || current.skip) return false;
        const lineNumber = event.data.line_number;
        if (current.matchLimitReached && lineNumber - 1 > current.highestMatchLine - 1 + context)
          return false;
        noteLine(lineNumber, ripgrepLine(event.data));
        return false;
      }
      if (event.type === "end") return finishFile(event.data);
      return false;
    }
  });
  if (code !== 0 && code !== 1 && !stopped) throw new NativeFallback(stderr);
  return {
    text: outputTexts.join("\n"),
    matchCount,
    limitReached,
    outputLimitReached,
    linesTruncated,
    matches,
    lines: outputLines
  };
}

/** Report oversized files exactly as the portable backend would skip them. */
async function oversizedFiles({ fd, root, glob, signal, deadline }) {
  const oversized = [];
  const add = async (path) => {
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (!info.isFile() || info.size <= MAX_FILE_BYTES) return;
    const local = normalize(relative(root, path));
    if (glob && !globMatches(local, glob)) return;
    oversized.push(local);
  };
  if (fd) {
    const insideRepository = await isInsideRepository(root);
    const args = [
      "--hidden",
      "--print0",
      "--type",
      "f",
      "--size",
      "+4mi",
      "--exclude",
      ".git",
      "--exclude",
      "node_modules"
    ];
    if (!insideRepository) args.push("--no-require-git");
    args.push("--", ".", root);
    const found = [];
    let scanned = false;
    try {
      const { code, stopped } = await runNativeLines({
        command: fd,
        args,
        signal,
        deadline,
        nul: true,
        onLine(line) {
          found.push(line);
          return false;
        }
      });
      scanned = code === 0 || stopped;
    } catch (error) {
      if (isTerminalSearchError(error, signal)) throw error;
    }
    if (scanned) {
      for (const path of found) await add(resolve(path));
      return oversized.sort(comparePaths);
    }
  }
  for await (const path of files(root, await ancestorRules(root))) await add(path);
  return oversized.sort(comparePaths);
}

/** Validate and normalize parameters the native tools and the portable backend share. */
function normalizeDiskParameters(operation, parameters) {
  if (operation === "find") {
    const pattern = assertPattern(parameters.pattern);
    return {
      ...parameters,
      pattern: normalizedPattern(pattern),
      limit: resultLimit(parameters.limit, 1000)
    };
  }
  const pattern = assertPattern(parameters.pattern);
  const limit = resultLimit(parameters.limit, 100);
  const context = parameters.context ?? 0;
  if (!Number.isInteger(context) || context < 0 || context > 100)
    throw new Error("Search context must be an integer between 0 and 100.");
  const glob = parameters.glob === undefined ? undefined : normalizedPattern(assertPattern(parameters.glob));
  if (!parameters.literal) new RegExp(pattern, parameters.ignoreCase ? "iu" : "u");
  return { ...parameters, pattern, limit, context, glob };
}

/**
 * Prefer a real fd/rg found on PATH for exact disk searches and fall back to the
 * portable Node implementation when they are missing or cannot express the
 * request. Only Formicand-installed adapters are skipped as native tools.
 */
export async function runDiskSearch(
  operation,
  parameters,
  { cwd = process.cwd(), signal, timeoutMs = 30_000 } = {}
) {
  if (!["find", "grep", "autocomplete"].includes(operation))
    throw new Error("Unknown file search operation.");
  if (signal?.aborted) throw new Error(ABORT_MESSAGE);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Invalid file search timeout.");
  const deadline = Date.now() + timeoutMs;
  if (operation === "autocomplete")
    return runFileSearch("autocomplete", parameters, { cwd, signal, timeoutMs });

  const normalized = normalizeDiskParameters(operation, parameters);
  const { root, info } = await searchRoot(parameters.path, cwd);
  if (operation === "find") {
    if (!info.isDirectory()) throw new Error(`Search path must be a directory: ${root}`);
    if (!normalized.pattern) return { paths: [], limitReached: false };
    const fd = await findNativeTool("fd");
    if (fd) {
      try {
        return await nativeFind({
          fd,
          root,
          pattern: normalized.pattern,
          limit: normalized.limit,
          signal,
          deadline
        });
      } catch (error) {
        if (!(error instanceof NativeFallback)) throw error;
      }
    }
    return runFileSearch("find", normalized, {
      cwd,
      signal,
      timeoutMs: remainingTimeoutMs(deadline)
    });
  }

  if (!info.isDirectory() && !info.isFile())
    throw new Error(`Search path must be a file or directory: ${root}`);
  if (!info.isDirectory()) {
    if (normalized.glob && !globMatches(basename(root), normalized.glob)) return emptyGrepResult();
    if (info.size > MAX_FILE_BYTES) return emptyGrepResult([basename(root)]);
  }
  const rg = await findNativeTool("rg");
  const glob = normalized.glob;
  const literal = Boolean(normalized.literal);
  const nativeUnsupported =
    !rg ||
    normalized.pattern.includes("\0") ||
    normalized.pattern.includes("\n") ||
    normalized.pattern.includes("\r") ||
    (!literal &&
      (usesUnsupportedRegexSyntax(normalized.pattern) || usesJavascriptRegexSyntax(normalized.pattern))) ||
    (glob !== undefined && (isAbsolute(glob) || unsupportedGlobSyntax(glob)));
  if (!nativeUnsupported) {
    const fd = info.isDirectory() ? await findNativeTool("fd") : undefined;
    const controller = new AbortController();
    const scanSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const scanPromise = info.isDirectory()
      ? oversizedFiles({ fd, root, glob, signal: scanSignal, deadline }).then(
          (paths) => ({ paths }),
          (error) => ({ error })
        )
      : Promise.resolve({ paths: [] });
    let result;
    try {
      result = await nativeGrep({
        rg,
        root,
        isDirectory: info.isDirectory(),
        parameters: normalized,
        glob,
        limit: normalized.limit,
        context: normalized.context,
        signal,
        deadline
      });
    } catch (error) {
      controller.abort();
      await scanPromise;
      if (!(error instanceof NativeFallback)) throw error;
    }
    if (result) {
      const scan = await scanPromise;
      if (!scan.error) return { ...result, skippedFiles: scan.paths };
      if (isTerminalSearchError(scan.error, signal)) throw scan.error;
    }
  }
  return runFileSearch("grep", normalized, {
    cwd,
    signal,
    timeoutMs: remainingTimeoutMs(deadline)
  });
}

/** Run regex and traversal off the main thread so cancellation and timeouts work. */
export function runFileSearch(
  operation,
  parameters,
  { cwd = process.cwd(), signal, timeoutMs = 30_000 } = {}
) {
  if (!["find", "grep", "autocomplete"].includes(operation))
    return Promise.reject(new Error("Unknown file search operation."));
  if (signal?.aborted) return Promise.reject(new Error("Operation aborted"));
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1)
    return Promise.reject(new Error("Invalid file search timeout."));
  return new Promise((done, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { formicandFileSearch: true, operation, parameters, cwd }
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error);
      else done(result);
    };
    const abort = () => finish(new Error("Operation aborted"));
    const timer = setTimeout(
      () => finish(new Error("File search timed out; narrow the search path or pattern.")),
      timeoutMs
    );
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", ({ result, error }) => finish(error ? new Error(error) : undefined, result));
    worker.once("error", (error) => finish(error));
    worker.once("exit", () => finish(new Error("File search worker exited before returning a result.")));
    if (signal?.aborted) abort();
  });
}

if (!isMainThread && workerData?.formicandFileSearch) {
  try {
    const search =
      workerData.operation === "find"
        ? findFiles
        : workerData.operation === "autocomplete"
          ? autocompleteFiles
          : grepFiles;
    parentPort.postMessage({ result: await search(workerData.parameters, workerData.cwd) });
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
}
