/**
 * The shape a retro's pitfall pages must keep. A page under `docs/pitfalls/`
 * holds entries under `## ` headings; each entry is exactly five fields of one
 * or two sentences, and the index lists every entry in one table row. The
 * checks refuse what makes an entry a story instead of a reusable lesson.
 */

export const PITFALL_FIELDS = ["Trigger", "What happens", "Confirm", "Avoid", "Sources"] as const;

/** The index, relative to the pitfalls directory. */
export const PITFALLS_INDEX_PAGE = "README.md";

const FIELD_LIMIT = 600;
const SENTENCE_END = /[.!?。！？]+(?=\s|$)|[。！？]+/gu;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/;

/** What an entry must not carry: run-specific identities and counts. */
const STORY: { pattern: RegExp; label: string }[] = [
  { pattern: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/, label: "commit SHA" },
  {
    pattern: /(?:^|[\s`'"(（])(?:\/(?:Users|home|private|tmp|var|opt|root)\/|~\/|[A-Za-z]:\\)/,
    label: "absolute path"
  },
  {
    pattern: /\b(?:requirement|development|review|ticket|merge|call|task|run|finding)_[0-9a-f]{8}-/,
    label: "record id"
  },
  { pattern: /\d+\s*(?:rounds?\b|轮|tests?\b|个?测试|次返修)/i, label: "round or test count" }
];

/** A heading's anchor as GitHub renders it. */
export function pitfallAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

interface Entry {
  heading: string;
  lines: string[];
}

function entries(text: string): Entry[] {
  const found: Entry[] = [];
  for (const line of text.split("\n")) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) found.push({ heading: heading[1].trim(), lines: [] });
    else if (found.length && line.trim()) found.at(-1)!.lines.push(line.trim());
  }
  return found;
}

function entryProblems(page: string, entry: Entry): string[] {
  const where = `${page}「${entry.heading}」`;
  const fields = entry.lines.map((line) => /^- \*\*([^*]+?)\s*[:：]\s*\*\*\s*(.*)$/.exec(line));
  const names = fields.map((field) => field?.[1]);
  if (fields.some((field) => !field) || names.join("|") !== PITFALL_FIELDS.join("|"))
    return [`${where}须且只能依次写五项：${PITFALL_FIELDS.map((name) => `**${name}:**`).join("、")}`];
  const problems: string[] = [];
  fields.forEach((field, index) => {
    const [, name, value] = field!;
    const sentences = value.match(SENTENCE_END)?.length ?? 1;
    if (!value) problems.push(`${where}的 ${name} 是空的`);
    else if (value.length > FIELD_LIMIT || sentences > 2)
      problems.push(`${where}的 ${name} 超过两句话或 ${FIELD_LIMIT} 字`);
    for (const { pattern, label } of STORY)
      if (pattern.test(value)) problems.push(`${where}的 ${name} 含 ${label}；只写能复用的经验`);
    if (index === PITFALL_FIELDS.length - 1) {
      if (!DATE.test(value)) problems.push(`${where}的 Sources 须写需求标题和日期（YYYY-MM-DD）`);
      if (/\]\(/.test(value)) problems.push(`${where}的 Sources 只写需求标题和日期，不放链接`);
    }
  });
  return problems;
}

/**
 * What is wrong with the pitfalls after a retro's commit. `pages` holds every
 * top-level page the commit changed, by file name, with its new text or
 * undefined when it was removed; `index` is the index's new text.
 */
export function pitfallProblems(
  pages: Record<string, string | undefined>,
  index: string | undefined
): string[] {
  if (index === undefined) return [`缺少索引 ${PITFALLS_INDEX_PAGE}`];
  const links = new Set(
    [...index.matchAll(/\]\(([^)#\s]+\.md)#([^)\s]+)\)/g)].map(([, page, anchor]) => `${page}#${anchor}`)
  );
  const linkedPages = new Set([...links].map((link) => link.split("#")[0]));
  const problems: string[] = [];
  for (const [page, text] of Object.entries(pages)) {
    if (page === PITFALLS_INDEX_PAGE) continue;
    if (text === undefined) {
      if (linkedPages.has(page)) problems.push(`索引仍链接到已删除的 ${page}`);
      continue;
    }
    const found = entries(text);
    const anchors = new Set(
      found.flatMap((entry) => {
        const anchor = pitfallAnchor(entry.heading);
        return [anchor, encodeURIComponent(anchor)];
      })
    );
    for (const entry of found) {
      problems.push(...entryProblems(page, entry));
      const anchor = pitfallAnchor(entry.heading);
      if (!links.has(`${page}#${anchor}`) && !links.has(`${page}#${encodeURIComponent(anchor)}`))
        problems.push(`索引缺少 ${page}「${entry.heading}」的一行`);
    }
    for (const link of links)
      if (link.startsWith(`${page}#`) && !anchors.has(link.slice(page.length + 1)))
        problems.push(`索引链接的 ${link} 在页面里没有对应条目`);
  }
  return problems;
}
