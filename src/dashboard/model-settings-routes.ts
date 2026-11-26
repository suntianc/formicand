import { type IncomingMessage, type ServerResponse } from "node:http";
import { projectRoleSettings, resolveModelRole } from "../runtime/role-models.js";
import { readJsonBody, sendJson } from "./http.js";

import type { DashboardRoutePorts } from "./routes.js";

export async function handleModelSettingsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ports: Pick<DashboardRoutePorts, "availableModels" | "runtimeValue" | "webSearchSettings" | "modelSettings">
): Promise<boolean> {
  const { availableModels, runtimeValue } = ports;
  if (url.pathname === "/api/web-search-settings") {
    if (request.method === "GET") sendJson(response, 200, ports.webSearchSettings.status());
    else if (request.method === "POST")
      sendJson(response, 200, await ports.webSearchSettings.save(await readJsonBody(request)));
    else sendJson(response, 405, { error: "method not allowed" });
    return true;
  }
  const modelSettingsActions = {
    "/api/model-settings/providers": "saveProvider",
    "/api/model-settings/providers/delete": "deleteProvider",
    "/api/model-settings/models": "saveModels",
    "/api/model-settings/models/list": "listModels",
    "/api/model-settings/utility": "saveUtility"
  } as const;
  const modelSettingsAction = Object.hasOwn(modelSettingsActions, url.pathname)
    ? modelSettingsActions[url.pathname as keyof typeof modelSettingsActions]
    : undefined;
  if (modelSettingsAction) {
    if (request.method !== "POST") sendJson(response, 405, { error: "method not allowed" });
    else sendJson(response, 200, await ports.modelSettings[modelSettingsAction](await readJsonBody(request)));
    return true;
  }
  if (url.pathname === "/api/model-settings/levels" && request.method === "POST") {
    sendJson(response, 200, await ports.modelSettings.levels(await readJsonBody(request)));
    return true;
  }
  if (url.pathname === "/api/model-settings/test" && request.method === "POST") {
    sendJson(response, 200, await ports.modelSettings.test(await readJsonBody(request)));
    return true;
  }
  if (url.pathname === "/api/model-settings") {
    if (request.method === "GET") sendJson(response, 200, ports.modelSettings.status());
    else sendJson(response, 405, { error: "method not allowed" });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/models") {
    const status = ports.modelSettings.status();
    // The effort of the connection the next Main run resolves to, so the
    // composer can show it instead of an assumed default. Read from the same
    // role resolution the launch uses; absent when that connection is unusable.
    const mainRole = status.modelRoles.roles.find((entry) => entry.role === "main")?.effective;
    let mainEffort = mainRole?.thinkingLevel;
    let current = runtimeValue("FORMICAND_MODEL");
    let connectionProfileId = status.activeProfileId;
    // Whose models these are, so the composer can show the provider's mark.
    let mainProviderId = (mainRole?.connectionId || status.activeProfileId).split("#")[0];
    // A project may give Main its own model or level; the composer of a
    // conversation in that project shows and sends those.
    const projectDirectory = url.searchParams.get("projectDirectory")?.trim();
    const config = ports.modelSettings.config();
    const own = projectDirectory ? projectRoleSettings(config, "main", projectDirectory) : undefined;
    if (own?.profileId || own?.thinkingLevel) {
      const selection = resolveModelRole(config, { role: "main", projectDirectory });
      mainEffort = selection.thinkingLevel;
      const projectProfileId = own.profileId;
      if (selection.source === "project" && projectProfileId) {
        current = selection.model;
        connectionProfileId = projectProfileId;
        mainProviderId = projectProfileId.split("#")[0];
      }
    }
    const owner = status.providers.find((provider) => provider.id === mainProviderId);
    const models = await availableModels();
    sendJson(response, 200, {
      current,
      connectionProfileId,
      ...(mainEffort ? { reasoningEffort: mainEffort } : {}),
      ...(owner ? { provider: { name: owner.name, ...(owner.preset ? { preset: owner.preset } : {}) } } : {}),
      // Every usable provider's models, so the composer can switch a run to
      // another provider by its profile id.
      mainProviderId,
      providers: status.providers
        .filter((provider) => provider.enabled && provider.configured && provider.models.length)
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          ...(provider.preset ? { preset: provider.preset } : {}),
          models: provider.models.map((model) => ({
            id: model.id,
            ...(model.name ? { name: model.name } : {}),
            profileId: model.profileId,
            reasoningEffort: model.reasoningEffort,
            levels: model.supportsReasoningEffort
              ? (model.reasoningLevels ?? ["off", "low", "medium", "high", "xhigh", "max"])
              : ["off"]
          }))
        })),
      models: models.map((model) => model.id),
      // Each model's reasoning levels and where they came from (#27).
      levels: Object.fromEntries(models.map(({ id, levels, source }) => [id, { levels, source }])),
      configured: Boolean(runtimeValue("FORMICAND_API_BASE") && runtimeValue("FORMICAND_API_KEY"))
    });
    return true;
  }
  return false;
}
