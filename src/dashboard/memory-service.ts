import {
  deleteMemory,
  listMemories,
  memoryIndex,
  MemoryError,
  projectMemoryEnabled,
  readMemory,
  setProjectMemoryEnabled,
  writeMemory,
  type MemoryInput,
  type MemoryTarget
} from "../runtime/memory-store.js";
import { HttpError } from "./http.js";

export type MemoryScope = "user" | "project";

interface ProjectSummary {
  projectId: string;
  projectName: string;
}

/**
 * Settings → Memory and Main's `memory` tool, over one store.
 *
 * Settings names a project by id. Main names only a scope: its project comes
 * from the Task's own record, so an Agent cannot reach another project's
 * memory. A switched-off project scope is neither shown to Main nor writable
 * by it; the user can still read and edit it in settings.
 */
export function createMemoryService(options: {
  home: string;
  projectForId(projectId: string): Promise<ProjectSummary | null | undefined>;
  taskProjectId(taskId: string): Promise<string | null | undefined>;
}) {
  const { home } = options;

  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof MemoryError) throw new HttpError(400, error.message, error.code);
      throw error;
    }
  };

  async function project(projectId: string): Promise<ProjectSummary> {
    const found = await options.projectForId(projectId);
    if (!found) throw new HttpError(404, "项目不存在", "memory_project_missing");
    return found;
  }

  function target(scope: MemoryScope, projectId?: string): MemoryTarget {
    if (scope === "user") return { scope };
    if (!projectId) throw new HttpError(400, "项目记忆需要项目", "memory_project_required");
    return { scope, projectId };
  }

  /** The project a Task belongs to, and whether Main may use its memory. */
  async function taskScope(taskId: string) {
    const projectId = await options.taskProjectId(taskId);
    if (!projectId) return undefined;
    const found = await options.projectForId(projectId);
    if (!found) return undefined;
    return { ...found, enabled: await projectMemoryEnabled(home, projectId) };
  }

  async function taskTarget(taskId: string, scope: MemoryScope): Promise<MemoryTarget> {
    if (scope === "user") return { scope };
    const bound = await taskScope(taskId);
    if (!bound)
      throw new HttpError(400, "这个会话不属于任何项目，只能用用户级记忆", "memory_project_required");
    if (!bound.enabled) throw new HttpError(403, "用户关闭了这个项目的记忆", "memory_project_disabled");
    return { scope, projectId: bound.projectId };
  }

  return {
    async list(scope: MemoryScope, projectId?: string) {
      if (scope === "project" && projectId) await project(projectId);
      const memories = await guard(() => listMemories(home, target(scope, projectId)));
      return scope === "project" && projectId
        ? { memories, enabled: await projectMemoryEnabled(home, projectId) }
        : { memories };
    },

    async read(scope: MemoryScope, name: string, projectId?: string) {
      const memory = await guard(() => readMemory(home, target(scope, projectId), name));
      if (!memory) throw new HttpError(404, `没有名为 ${name} 的记忆`, "memory_missing");
      return { memory };
    },

    async save(scope: MemoryScope, input: MemoryInput, projectId?: string, previousName?: string) {
      if (scope === "project" && projectId) await project(projectId);
      return {
        memory: await guard(() => writeMemory(home, target(scope, projectId), input, { previousName }))
      };
    },

    async delete(scope: MemoryScope, name: string, projectId?: string) {
      return { deleted: await guard(() => deleteMemory(home, target(scope, projectId), name)) };
    },

    async setEnabled(projectId: string, enabled: boolean) {
      await project(projectId);
      await guard(() => setProjectMemoryEnabled(home, projectId, enabled));
      return { enabled };
    },

    /** Main's view: both scopes it may use, and the index for its system prompt. */
    async forTask(taskId: string) {
      const bound = await taskScope(taskId);
      const user = await listMemories(home, { scope: "user" });
      const projectMemories = bound?.enabled
        ? await listMemories(home, { scope: "project", projectId: bound.projectId })
        : [];
      return {
        project: bound ? { projectName: bound.projectName, enabled: bound.enabled } : null,
        index: memoryIndex([
          { label: "User (all projects)", entries: user },
          ...(bound ? [{ label: `Project ${bound.projectName}`, entries: projectMemories }] : [])
        ]),
        user,
        ...(bound?.enabled ? { projectMemories } : {})
      };
    },

    async taskAction(
      taskId: string,
      action:
        | { action: "read"; scope: MemoryScope; name: string }
        | { action: "write"; scope: MemoryScope; memory: MemoryInput }
        | { action: "delete"; scope: MemoryScope; name: string }
    ) {
      const memoryTarget = await taskTarget(taskId, action.scope);
      if (action.action === "write")
        return { memory: await guard(() => writeMemory(home, memoryTarget, action.memory)) };
      if (action.action === "delete")
        return { deleted: await guard(() => deleteMemory(home, memoryTarget, action.name)) };
      const memory = await guard(() => readMemory(home, memoryTarget, action.name));
      if (!memory) throw new HttpError(404, `没有名为 ${action.name} 的记忆`, "memory_missing");
      return { memory };
    }
  };
}

export type MemoryService = ReturnType<typeof createMemoryService>;
