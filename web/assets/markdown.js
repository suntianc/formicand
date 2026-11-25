import { escapeHtml as esc } from "./ui/html.js";
import { protectMath } from "./math.js";
import { ui } from "./ui/language.js";
import {
  callout,
  decodeFilePath,
  fencedBlock,
  fileChip,
  fileReference,
  linkChip,
  linkedFileReference,
  localFilePath,
  streamingCodeBlock,
  tableBlock
} from "./rich-blocks.js";

/**
 * A model sometimes breaks a link between its label and its target:
 * `[耗时明细]` on one line and `(/path/file.tsv)` on the next. Those two lines
 * are one link.
 */
function isSplitLinkPair(previous, line) {
  return (
    previous !== undefined &&
    /\[[^\]]+\][ \t]*$/.test(previous) &&
    /^[ \t]*\([ \t]*(?:<[^<>\r\n]+>|[^)\s]+)[ \t]*\)/.test(line)
  );
}

function joinSplitLinks(lines) {
  const joined = [];
  for (const line of lines) {
    const previous = joined.at(-1);
    if (isSplitLinkPair(previous, line)) joined[joined.length - 1] = previous.trimEnd() + line.trimStart();
    else joined.push(line);
  }
  return joined;
}

/** An absolute path or `file://` URL written straight into prose, with an optional line locator. */
const BARE_PATH =
  /(^|[\s(（"'“‘：:，,])(file:\/\/(?:localhost)?)?(\/(?:(?:[\p{L}\p{N}_.@+~-]|%[0-9A-Fa-f]{2})+\/)+\.?(?:[\p{L}\p{N}_@+~-]|%[0-9A-Fa-f]{2})(?:[\p{L}\p{N}_.@+~-]|%[0-9A-Fa-f]{2})*\.[A-Za-z0-9]{1,10})(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?:[-:]\d+)?)?(?=$|[\s)）"'”’，。；;:：!?！？,])/giu;

/**
 * Options: `resolveLocalLink(path)` maps an absolute link to a registered
 * artifact; `resolveFile(path)` says whether a file reference can open a
 * preview, which makes its chip a button.
 */
export function renderMarkdown(source, options = {}) {
  // Input cannot forge the internal fragment sentinels.
  const math = protectMath(
    String(source ?? "")
      .replaceAll("\u0000", "")
      .replace(/\r\n?/g, "\n")
  );
  // Restore only after Markdown parsing so generated markup is never reinterpreted.
  // eslint-disable-next-line no-control-regex -- NUL 分隔数学占位符，渲染后按编号恢复。
  const mathToken = /\u0000math(\d+)\u0000/g;
  return renderBlocks(math.source, options).replace(
    mathToken,
    (_match, index) => math.fragments[Number(index)] || ""
  );
}

const TASK_ITEM = /^\[([ xX])\]\s+(.*)$/;

function listMarkup(type, items, options) {
  const tasks = items.map((item) => TASK_ITEM.exec(item));
  const isTaskList = tasks.every(Boolean);
  const entries = items.map((item, index) => {
    const task = tasks[index];
    if (!task) return `<li>${inlineMarkdown(item, options)}</li>`;
    const done = task[1] !== " ";
    return `<li class="task-item${done ? " is-done" : ""}"><input type="checkbox" disabled${done ? " checked" : ""} aria-label="${done ? ui("已完成") : ui("未完成")}" /><span>${inlineMarkdown(task[2], options)}</span></li>`;
  });
  return `<${type}${isTaskList ? ' class="task-list"' : ""}>${entries.join("")}</${type}>`;
}

function renderBlocks(source, options) {
  const lines = source.split("\n");
  const output = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];
  let codeLines = null;
  let codeInfo = "";
  let codeFence = "";
  const flushParagraph = () => {
    if (paragraph.length) {
      output.push(
        `<p>${joinSplitLinks(paragraph)
          .map((line) => inlineMarkdown(line, options))
          .join("<br />")}</p>`
      );
      paragraph = [];
    }
  };
  const flushList = () => {
    if (!listType) return;
    output.push(listMarkup(listType, listItems, options));
    listType = null;
    listItems = [];
  };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (codeLines) {
      if (fence && fence[1][0] === codeFence[0] && fence[1].length >= codeFence.length && !fence[2].trim()) {
        const tailOpen = Boolean(options.openTailFence && lineIndex === lines.length - 1);
        output.push(
          tailOpen
            ? streamingCodeBlock(codeInfo, codeLines.join("\n"))
            : fencedBlock(codeInfo, codeLines.join("\n"))
        );
        codeLines = null;
        codeInfo = codeFence = "";
      } else codeLines.push(line);
      continue;
    }
    if (fence) {
      flushParagraph();
      flushList();
      codeLines = [];
      codeFence = fence[1];
      codeInfo = fence[2].trim();
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    if (
      /^\s*\|/.test(line) &&
      /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[lineIndex + 1] || "")
    ) {
      flushParagraph();
      flushList();
      const header = splitTableRow(line);
      const rows = [];
      lineIndex += 2;
      while (
        lineIndex < lines.length &&
        /^\s*\|/.test(lines[lineIndex]) &&
        lines[lineIndex].trim().endsWith("|")
      ) {
        rows.push(splitTableRow(lines[lineIndex]));
        lineIndex += 1;
      }
      lineIndex -= 1;
      output.push(
        tableBlock(
          `<table><thead><tr>${header.map((cell) => `<th>${inlineMarkdown(cell, options)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${header.map((_cell, index) => `<td>${inlineMarkdown(row[index] || "", options)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
          rows.length,
          header.length
        )
      );
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2], options)}</h${level}>`);
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph();
      flushList();
      output.push("<hr />");
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextType = ordered ? "ol" : "ul";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((unordered || ordered)[1]);
      continue;
    }
    if (listType && isSplitLinkPair(listItems.at(-1), line)) {
      listItems[listItems.length - 1] = listItems[listItems.length - 1].trimEnd() + line.trimStart();
      continue;
    }
    if (listType) flushList();
    if (/^\s*>/.test(line)) {
      flushParagraph();
      // Consecutive quoted lines are one quote, rendered as Markdown of its own.
      const quoted = [];
      while (lineIndex < lines.length && /^\s*>/.test(lines[lineIndex]))
        quoted.push(lines[lineIndex++].replace(/^\s*>\s?/, ""));
      lineIndex -= 1;
      const marker = /^\[!(\w+)\]\s*$/.exec(quoted[0].trim());
      const body = renderBlocks((marker ? quoted.slice(1) : quoted).join("\n"), options);
      output.push((marker && callout(marker[1], body)) || `<blockquote>${body}</blockquote>`);
      continue;
    }
    paragraph.push(line);
  }
  if (codeLines)
    output.push(
      options.openTailFence || options.streaming
        ? streamingCodeBlock(codeInfo, codeLines.join("\n"))
        : fencedBlock(codeInfo, codeLines.join("\n"))
    );
  flushParagraph();
  flushList();
  return output.join("");
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function resolveArtifactTarget(path, options) {
  if (!options.resolveLocalLink) return undefined;
  const exact = options.resolveLocalLink(path);
  if (exact) return { local: exact, line: undefined };
  const fragment = /#L(\d+)(?:-L?\d+)?$/.exec(path);
  if (!fragment) return undefined;
  const stripped = options.resolveLocalLink(path.slice(0, fragment.index));
  return stripped ? { local: stripped, line: Number(fragment[1]) || undefined } : undefined;
}

function inlineMarkdown(value, options) {
  const fragments = [];
  const protect = (html) => {
    const token = `\u0000${fragments.length}\u0000`;
    fragments.push(html);
    return token;
  };
  let text = String(value).replace(
    /(`+)(.+?)\1(?!`)|!?\[([^\]]+)\]\([ \t]*(?:<([^<>\r\n]+)>|([^\s)]+))[ \t]*\)/g,
    (match, ticks, code, label, wrappedUrl, plainUrl) => {
      if (code !== undefined) {
        const reference = options.linkify === false ? undefined : fileReference(code);
        return protect(
          reference
            ? fileChip(reference, { openable: Boolean(options.resolveFile?.(reference.path)) })
            : `<code>${esc(code)}</code>`
        );
      }
      const url = wrappedUrl || plainUrl;
      // A model-supplied filesystem path is not a browser route or a native
      // open-file grant. Only the caller can resolve a registered artifact.
      // eslint-disable-next-line no-control-regex -- 链接目标含控制字符时按普通文本显示。
      if (/[\x00-\x1f\x7f]/.test(url)) return protect(esc(match));
      if (/^https?:\/\//i.test(url) && !match.startsWith("!"))
        return protect(linkChip(url, inlineMarkdown(label, { ...options, linkify: false })));
      if (/^https?:\/\//i.test(url))
        return protect(
          `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${inlineMarkdown(label, { ...options, linkify: false })}</a>`
        );
      const localPath = localFilePath(url);
      const localMatch =
        localPath && /^\/(?![/\\])/.test(localPath) ? resolveArtifactTarget(localPath, options) : undefined;
      if (localMatch)
        return protect(
          fileChip(
            { path: localMatch.local.artifactPath, line: localMatch.line },
            {
              label: label.replace(/`/g, ""),
              link: {
                href: localMatch.local.href,
                artifactPath: localMatch.local.artifactPath,
                taskId: localMatch.local.taskId
              }
            }
          )
        );
      // A file the reader cannot open still reads as a file, not as raw Markdown.
      const reference = localPath ? linkedFileReference(localPath) : undefined;
      if (reference && !match.startsWith("!"))
        return protect(
          fileChip(reference, {
            openable: Boolean(options.resolveFile?.(reference.path)),
            label: label.replace(/`/g, "")
          })
        );
      return protect(esc(match));
    }
  );
  if (options.linkify) {
    // Explicit links and inline code are already protected. Keep URL spelling
    // intact before emphasis processing, including underscores and query strings.
    // eslint-disable-next-line no-control-regex -- 裸链接到 NUL 占位符边界结束。
    text = text.replace(/https?:\/\/[^\s<>"'`*\u0000，。；：！？、（）【】]+/gi, (match) => {
      let url = match.replace(/[.,;:!?。，；：！？、]+$/, "");
      for (const [open, close] of [
        ["(", ")"],
        ["[", "]"],
        ["（", "）"],
        ["【", "】"]
      ]) {
        while (url.endsWith(close) && url.split(close).length > url.split(open).length)
          url = url.slice(0, -close.length);
      }
      try {
        const parsed = new URL(url);
        if (!parsed.hostname || parsed.username || parsed.password) return match;
        // eslint-disable-next-line no-restricted-syntax -- 链接化文本取自消息内容，可能不是合法 URL，此时保留原文不生成链接
      } catch {
        return match;
      }
      return protect(linkChip(url)) + match.slice(url.length);
    });
    // A long path in prose reads as its file name; hovering shows the whole path.
    text = text.replace(BARE_PATH, (match, lead, fileScheme, rawPath, hashLine, colonLine) => {
      const path = fileScheme ? decodeFilePath(rawPath) : rawPath;
      if (!path) return match;
      const line = Number(hashLine || colonLine) || undefined;
      const local =
        options.resolveLocalLink?.(rawPath) ??
        (path !== rawPath ? options.resolveLocalLink?.(path) : undefined);
      return (
        lead +
        protect(
          local
            ? fileChip(
                { path: local.artifactPath, line },
                {
                  link: { href: local.href, artifactPath: local.artifactPath, taskId: local.taskId },
                  title: line ? `${path}:${line}` : path
                }
              )
            : fileChip({ path, line }, { openable: Boolean(options.resolveFile?.(path)) })
        )
      );
    });
  }
  text = esc(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/(?<![\p{L}\p{N}])_([^_]+)_(?![\p{L}\p{N}])/gu, "<em>$1</em>");
  // NUL sentinels protect inline code and complete links, including attributes,
  // from emphasis substitutions. Text and attributes are escaped exactly once.
  // eslint-disable-next-line no-control-regex -- 用 NUL 分隔的编号恢复已转义的内联片段。
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index) => fragments[Number(index)] || "");
}
