import { ProjectDataInvalidError } from "../domain/project-ledger.js";

export function storedJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ProjectDataInvalidError(`${label}已损坏`);
  }
}

export function storedArray(raw: string, label: string): unknown[] {
  const value = storedJson(raw, label);
  if (!Array.isArray(value)) throw new ProjectDataInvalidError(`${label}已损坏`);
  return value;
}

export function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
