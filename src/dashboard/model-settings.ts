import { existsSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { formicandConfigPath, readFormicandConfig, type FormicandConfig } from "../runtime/config.js";
import { withFileLock } from "../storage/file-lock.js";
import { testModelConnection } from "../runtime/model-connection.js";
import {
  deleteProvider,
  providerDraft,
  publicProviders,
  saveProvider,
  saveProviderModels,
  withActiveConnection
} from "../runtime/model-providers.js";
import { NEW_CONNECTION_PROFILE } from "../runtime/model-profile.js";
import { availableModels as catalogModels } from "../runtime/model-catalog.js";
import { isOfficialAddress, modelLevels, officialModel } from "../runtime/model-levels.js";
import { publicModelRoles, saveRoleSettings } from "../runtime/role-models.js";
import { saveUtilityModel } from "../runtime/utility-model.js";
import {
  applyHostCredentials,
  hasHostCredentials,
  HostCredentialStore,
  hostCredentialsPath,
  mergeHostCredentials,
  retainProviderCredentials,
  takeHostCredentials
} from "../security/host-credentials.js";

const ENVIRONMENT_KEYS = [
  "FORMICAND_API_BASE",
  "FORMICAND_API_KEY",
  "FORMICAND_MODEL",
  "FORMICAND_SUPPORTS_IMAGES",
  "FORMICAND_MODEL_API",
  "FORMICAND_SUPPORTS_PROMPT_CACHE_KEY",
  "FORMICAND_THINKING_FORMAT",
  "FORMICAND_CONTEXT_WINDOW"
];

/**
 * Model providers and role bindings on the execution host.
 *
 * The response never carries a secret: provider keys are written to the host
 * credential store and the public configuration only describes the providers
 * and their models. A provider whose key is missing is reported as
 * unconfigured and becomes usable again when a key is submitted.
 */
export function createModelSettings(
  root: string,
  config: FormicandConfig,
  options: { credentialsPath?: string } = {}
) {
  const path = formicandConfigPath(root);
  const store = new HostCredentialStore(options.credentialsPath ?? hostCredentialsPath(path));
  if (!store.error) applyHostCredentials(config, store.value);
  const managed = () =>
    ENVIRONMENT_KEYS.some((key) => process.env[key] !== undefined && process.env[key] !== "");
  const status = () => {
    const error = store.error;
    return {
      ...publicProviders(config),
      model: process.env.FORMICAND_MODEL || config.model || "",
      configured: Boolean(
        (process.env.FORMICAND_API_BASE || config.baseUrl || config.apiBase) &&
        (process.env.FORMICAND_API_KEY || config.apiKey)
      ),
      managedByEnvironment: managed(),
      ...(error ? { credentialError: error } : {}),
      modelRoles: publicModelRoles(config),
      utilityModel: config.utilityModel?.profileId ?? null,
      contextTrim: config.contextTrim !== false
    };
  };
  /**
   * One atomic private write for the public configuration.
   *
   * Keys are moved to the host store before the file is written, so a settings
   * response and the file on disk can never disagree about where a secret lives.
   */
  const persist = async (next: FormicandConfig) => {
    const persisted = structuredClone(next);
    const extracted = takeHostCredentials(persisted);
    const credentials = retainProviderCredentials(mergeHostCredentials(store.value, extracted), persisted);
    if (hasHostCredentials(credentials) || existsSync(store.path)) await store.write(credentials);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(persisted, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
    for (const key of ["baseUrl", "apiBase", "model", "apiKey", "reasoningLevels", "autoLimits"] as const)
      delete config[key];
    Object.assign(config, persisted);
    if (persisted.roleModels) config.roleModels = persisted.roleModels;
    else delete config.roleModels;
    if (!persisted.utilityModel) delete config.utilityModel;
    if (persisted.contextTrim === undefined) delete config.contextTrim;
    applyHostCredentials(config, credentials);
  };
  /**
   * Read the saved file with its keys, change it and write it back under the file lock.
   *
   * Allowed while a turn runs: a Main turn and a work item hold the model,
   * address and key they started with, so a change applies from the next one.
   */
  const update = async (change: (previous: FormicandConfig) => FormicandConfig) => {
    if (managed()) throw new Error("当前模型连接由启动环境管理，请在启动配置中修改");
    await withFileLock(path, async () => {
      store.reload();
      if (store.error) throw new Error(store.error);
      const previous = existsSync(path) ? readFormicandConfig(root, { FORMICAND_CONFIG: path }) : config;
      applyHostCredentials(previous, store.value);
      await persist(change(previous));
    });
  };
  /** A draft provider's address, format and key: form values over the saved provider. */
  const draft = (value: Record<string, unknown>) => {
    if (store.error && !(typeof value.apiKey === "string" && value.apiKey.trim()))
      throw new Error(store.error);
    return providerDraft(config, value);
  };
  return {
    status,
    saveProvider: async (value: Record<string, unknown>) => {
      await update((previous) => saveProvider(previous, value));
      return status();
    },
    deleteProvider: async (value: Record<string, unknown>) => {
      await update((previous) => deleteProvider(previous, value));
      return status();
    },
    saveModels: async (value: Record<string, unknown>) => {
      await update((previous) => saveProviderModels(previous, value));
      return status();
    },
    /**
     * The models a provider offers, with what its listing and Pi's catalog say
     * about each, for the "fetch model list" dialog. Nothing is saved.
     */
    async listModels(value: Record<string, unknown>) {
      const provider = draft(value);
      if (!provider.apiKey) throw new Error("请先填写 API Key");
      const listed = (
        await catalogModels({
          ...config,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          api: provider.api,
          model: ""
        })
      ).filter((entry) => entry.id);
      const added = new Set(provider.saved?.models.map((model) => model.id));
      return {
        models: await Promise.all(
          listed.map(async (entry) => {
            const known = await officialModel(provider.baseUrl, entry.id);
            const name = entry.name ?? known?.name;
            const facts = {
              contextWindow: entry.limits?.contextWindow ?? known?.contextWindow,
              maxTokens: entry.limits?.maxOutputTokens ?? known?.maxTokens,
              images: entry.limits?.images ?? known?.images,
              reasoning:
                known?.reasoning ?? (entry.levels ? entry.levels.some((level) => level !== "off") : undefined)
            };
            return {
              id: entry.id,
              ...(name && name !== entry.id ? { name } : {}),
              ...Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined)),
              added: added.has(entry.id)
            };
          })
        )
      };
    },
    /** Probe one model of a provider with the real request path. */
    async test(value: Record<string, unknown>) {
      if (managed()) throw new Error("当前模型连接由启动环境管理，请在启动配置中修改");
      const provider = draft(value);
      const model = typeof value.model === "string" ? value.model.trim() : "";
      const saved = provider.saved?.models.find((entry) => entry.id === model);
      return testModelConnection({
        ...(saved ?? NEW_CONNECTION_PROFILE),
        api: provider.api,
        thinkingFormat: provider.thinkingFormat,
        supportsPromptCacheKey: provider.saved?.supportsPromptCacheKey ?? false,
        baseUrl: provider.baseUrl,
        model,
        apiKey: provider.apiKey,
        supportsImages: saved?.supportsImages ?? false
      });
    },
    /**
     * The reasoning levels a provider's model accepts and where they come
     * from (#27), plus the model's own limits for the advanced settings: the
     * provider's `/models` entry, then Pi's table for a known provider address,
     * else the model's saved choice.
     */
    async levels(value: Record<string, unknown>) {
      const provider = draft(value);
      const model = typeof value.model === "string" ? value.model.trim() : "";
      const saved = provider.saved?.models.find((entry) => entry.id === model);
      const catalog =
        model && provider.apiKey
          ? await catalogModels({
              ...config,
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKey,
              api: provider.api,
              model
            })
          : [];
      const listed = catalog.find((entry) => entry.id === model);
      const known = await officialModel(provider.baseUrl, model);
      return {
        ...(await modelLevels({
          baseUrl: provider.baseUrl,
          model,
          endpoint: listed?.levels,
          manual: saved?.reasoningLevels
        })),
        limits: {
          ...(known
            ? { contextWindow: known.contextWindow, maxOutputTokens: known.maxTokens, images: known.images }
            : {}),
          ...listed?.limits
        },
        official: await isOfficialAddress(provider.baseUrl)
      };
    },
    /**
     * Save one built-in Agent's settings, globally or for one project.
     */
    async saveRole(value: { role: unknown; projectDirectory?: string; settings: unknown }) {
      await update((previous) => withActiveConnection(saveRoleSettings(previous, value)));
      return status();
    },
    /** Choose the model for context summaries and conversation titles; empty follows each session's. */
    async saveUtility(value: Record<string, unknown>) {
      await update((previous) => saveUtilityModel(previous, value));
      return status();
    },
    /** Main reads it at each turn's end, so a running conversation follows it from its next turn. */
    async saveContextTrim(value: Record<string, unknown>) {
      if (typeof value.enabled !== "boolean") throw new Error("enabled 必须为布尔值");
      const enabled = value.enabled;
      await update((previous) => {
        const next = { ...previous };
        if (enabled) delete next.contextTrim;
        else next.contextTrim = false;
        return next;
      });
      return status();
    },
    /** The configuration this host runs with, for views that resolve built-in Agent settings. */
    config: () => config
  };
}
