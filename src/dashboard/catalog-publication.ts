import type { CatalogEvents } from "./catalog-events.js";

/** Publish the committed catalog entry. Reconciliation covers a failed append. */
export async function publishProject<T extends { projectId: string }>(
  events: CatalogEvents | undefined,
  project: T
): Promise<T> {
  await events?.project(project);
  return project;
}

export async function publishTask<T extends { taskId: string }>(
  events: CatalogEvents | undefined,
  task: T
): Promise<T> {
  await events?.task(task);
  return task;
}
