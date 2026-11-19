import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { atomicWrite } from "../storage/atomic-file.js";

/**
 * Whether the user trusts a project's own Agent definitions and skills.
 *
 * A project folder can carry `.atria/agents`, `.atria/skills` and
 * `.agents/skills`; their instructions reach the model, so they are read only
 * after the user said yes for that folder. The answer is remembered per folder.
 */
export type ProjectTrust = "trusted" | "untrusted";

interface ProjectTrustFile {
  projects: Partial<Record<string, { trust: ProjectTrust; decidedAt: string }>>;
}

export function projectTrustPath(home: string): string {
  return join(home, "project-trust.json");
}

async function readTrustFile(home: string): Promise<ProjectTrustFile> {
  const path = projectTrustPath(home);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { projects: {} };
    throw error;
  }
  const parsed = JSON.parse(text) as { projects?: unknown };
  if (!parsed.projects || typeof parsed.projects !== "object" || Array.isArray(parsed.projects))
    throw new Error(`${path}: "projects" must be an object`);
  const projects: ProjectTrustFile["projects"] = {};
  for (const [folder, entry] of Object.entries(
    parsed.projects as Record<string, { trust?: unknown; decidedAt?: unknown }>
  ))
    if ((entry.trust === "trusted" || entry.trust === "untrusted") && typeof entry.decidedAt === "string")
      projects[folder] = { trust: entry.trust, decidedAt: entry.decidedAt };
  return { projects };
}

/** The remembered answer for a folder, or undefined when the user was never asked. */
export async function projectTrustDecision(
  home: string,
  projectDirectory: string
): Promise<ProjectTrust | undefined> {
  return (await readTrustFile(home)).projects[resolve(projectDirectory)]?.trust;
}

export async function decideProjectTrust(
  home: string,
  projectDirectory: string,
  trust: ProjectTrust
): Promise<void> {
  const file = await readTrustFile(home);
  file.projects[resolve(projectDirectory)] = { trust, decidedAt: new Date().toISOString() };
  await atomicWrite(projectTrustPath(home), `${JSON.stringify(file, null, 2)}\n`);
}

/** The project-owned definition folders that exist, which is what the trust question is about. */
export function projectDefinitionFolders(projectDirectory: string): string[] {
  const root = resolve(projectDirectory);
  return [
    join(root, ".atria", "agents"),
    join(root, ".atria", "skills"),
    ...projectAgentsSkillRoots(root)
  ].filter((folder) => existsSync(folder));
}

/**
 * The `.agents/skills` directories from a project folder up to its repository
 * root, nearest first. Outside a repository only the folder itself counts.
 */
export function projectAgentsSkillRoots(projectDirectory: string): string[] {
  const start = resolve(projectDirectory);
  const roots: string[] = [];
  for (let directory = start; ; directory = dirname(directory)) {
    roots.push(join(directory, ".agents", "skills"));
    if (existsSync(join(directory, ".git"))) return roots;
    if (dirname(directory) === directory) return [join(start, ".agents", "skills")];
  }
}
