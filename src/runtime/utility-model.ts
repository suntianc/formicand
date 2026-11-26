import type { FormicandConfig } from "./config.js";
import { modelConnections } from "./model-providers.js";
import { resolveModelRole, type ResolvedModelRole } from "./role-models.js";

/**
 * The model for the host's own small requests: the summary that hands a
 * context window over and the title of a new conversation.
 *
 * It is a host setting, not an Agent: nothing runs as it, and a host that
 * names none keeps using the model of the session the request is for.
 */
export interface UtilityModelSettings {
  profileId: string;
}

/** Structural validation while reading the local configuration. */
export function parseUtilityModel(value: unknown): UtilityModelSettings | undefined {
  return value === undefined ? undefined : utilitySettings(value);
}

function utilitySettings(value: unknown): UtilityModelSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("辅助模型设置无法读取");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (key !== "profileId") throw new Error(`辅助模型设置包含未知字段：${key}`);
  if (typeof record.profileId !== "string" || !record.profileId.trim() || record.profileId.length > 200)
    throw new Error("辅助模型设置无法读取");
  return { profileId: record.profileId.trim() };
}

/**
 * The connection the host's small requests use, or undefined when the host
 * names none. Read from the saved configuration alone: the environment a Main
 * process was launched with pins Main's connection, not this one.
 */
export function resolveUtilityModel(config: FormicandConfig): ResolvedModelRole | undefined {
  const profileId = config.utilityModel?.profileId;
  if (!profileId) return undefined;
  return resolveModelRole(config, { profileId }, {});
}

/** Replace the setting; an empty id follows the session's own model again. */
export function saveUtilityModel(config: FormicandConfig, value: unknown): FormicandConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("辅助模型设置无法读取");
  const profileId = (value as Record<string, unknown>).profileId;
  const { utilityModel: _previous, ...rest } = config;
  if (profileId === undefined || profileId === null || profileId === "") return rest;
  const settings = utilitySettings({ profileId });
  if (!modelConnections(config).profiles.some((profile) => profile.id === settings.profileId))
    throw new Error("模型不存在，请刷新设置后重试");
  return { ...rest, utilityModel: settings };
}
