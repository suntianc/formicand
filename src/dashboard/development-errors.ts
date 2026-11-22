import { ProjectDataConflictError } from "../domain/project-ledger.js";

export function conflict(message: string, code: string): ProjectDataConflictError {
  return new ProjectDataConflictError(message, undefined, code);
}
