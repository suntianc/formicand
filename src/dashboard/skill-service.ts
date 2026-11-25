import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  decideProjectTrust,
  projectDefinitionFolders,
  projectTrustDecision,
  type ProjectTrust
} from "../runtime/project-trust.js";
import {
  removeSkillFromIndex,
  restoreSkillToIndex,
  removedSkillDirectories
} from "../runtime/skill-index.js";
import {
  discoverSkills,
  installedSkillRoot,
  listSkillEntries,
  skillRootsFor,
  type SkillEntry,
  type SkillLocations,
  type SkillSource
} from "../runtime/skill-registry.js";
import { displayPath } from "../runtime/display-path.js";
import { HttpError } from "./http.js";
import { GIT_ALLOW_PROTOCOL, remoteUrlOf } from "./project-clone-service.js";

const run = promisify(execFile);

/** A skill as the settings screen shows it. */
export interface SkillView {
  name: string;
  description: string;
  directory: string;
  path: string;
  /** `path` as the screen shows it: relative in the project, `~/…` under home. */
  displayPath: string;
  source: SkillSource;
  removed: boolean;
  shadowedBy?: string;
  scripts: string[];
  /** Installed by Formicand into a `.formicand/skills` folder, so it may be deleted. */
  deletable: boolean;
}

export interface SkillProjectView {
  projectId: string;
  projectName: string;
  projectDirectory: string;
  displayDirectory: string;
  trust: ProjectTrust | null;
  /** Project-owned definition folders that exist, which is what trust is asked about. */
  folders: string[];
}

export type SkillScope = { scope: "global" } | { scope: "project"; projectId: string };

interface ProjectRecord {
  projectId: string;
  projectName?: string;
  projectDirectory?: string;
}

export interface SkillServiceOptions {
  harnessRoot: string;
  home: string;
  userHome: string;
  projectForId(projectId: string): Promise<ProjectRecord | null>;
  gitCommand?: string;
  unzipCommand?: string;
}

const GLOBAL_SOURCES: readonly SkillSource[] = ["global", "global-agents", "bundled"];
const PROJECT_SOURCES: readonly SkillSource[] = ["project", "project-agents"];
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const STAGING_TTL_MS = 60 * 60_000;
const COMMAND_TIMEOUT_MS = 120_000;
export const SKILL_ARCHIVE_LIMIT = 50 * 1024 * 1024;

interface Staging {
  root: string;
  /** The temporary folder (zip, git) the service removes; a local folder is only read. */
  cleanup?: string;
  createdAt: number;
}

export function createSkillService(options: SkillServiceOptions) {
  const staging = new Map<string, Staging>();
  const stagingRoot = join(options.home, "runtime", "skill-staging");

  async function project(projectId: string): Promise<SkillProjectView> {
    const record = await options.projectForId(projectId);
    if (!record?.projectDirectory) throw new HttpError(404, "项目不存在", "skill_project_missing");
    const projectDirectory = resolve(record.projectDirectory);
    return {
      projectId,
      projectName: record.projectName ?? projectId,
      projectDirectory,
      displayDirectory: displayPath(projectDirectory, { userHome: options.userHome }),
      trust: (await projectTrustDecision(options.home, projectDirectory)) ?? null,
      folders: projectDefinitionFolders(projectDirectory)
    };
  }

  function locations(projectDirectory: string | undefined, trusted: boolean): SkillLocations {
    return {
      harnessRoot: options.harnessRoot,
      home: options.home,
      userHome: options.userHome,
      ...(projectDirectory ? { projectDirectory } : {}),
      projectTrusted: trusted
    };
  }

  async function entries(target: SkillScope): Promise<{ project?: SkillProjectView; skills: SkillEntry[] }> {
    const removed = await removedSkillDirectories(options.home);
    if (target.scope === "global") {
      const all = await listSkillEntries(skillRootsFor(locations(undefined, false)), removed);
      return { skills: all.filter((entry) => GLOBAL_SOURCES.includes(entry.source)) };
    }
    const view = await project(target.projectId);
    if (view.trust !== "trusted") return { project: view, skills: [] };
    const all = await listSkillEntries(skillRootsFor(locations(view.projectDirectory, true)), removed);
    return { project: view, skills: all.filter((entry) => PROJECT_SOURCES.includes(entry.source)) };
  }

  async function scripts(directory: string): Promise<string[]> {
    try {
      const found = await readdir(join(directory, "scripts"), { withFileTypes: true });
      return found.filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async function view(entry: SkillEntry, projectDirectory?: string): Promise<SkillView> {
    return {
      name: entry.name,
      description: entry.description,
      directory: entry.directory,
      path: entry.path,
      displayPath: displayPath(entry.path, {
        userHome: options.userHome,
        ...(projectDirectory ? { projectDirectory } : {})
      }),
      source: entry.source,
      removed: entry.removed,
      ...(entry.shadowedBy ? { shadowedBy: entry.shadowedBy } : {}),
      scripts: await scripts(entry.directory),
      deletable: entry.source === "global" || entry.source === "project"
    };
  }

  /** Only a directory the current listing shows can be acted on. */
  async function listed(target: SkillScope, directory: string): Promise<SkillEntry> {
    const { skills } = await entries(target);
    const entry = skills.find((skill) => skill.directory === resolve(directory));
    if (!entry) throw new HttpError(404, "技能不存在或已变化，请刷新后重试", "skill_missing");
    return entry;
  }

  async function installRoot(target: SkillScope): Promise<string> {
    if (target.scope === "global") return installedSkillRoot(options.home);
    const view = await project(target.projectId);
    if (view.trust !== "trusted")
      throw new HttpError(409, "请先信任这个项目，再添加项目技能", "skill_project_untrusted");
    return join(view.projectDirectory, ".formicand", "skills");
  }

  async function pruneStaging(): Promise<void> {
    const now = Date.now();
    for (const [id, entry] of staging)
      if (now - entry.createdAt > STAGING_TTL_MS) {
        staging.delete(id);
        if (entry.cleanup) await rm(entry.cleanup, { recursive: true, force: true });
      }
  }

  async function preview(id: string, root: string, cleanup: string | undefined, target: SkillScope) {
    const found = await discoverSkills([root]);
    if (found.length === 0) {
      if (cleanup) await rm(cleanup, { recursive: true, force: true });
      throw new HttpError(422, "这里没有找到技能（需要包含 SKILL.md 的文件夹）", "skill_none_found");
    }
    staging.set(id, { root, ...(cleanup ? { cleanup } : {}), createdAt: Date.now() });
    const destination = await installRoot(target);
    return {
      stagingId: id,
      skills: await Promise.all(
        found.map(async (skill) => ({
          name: skill.name,
          description: skill.description,
          scripts: await scripts(skill.directory),
          valid: SKILL_NAME.test(skill.name),
          exists: existsSync(join(destination, skill.name))
        }))
      )
    };
  }

  async function newStaging(): Promise<{ id: string; root: string }> {
    await pruneStaging();
    const id = randomUUID();
    const root = join(stagingRoot, id);
    await mkdir(root, { recursive: true });
    return { id, root };
  }

  return {
    async list(target: SkillScope) {
      const { project: projectView, skills } = await entries(target);
      return {
        ...(projectView ? { project: projectView } : {}),
        skills: await Promise.all(skills.map((skill) => view(skill, projectView?.projectDirectory)))
      };
    },

    async previewFolder(folder: string, target: SkillScope) {
      const root = resolve(folder);
      const info = await stat(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new HttpError(404, "文件夹不存在", "skill_source_missing");
        throw error;
      });
      if (!info.isDirectory()) throw new HttpError(400, "请选择一个文件夹", "skill_source_invalid");
      await pruneStaging();
      return preview(randomUUID(), root, undefined, target);
    },

    async previewArchive(archive: Buffer, target: SkillScope) {
      const { id, root } = await newStaging();
      const file = join(root, "skills.zip");
      const extracted = join(root, "files");
      await writeFile(file, archive);
      try {
        await run(options.unzipCommand ?? "unzip", ["-q", file, "-d", extracted], {
          timeout: COMMAND_TIMEOUT_MS
        });
      } catch (error) {
        await rm(root, { recursive: true, force: true });
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        throw new HttpError(
          422,
          missing ? "找不到 unzip 命令" : "压缩包无法解开，请确认是 zip 文件",
          "skill_archive_invalid"
        );
      }
      await rm(file);
      return preview(id, extracted, root, target);
    },

    async previewGit(remote: string, target: SkillScope) {
      const url = remoteUrlOf(remote.trim());
      const { id, root } = await newStaging();
      const checkout = join(root, "repo");
      try {
        await run(options.gitCommand ?? "git", ["clone", "--depth", "1", "--quiet", "--", url, checkout], {
          timeout: COMMAND_TIMEOUT_MS,
          env: { ...process.env, GIT_ALLOW_PROTOCOL, GIT_TERMINAL_PROMPT: "0" }
        });
      } catch (error) {
        await rm(root, { recursive: true, force: true });
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        throw new HttpError(
          422,
          missing ? "找不到 Git，请先安装 Git 并确认它在 PATH 中" : "无法下载这个仓库，请检查地址和访问权限",
          "skill_git_failed"
        );
      }
      await rm(join(checkout, ".git"), { recursive: true, force: true });
      return preview(id, checkout, root, target);
    },

    async install(stagingId: string, names: string[], target: SkillScope, replace: boolean) {
      const entry = staging.get(stagingId);
      if (!entry) throw new HttpError(410, "预览已过期，请重新选择来源", "skill_staging_missing");
      const found = await discoverSkills([entry.root]);
      const chosen = found.filter((skill) => names.includes(skill.name));
      if (chosen.length === 0 || chosen.length !== new Set(names).size)
        throw new HttpError(400, "所选技能不在预览里", "skill_selection_invalid");
      const invalid = chosen.find((skill) => !SKILL_NAME.test(skill.name));
      if (invalid)
        throw new HttpError(400, `技能名称不能用作文件夹名：${invalid.name}`, "skill_name_invalid");
      const destination = await installRoot(target);
      const inside = chosen.find((skill) => {
        const from = relative(destination, skill.directory);
        return !from || (!from.startsWith("..") && !isAbsolute(from));
      });
      if (inside)
        throw new HttpError(409, `${inside.name} 已经在安装位置里，无需再次添加`, "skill_already_installed");
      const clash = chosen.find((skill) => existsSync(join(destination, skill.name)));
      if (clash && !replace) throw new HttpError(409, `已存在同名技能：${clash.name}`, "skill_exists");
      await mkdir(destination, { recursive: true });
      for (const skill of chosen) {
        const into = join(destination, skill.name);
        await rm(into, { recursive: true, force: true });
        await cp(skill.directory, into, { recursive: true, verbatimSymlinks: true });
        // A reinstalled skill is visible again.
        await restoreSkillToIndex(options.home, into);
      }
      staging.delete(stagingId);
      if (entry.cleanup) await rm(entry.cleanup, { recursive: true, force: true });
      return { installed: chosen.map((skill) => skill.name), directory: destination };
    },

    async remove(target: SkillScope, directory: string) {
      const entry = await listed(target, directory);
      await removeSkillFromIndex(options.home, { directory: entry.directory, name: entry.name });
      return { removed: entry.directory };
    },

    async restore(target: SkillScope, directory: string) {
      const entry = await listed(target, directory);
      if (!entry.removed) return { restored: false };
      return { restored: await restoreSkillToIndex(options.home, entry.directory) };
    },

    async delete(target: SkillScope, directory: string) {
      const entry = await listed(target, directory);
      if (entry.source !== "global" && entry.source !== "project")
        throw new HttpError(403, "只能删除本产品安装的技能；其他技能可以从索引移除", "skill_not_deletable");
      await rm(entry.directory, { recursive: true });
      await restoreSkillToIndex(options.home, entry.directory);
      return { deleted: entry.directory };
    },

    async trust(projectId: string, trust: ProjectTrust) {
      const view = await project(projectId);
      await decideProjectTrust(options.home, view.projectDirectory, trust);
      return { project: await project(projectId) };
    }
  };
}

export type SkillService = ReturnType<typeof createSkillService>;
