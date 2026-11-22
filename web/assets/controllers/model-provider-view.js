import { ui } from "../ui/language.js";
import { icon } from "../ui/icons.js";
import { escapeHtml as esc } from "../ui/html.js";
import { PROVIDER_PRESETS } from "../model-provider-presets.js";
import { API_LABELS, providerLogo, requestPreview } from "./model-provider-display.js";

export const providerState = (provider) =>
  !provider.enabled ? "off" : !provider.configured ? "warn" : provider.models.length ? "ok" : "idle";

const formatTokens = (value) =>
  !value ? "" : value >= 1_000_000 ? `${Math.round(value / 100_000) / 10}M` : `${Math.round(value / 1000)}K`;

export function capabilityTags(model) {
  const tags = [];
  if (
    model.reasoning ??
    (model.supportsReasoningEffort || (model.reasoningLevels || []).some((l) => l !== "off"))
  )
    tags.push(`<span class="model-tag is-reasoning">${ui("推理")}</span>`);
  if (model.supportsImages ?? model.images)
    tags.push(`<span class="model-tag is-images">${ui("视觉")}</span>`);
  // The new-model default says nothing about the model; only a known window is shown.
  const context =
    model.contextWindow === 256000 && !model.autoLimits?.length ? "" : formatTokens(model.contextWindow);
  if (context) tags.push(`<span class="model-tag">${esc(context)} ${ui("上下文")}</span>`);
  return tags.join("");
}

function emptyProviderMarkup() {
  const quick = PROVIDER_PRESETS.filter((preset) =>
    ["deepseek", "zhipu", "moonshot", "bailian", "openai", "anthropic"].includes(preset.id)
  );
  return `<div class="provider-empty">
    <span class="provider-empty-icon">${icon("cpu")}</span>
    <h2>${ui("还没有模型供应商")}</h2>
    <p>${ui("添加一个供应商并填入 API Key，Main 和子 Agent 才能开始工作。")}</p>
    <div class="provider-quick">${quick
      .map(
        (preset) =>
          `<button type="button" class="provider-quick-item" data-preset="${preset.id}">${providerLogo({ preset: preset.id, name: preset.name }, 30)}<span>${esc(ui(preset.name))}</span></button>`
      )
      .join("")}</div>
    <button type="button" class="settings-link" data-provider-add>${icon("plus")}<span>${ui("其他供应商或自定义地址")}</span></button>
  </div>`;
}

export function providerDetailMarkup(provider, draft, locked) {
  if (!provider) return emptyProviderMarkup();
  const value = (field) => draft[field] ?? provider[field];
  const api = value("api");
  const baseUrl = value("baseUrl");
  const state = providerState(provider);
  const stateText = {
    ok: ui("已配置"),
    idle: ui("已配置，尚未添加模型"),
    warn: ui("缺少 API Key"),
    off: ui("未启用")
  }[state];
  return `
    <div class="provider-head">
      ${providerLogo(provider, 36)}
      <div class="provider-head-text">
        <input class="provider-name-input" data-field="name" value="${esc(value("name"))}" aria-label="${esc(ui("供应商名称"))}" maxlength="80"${locked ? " disabled" : ""}>
        <span class="provider-head-state"><span class="provider-dot is-${state}" aria-hidden="true"></span>${esc(stateText)}</span>
      </div>
      <span class="settings-row-spacer"></span>
      <span class="provider-toggle-label">${ui("启用")}</span>
      <button type="button" class="ui-switch" role="switch" data-provider-enabled aria-checked="${provider.enabled}" aria-label="${esc(ui("启用供应商"))}"${locked ? " disabled" : ""}></button>
      <button type="button" class="settings-icon-button" data-provider-delete aria-label="${esc(ui("删除供应商"))}" title="${esc(ui("删除供应商"))}"${locked ? " disabled" : ""}>${icon("trash")}</button>
    </div>
    <div class="provider-card">
      <label class="provider-field">
        <span class="provider-field-label">API Key<small>${ui("保存在执行主机的私有配置中")}</small></span>
        <span class="provider-input-row">
          <span class="provider-input"><input type="password" data-field="apiKey" autocomplete="off" spellcheck="false" value="${esc(draft.apiKey || "")}" placeholder="${esc(provider.configured ? ui("已保存，留空保留原密钥") : ui("填写 API Key"))}"${locked ? " disabled" : ""}><button type="button" class="provider-input-icon" data-reveal aria-label="${esc(ui("显示或隐藏 API Key"))}">${icon("eye")}</button></span>
          <button type="button" class="app-button is-secondary" data-provider-check${locked ? " disabled" : ""}>${icon("plug")}<span>${ui("检查")}</span></button>
        </span>
      </label>
      <label class="provider-field">
        <span class="provider-field-label">${ui("API 地址")}</span>
        <span class="provider-input"><input type="url" data-field="baseUrl" spellcheck="false" value="${esc(baseUrl)}"${locked ? " disabled" : ""}></span>
        <small class="provider-preview">${esc(requestPreview(baseUrl, api) ? ui`请求地址：${requestPreview(baseUrl, api)}` : "")}</small>
      </label>
      <div class="provider-field">
        <span class="provider-field-label">${ui("接口格式")}<small>${ui("决定请求路径与消息结构")}</small></span>
        <div class="settings-segmented" role="radiogroup" aria-label="${esc(ui("接口格式"))}">${Object.entries(
          API_LABELS
        )
          .map(
            ([id, label]) =>
              `<button type="button" role="radio" data-api="${id}" aria-checked="${api === id}"${locked ? " disabled" : ""}>${esc(label)}</button>`
          )
          .join("")}</div>
      </div>
      <details class="provider-advanced">
        <summary>${ui("高级")}${icon("chevron-down")}</summary>
        <div class="provider-advanced-body">
          <label class="provider-field is-inline"><span>${ui("思考模式格式")}</span>
            <select class="settings-select" data-field="thinkingFormat"${locked || api !== "openai-completions" ? " disabled" : ""}>
              ${[
                ["auto", ui("自动识别")],
                ["openai", ui("标准格式")],
                ["zai", ui("GLM 格式")]
              ]
                .map(
                  ([id, label]) =>
                    `<option value="${id}"${value("thinkingFormat") === id ? " selected" : ""}>${esc(label)}</option>`
                )
                .join("")}
            </select></label>
          <div class="provider-field is-inline"><span>${ui("会话缓存键（prompt_cache_key）")}<small>${ui("仅在服务商确认支持时开启")}</small></span>
            <button type="button" class="ui-switch" role="switch" data-field-switch="supportsPromptCacheKey" aria-checked="${value("supportsPromptCacheKey") === true}"${locked || api === "anthropic-messages" ? " disabled" : ""}></button></div>
        </div>
      </details>
      <div class="provider-save" ${Object.keys(draft).length ? "" : "hidden"}>
        <span data-provider-result role="status"></span>
        <span class="settings-row-spacer"></span>
        <button type="button" class="app-button is-secondary" data-provider-discard>${ui("放弃")}</button>
        <button type="button" class="app-button is-primary" data-provider-save${locked ? " disabled" : ""}>${ui("保存")}</button>
      </div>
      <p class="provider-check-result" data-check-result role="status"></p>
    </div>
    <div class="provider-models">
      <div class="provider-models-head">
        <h2 class="settings-group-title">${ui("模型")}</h2><span class="model-count">${provider.models.length}</span>
        <span class="settings-row-spacer"></span>
        <button type="button" class="app-button is-secondary" data-models-fetch${locked || !provider.configured ? " disabled" : ""}>${icon("refresh")}<span>${ui("获取模型列表")}</span></button>
        <button type="button" class="app-button is-secondary" data-models-add${locked ? " disabled" : ""}>${icon("plus")}<span>${ui("手动添加")}</span></button>
      </div>
      <div class="settings-rows provider-model-rows">${
        provider.models.length
          ? provider.models
              .map((model) => {
                return `<div class="provider-model-row" data-model-id="${esc(model.id)}">
                  <span class="provider-model-text"><span class="provider-model-name">${esc(model.name || model.id)}</span>${model.name ? `<span class="provider-model-id">${esc(model.id)}</span>` : ""}</span>
                  <span class="model-tags">${capabilityTags(model)}</span>
                  <span class="settings-row-spacer"></span>
                  <button type="button" class="settings-icon-button" data-model-settings="${esc(model.id)}" aria-label="${esc(ui`${model.id} 的参数`)}" title="${esc(ui("模型参数"))}"${locked ? " disabled" : ""}>${icon("settings")}</button>
                  <button type="button" class="settings-icon-button" data-model-remove="${esc(model.id)}" aria-label="${esc(ui`移除 ${model.id}`)}" title="${esc(ui("移除模型"))}"${locked ? " disabled" : ""}>${icon("minus")}</button>
                </div>`;
              })
              .join("")
          : `<div class="settings-row"><span class="settings-row-meta">${provider.configured ? ui("还没有模型，点「获取模型列表」从服务商读取，或手动添加。") : ui("填写 API Key 并保存后即可获取模型列表。")}</span></div>`
      }</div>
    </div>`;
}
