import { type IncomingMessage, type ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "./http.js";
import { type LocalPrincipal } from "./local-access.js";
import { commandContent, runCommand, sendCommandOutcome } from "./management-commands.js";

import type { DashboardRoutePorts } from "./routes.js";
import { publishProject, publishTask } from "./catalog-publication.js";

export async function handleProjectCatalogRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ports: Pick<
    DashboardRoutePorts,
    "chooseLocalDirectory" | "commands" | "createProject" | "updateProject" | "removeProject" | "events"
  >,
  principal: LocalPrincipal
): Promise<boolean> {
  const { chooseLocalDirectory } = ports;
  if (request.method === "POST" && url.pathname === "/api/projects/choose-directory") {
    const directory = await chooseLocalDirectory();
    sendJson(response, 200, {
      cancelled: !directory,
      ...(directory ? { projectDirectory: directory } : {})
    });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/projects") {
    const body = await readJsonBody(request);
    sendCommandOutcome(
      response,
      await runCommand(ports.commands, {
        principalId: principal.principalId,
        operationId: body.operationId,
        command: "projects.create",
        content: commandContent(body),
        apply: async () => {
          const project = await publishProject(
            ports.events,
            await ports.createProject({
              projectName: body.projectName,
              projectDirectory: body.projectDirectory,
              ...(body.projectId === undefined ? {} : { projectId: body.projectId })
            })
          );
          // A restored project's conversations were published as deleted; publish
          // them again so subscribers see them return (reconciling alone would
          // not revive them, since their own revisions did not change).
          for (const task of project.tasks) await publishTask(ports.events, task);
          return { status: 201, body: { project } };
        }
      })
    );
    return true;
  }
  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (request.method === "PATCH" && projectMatch) {
    const body = await readJsonBody(request);
    const projectId = decodeURIComponent(projectMatch[1]);
    sendCommandOutcome(
      response,
      await runCommand(ports.commands, {
        principalId: principal.principalId,
        operationId: body.operationId,
        command: "projects.update",
        // The target is part of the command: one operation id may not mean
        // "rename A" on one retry and "rename B" on the next.
        content: commandContent({ ...body, projectId }),
        apply: async () => ({
          status: 200,
          body: {
            project: await publishProject(
              ports.events,
              (await ports.updateProject(projectId, {
                projectName: body.projectName,
                projectDirectory: body.projectDirectory
              })) as { projectId: string }
            )
          }
        })
      })
    );
    return true;
  }
  // Removing only takes the project off the list; its folder and conversations stay.
  if (request.method === "DELETE" && projectMatch) {
    const removed = await ports.removeProject(decodeURIComponent(projectMatch[1]));
    // The conversations leave the catalog with it; the project's own removal
    // reaches subscribers through the next reconciliation.
    for (const taskId of removed.taskIds) await ports.events?.taskDeleted(taskId);
    sendJson(response, 200, { projectId: removed.projectId, removed: true });
    return true;
  }
  return false;
}
