/**
 * When a change may not rest on Main's own checks. A user project lists the
 * paths that always take an independent Reviewer in a table under a
 * `## 独立审查` (or `## Independent review`) heading in its root AGENTS.md, one
 * row per path with the reason. The program applies these when Main records
 * the self channel, so the route does not depend on which model is Main; a
 * project without the table merges on Main's own checks.
 */

export interface ReviewRule {
  path: string;
  reason: string;
}

const HEADING = /^##\s+(独立审查|Independent review)\s*$/i;
const NEXT_HEADING = /^#{1,2}\s/;
const SEPARATOR = /^:?-+:?$/;

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim().replace(/^`(.*)`$/, "$1"));

/** The rows of the table under the heading; an empty list when the file has none. */
export function parseReviewRules(text: string | undefined): ReviewRule[] {
  const lines = (text ?? "").split("\n");
  const start = lines.findIndex((line) => HEADING.test(line.trim()));
  if (start < 0) return [];
  const after = lines.slice(start + 1).findIndex((line) => NEXT_HEADING.test(line));
  const end = after < 0 ? lines.length : start + 1 + after;
  const table = lines.slice(start + 1, end).filter((line) => line.trim().startsWith("|"));
  // The first table line is the header.
  return table.slice(1).flatMap((line) => {
    const [path = "", reason = ""] = cells(line);
    if (!path || SEPARATOR.test(path)) return [];
    return [{ path: path.replace(/^\.\//, "").replace(/\/+$/, ""), reason }];
  });
}

/** A rule covers a file when it names the file or a directory above it; `*` matches within one name. */
function covers(rule: string, file: string): boolean {
  if (!rule.includes("*")) return file === rule || file.startsWith(`${rule}/`);
  const pattern = new RegExp(
    `^${rule
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*")}(/.*)?$`
  );
  return pattern.test(file);
}

/** Why `changed` needs an independent Reviewer, or undefined when Main's own checks may stand. */
export function independentReviewReason(rules: ReviewRule[], changed: string[]): string | undefined {
  const hits = rules.flatMap((rule) => {
    const files = changed.filter((file) => covers(rule.path, file));
    return files.length
      ? [`${rule.path}（${rule.reason || "AGENTS.md 独立审查表"}）：${files.slice(0, 5).join("、")}`]
      : [];
  });
  return hits.length ? hits.join("；") : undefined;
}
