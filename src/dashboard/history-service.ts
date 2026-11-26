import { currentMainSession } from "../runtime/main-message-edit.js";
import {
  historyEntryById,
  HistoryReadError,
  readHistoryEntry,
  searchHistoryEntries,
  type HistoryMatch,
  type HistoryRead,
  type HistorySearch
} from "../runtime/session-history.js";
import { sessionDataDirectory } from "../runtime/session-tool-results.js";
import { HttpError } from "./http.js";

interface ProjectSession {
  taskId: string;
  /** The data root that holds the session's directory. */
  storageRoot: string;
  goal?: string;
  updatedAt: string;
}

/**
 * Main's search over the other conversations of its project.
 *
 * Main names only its own Task: the project and its sessions come from the
 * catalog, so a session of another project can be neither searched nor read.
 * A session without a project (a temporary workspace) has no other sessions.
 */
export function createHistoryService(options: {
  taskProjectId(taskId: string): Promise<string | null | undefined>;
  projectTasks(projectId: string): Promise<ProjectSession[]>;
}) {
  /** The project's other sessions, most recently updated first. */
  async function otherSessions(taskId: string): Promise<ProjectSession[]> {
    const projectId = await options.taskProjectId(taskId);
    if (!projectId)
      throw new HttpError(400, "这个会话不属于任何项目，没有其他会话可查", "history_project_required");
    return (await options.projectTasks(projectId))
      .filter((task) => task.taskId !== taskId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function opened(task: ProjectSession) {
    const { session } = await currentMainSession(task.storageRoot, task.taskId);
    return session && { entries: session.getEntries(), directory: sessionDataDirectory(session) };
  }

  return {
    async search(taskId: string, search: HistorySearch) {
      const matches: Array<HistoryMatch & { session: string; title?: string }> = [];
      for (const task of await otherSessions(taskId)) {
        const found = await opened(task);
        if (!found) continue;
        const remaining = search.limit - matches.length;
        for (const match of await searchHistoryEntries(found.directory, found.entries, {
          ...search,
          limit: remaining
        }))
          matches.push({ session: task.taskId, ...(task.goal ? { title: task.goal } : {}), ...match });
        if (matches.length >= search.limit) break;
      }
      return { matches };
    },

    async read(taskId: string, session: string, id: string, read: HistoryRead) {
      const task = (await otherSessions(taskId)).find((candidate) => candidate.taskId === session);
      if (!task) throw new HttpError(404, `这个项目里没有会话 ${session}`, "history_session_missing");
      const found = await opened(task);
      const entry = found && historyEntryById(found.entries, id);
      if (!found || !entry)
        throw new HttpError(404, `会话 ${session} 里没有条目 ${id}`, "history_entry_missing");
      try {
        return { content: await readHistoryEntry(found.directory, entry, read) };
      } catch (error) {
        if (error instanceof HistoryReadError)
          throw new HttpError(400, error.message, "history_read_invalid");
        throw error;
      }
    }
  };
}

export type HistoryService = ReturnType<typeof createHistoryService>;
