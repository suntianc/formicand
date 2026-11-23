import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveTaskArtifact } from "../workspace/artifact-store.js";
import type { ProjectFileIndex } from "../workspace/project-file-index.js";
import {
  ProjectFileMissing,
  projectFileVersion,
  projectReference,
  resolveProjectFile
} from "../workspace/project-files.js";
import { serveFile } from "./file-response.js";
import { HttpError, sendJson } from "./http.js";
import type { TaskLocation } from "./workspace-directory.js";

/** Most candidates one file reference offers. */
const REFERENCE_MATCHES = 20;

const TASK_FILE_PATH = /^\/api\/tasks\/([^/]+)\/(artifact|project-file|project-file\/resolve|file-location)$/;

export interface TaskFilePorts {
  locateTask(taskId: string): Promise<TaskLocation>;
  projectFiles: ProjectFileIndex;
}

function requestedPath(url: URL): string {
  const path = url.searchParams.get("path") ?? "";
  if (!path || path.length > 4096) throw new HttpError(400, "文件路径不合法");
  return path;
}

async function projectFile(location: TaskLocation, path: string) {
  try {
    return await resolveProjectFile(location.projectDirectory, path);
  } catch (error) {
    if (error instanceof ProjectFileMissing) throw new HttpError(404, error.message, "file_missing");
    throw error;
  }
}

/**
 * The files one session can preview: its published artifacts and the files
 * of its project folder (a session without a project reads its own temporary
 * folder). Every path is resolved and contained by its source; the request
 * never names a file on the machine.
 */
export async function handleTaskFileRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ports: TaskFilePorts
): Promise<boolean> {
  const match = url.pathname.match(TASK_FILE_PATH);
  if (!match || request.method !== "GET") return false;
  const taskId = decodeURIComponent(match[1]);
  const location = await ports.locateTask(taskId);
  const route = match[2];
  if (route === "artifact") {
    const relativePath = url.searchParams.get("path") ?? "";
    const { absolutePath, stat, artifact } = await resolveTaskArtifact({
      workspaceRoot: location.workspaceRoot,
      taskId,
      relativePath
    });
    await serveFile(request, response, url, {
      absolutePath,
      stat,
      path: relativePath,
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      version: artifact.sha256,
      endpoint: `/api/tasks/${encodeURIComponent(taskId)}/artifact?path=${encodeURIComponent(relativePath)}`
    });
    return true;
  }
  if (route === "project-file") {
    const path = requestedPath(url);
    const { absolutePath, stat } = await projectFile(location, path);
    await serveFile(request, response, url, {
      absolutePath,
      stat,
      path,
      version: projectFileVersion(stat),
      endpoint: `/api/tasks/${encodeURIComponent(taskId)}/project-file?path=${encodeURIComponent(path)}`
    });
    return true;
  }
  if (route === "project-file/resolve") {
    const reference = await projectReference(location.projectDirectory, requestedPath(url));
    if (!reference) {
      sendJson(response, 200, { matches: [] });
      return true;
    }
    try {
      await projectFile(location, reference);
      sendJson(response, 200, { matches: [reference] });
      return true;
    } catch (error) {
      // A shortened path or a bare name is looked up in the project's listing.
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
    }
    sendJson(response, 200, {
      matches: await ports.projectFiles.candidates(location.projectDirectory, reference, REFERENCE_MATCHES)
    });
    return true;
  }
  const source = url.searchParams.get("source");
  const path = requestedPath(url);
  if (source === "artifact") {
    const { absolutePath } = await resolveTaskArtifact({
      workspaceRoot: location.workspaceRoot,
      taskId,
      relativePath: path
    });
    sendJson(response, 200, { absolutePath });
    return true;
  }
  if (source === "project") {
    sendJson(response, 200, { absolutePath: (await projectFile(location, path)).absolutePath });
    return true;
  }
  throw new HttpError(400, "文件来源不合法");
}
