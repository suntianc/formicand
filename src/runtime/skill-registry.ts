import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { formicandHome } from "../../scripts/data-home.cjs";
import { projectAgentsSkillRoots, projectTrustDecision } from "./project-trust.js";
import { removedSkillDirectories } from "./skill-index.js";
import { parseSkillFrontmatter } from "./skill-frontmatter.js";
import type { RuntimeTool } from "./tool.js";

/** The skill catalog bundled with this install. */
export function bundledSkillRoot(harnessRoot: string): string {
  return join(harnessRoot, ".pi", "skills");
}

/** Where Formicand installs global skills: `~/.formicand/skills`. */
export function installedSkillRoot(home: string): string {
  return join(home, "skills");
}

/** The installed skill folder of the data home this process uses. */
export function installedSkillRootNow(env: NodeJS.ProcessEnv = process.env): string {
  return installedSkillRoot(formicandHome(env));
}

/**
 * Where a skill came from, highest priority first.
 *
 * `project` and `global` are Formicand's own `.formicand/skills`; the `-agents`
 * sources are the shared `.agents/skills` convention other tools also read,
 * which Formicand never writes to.
 */
export const SKILL_SOURCES = ["project", "project-agents", "global", "global-agents", "bundled"] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

export interface SkillRoot {
  source: SkillSource;
  root: string;
}

export interface SkillLocations {
  harnessRoot: string;
  /** Omitted for the global catalog. */
  projectDirectory?: string;
  /** Formicand's data home (`~/.formicand`). */
  home: string;
  /** The user's home folder, where `~/.agents/skills` lives. */
  userHome: string;
  /** Project roots are read only for a project the user trusted. */
  projectTrusted: boolean;
}

/** Every directory skills are read from, highest priority first. */
export function skillRootsFor(locations: SkillLocations): SkillRoot[] {
  const roots: SkillRoot[] = [];
  const { projectDirectory } = locations;
  if (projectDirectory && locations.projectTrusted) {
    roots.push({ source: "project", root: join(resolve(projectDirectory), ".formicand", "skills") });
    for (const root of projectAgentsSkillRoots(projectDirectory))
      roots.push({ source: "project-agents", root });
  }
  roots.push({ source: "global", root: installedSkillRoot(locations.home) });
  roots.push({ source: "global-agents", root: join(locations.userHome, ".agents", "skills") });
  roots.push({ source: "bundled", root: bundledSkillRoot(locations.harnessRoot) });
  return roots;
}

/** The locations a running process reads: its data home, trust and project. */
export async function processSkillLocations(
  harnessRoot: string,
  projectDirectory: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<SkillLocations> {
  const home = formicandHome(env);
  const trusted = projectDirectory
    ? (await projectTrustDecision(home, projectDirectory)) === "trusted"
    : false;
  return { harnessRoot, projectDirectory, home, userHome: homedir(), projectTrusted: trusted };
}

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  directory: string;
}

export interface SkillEntry extends SkillMetadata {
  source: SkillSource;
  /** Removed from Formicand's index: hidden from every Agent, file untouched. */
  removed: boolean;
  /** The directory of the higher-priority skill with the same name, when one wins. */
  shadowedBy?: string;
}

/**
 * Every skill under the given roots, including removed and shadowed ones, so
 * the management screen can show and restore them.
 */
export async function listSkillEntries(
  roots: SkillRoot[],
  removed: ReadonlySet<string>
): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];
  const winner = new Map<string, string>();
  for (const { source, root } of roots) {
    const found: SkillMetadata[] = [];
    await scanRoot(resolve(root), found, new Set());
    for (const skill of found) {
      const isRemoved = removed.has(skill.directory);
      const shadowedBy = isRemoved ? undefined : winner.get(skill.name);
      if (!isRemoved && !shadowedBy) winner.set(skill.name, skill.directory);
      entries.push({ ...skill, source, removed: isRemoved, ...(shadowedBy ? { shadowedBy } : {}) });
    }
  }
  return entries;
}

/** The skills an Agent can see: one per name, highest source first, none removed. */
export async function resolveSkillCatalog(locations: SkillLocations): Promise<SkillMetadata[]> {
  const entries = await listSkillEntries(
    skillRootsFor(locations),
    await removedSkillDirectories(locations.home)
  );
  return entries
    .filter((entry) => !entry.removed && !entry.shadowedBy)
    .map(({ name, description, path, directory }) => ({ name, description, path, directory }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Plain discovery over explicit roots, first name wins. */
export async function discoverSkills(roots: string[]): Promise<SkillMetadata[]> {
  const found: SkillMetadata[] = [];
  const seen = new Set<string>();
  for (const root of roots) await scanRoot(resolve(root), found, seen);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The skill catalog every process shows its model: names and descriptions only.
 *
 * A skill is loaded through load_skill, which returns its instructions, real
 * directory and bundled scripts, so the catalog carries no file path to read.
 */
export function skillCatalogPrompt(skills: SkillMetadata[]): string {
  if (skills.length === 0) return "";
  return [
    "Skills hold instructions for specific kinds of work. When a task matches a skill's description, load it with load_skill by name before starting.",
    "",
    "<available_skills>",
    ...skills.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      "  </skill>"
    ]),
    "</available_skills>"
  ].join("\n");
}

export function createLoadSkillTool(skills: SkillMetadata[]): RuntimeTool {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return {
    description:
      "Load the full instructions for one matching project skill. Use only when the skill description applies to the current task.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The exact skill name from the available skill catalog." }
      },
      required: ["name"],
      additionalProperties: false
    },
    async execute(input) {
      const name =
        input && typeof input === "object" && typeof (input as { name?: unknown }).name === "string"
          ? (input as { name: string }).name.trim()
          : "";
      if (!name) throw new Error("load_skill requires a skill name");
      const skill = byName.get(name);
      if (!skill) throw new Error(`unknown skill: ${name}`);
      const body = instructionsOf(await readFile(skill.path, "utf8"));
      const scripts = await readdir(join(skill.directory, "scripts"), { withFileTypes: true }).catch(
        // eslint-disable-next-line no-restricted-syntax -- scripts 子目录是可选约定，没有它技能照常可用，空列表就是真实结果
        () => []
      );
      return {
        name: skill.name,
        path: skill.path,
        directory: skill.directory,
        scripts: Object.fromEntries(
          scripts
            .filter((entry) => entry.isFile())
            .map((entry) => [entry.name, join(skill.directory, "scripts", entry.name)])
        ),
        content: body
      };
    }
  };
}

/**
 * What the model reads when it loads a skill: the frontmatter repeats the
 * catalog entry it chose from, and a whole-line HTML comment (an attribution
 * note) is for maintainers. Comments inside code fences are content and stay.
 */
function instructionsOf(file: string): string {
  const lines = parseSkillFrontmatter(file).body.split("\n");
  const kept: string[] = [];
  let fenced = false;
  let comment = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!comment && /^(```|~~~)/.test(trimmed)) fenced = !fenced;
    if (comment) {
      comment = !trimmed.includes("-->");
      continue;
    }
    if (!fenced && trimmed.startsWith("<!--")) {
      if (!trimmed.includes("-->")) comment = true;
      // Text after a comment on its own line is content: keep that line.
      else if (!trimmed.endsWith("-->")) kept.push(line);
      continue;
    }
    kept.push(line);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function scanRoot(root: string, found: SkillMetadata[], seen: Set<string>): Promise<void> {
  const add = (skill: ParsedSkill | undefined, path: string, directory: string) => {
    if (!skill || seen.has(skill.name)) return;
    seen.add(skill.name);
    found.push({ name: skill.name, description: skill.description, path, directory });
  };
  // Pi also accepts individual skill files. Keep those user-configured paths
  // in the same scoped catalog as the directory roots.
  if (root.endsWith(".md")) {
    add(await parseSkill(root), root, dirname(root));
    return;
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
    // eslint-disable-next-line no-restricted-syntax -- 配置的 skill 根目录可能不存在或不可读，跳过它继续扫描其余根目录
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const skillPath = join(path, "SKILL.md");
      const skill = await parseSkill(skillPath);
      add(skill, skillPath, path);
      // Nested grouping directories are valid in the Agent Skills convention.
      await scanRoot(path, found, seen);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const skill = await parseSkill(path);
      add(skill, path, dirname(path));
    }
  }
}

interface ParsedSkill {
  name: string;
  description: string;
}

async function parseSkill(path: string): Promise<ParsedSkill | undefined> {
  try {
    // Skills written for Pi use a plain YAML mapping; the local reader covers
    // the scalar forms skills use, so discovery does not import a Pi package.
    const { frontmatter } = parseSkillFrontmatter(await readFile(path, "utf8"));
    if (frontmatter["disable-model-invocation"] === true) return undefined;
    const name =
      typeof frontmatter.name === "string" && frontmatter.name.trim()
        ? frontmatter.name.trim()
        : basename(dirname(path));
    const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
    if (!description) return undefined;
    return { name, description };
    // eslint-disable-next-line no-restricted-syntax -- 单个 SKILL.md 读不出或 frontmatter 损坏时跳过该技能，其余目录继续被发现
  } catch {
    return undefined;
  }
}
