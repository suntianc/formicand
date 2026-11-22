import { ui } from "../ui/language.js";
import { icon } from "../ui/icons.js";
import { escapeHtml as esc } from "../ui/html.js";
import { createModal } from "../ui/modal.js";
import { LEVEL_LABELS } from "./model-picker.js";
import { PRESET_REGIONS, PROVIDER_PRESETS, presetById } from "../model-provider-presets.js";
import { API_LABELS, providerLogo, requestPreview } from "./model-provider-display.js";
import { capabilityTags, providerDetailMarkup, providerState } from "./model-provider-view.js";

export { modelFamily, providerLogo, requestPreview } from "./model-provider-display.js";

const LEVELS = ["off", "low", "medium", "high", "xhigh", "max"];

/**
 * Model providers.
 *
 * Providers hold an address, a wire format and a key, and offer models. Which
 * model Main and each Agent use is chosen on the Agent page. Keys are
 * submitted once and never read back.
 */
export function installModelProviders({
  panel,
  request,
  status,
  showToast,
  onSaved,
  errorMessage,
  identity = () => ""
}) {
  let snapshot;
  let selectedId = "";
  let query = "";
  let busy = false;
  /** Unsaved account fields per provider id, kept per backend so a switch never mixes them. */
  const backendDrafts = new Map();
  const drafts = () => {
    const key = identity() ?? "";
    if (!backendDrafts.has(key)) backendDrafts.set(key, new Map());
    return backendDrafts.get(key);
  };

  panel.innerHTML = `
    <div class="model-settings-head">
      <h1 class="settings-page-title">${ui("模型")}</h1>
      <p class="model-settings-hint">${icon("info")}<span>${ui("配置供应商并获取模型；Main 和各 Agent 用哪个模型，在「Agent」页里选")}</span></p>
    </div>
    <p class="model-settings-notice" data-model-notice role="alert" hidden></p>
    <div class="provider-layout" data-model-view="providers">
      <aside class="provider-list">
        <label class="provider-search">${icon("search")}<input type="search" data-provider-search placeholder="${esc(ui("搜索供应商"))}" aria-label="${esc(ui("搜索供应商"))}"></label>
        <div class="provider-items" data-provider-items></div>
        <button type="button" class="provider-add" data-provider-add>${icon("plus")}<span>${ui("添加供应商")}</span></button>
      </aside>
      <div class="provider-detail" data-provider-detail></div>
    </div>`;
  const $ = (selector) => panel.querySelector(selector);
  const notice = $("[data-model-notice]");
  const list = $("[data-provider-items]");
  const detail = $("[data-provider-detail]");

  const managed = () => snapshot?.managedByEnvironment === true;
  const providers = () => snapshot?.providers || [];
  const selected = () => providers().find((provider) => provider.id === selectedId);
  const showNotice = () => {
    const message = managed()
      ? ui("当前模型连接由启动环境管理，请在启动配置中修改。")
      : snapshot?.credentialError || "";
    notice.textContent = message;
    notice.hidden = !message;
  };

  /* ------------------------------------------------------------ provider list */

  const renderList = () => {
    const items = providers().filter((provider) =>
      `${provider.name} ${provider.baseUrl}`.toLowerCase().includes(query.toLowerCase())
    );
    list.innerHTML = items.length
      ? items
          .map((provider) => {
            const state = providerState(provider);
            const meta = !provider.enabled
              ? ui("未启用")
              : !provider.configured
                ? ui("缺少 API Key")
                : provider.models.length
                  ? ui`${provider.models.length} 个模型`
                  : ui("未添加模型");
            return `<button type="button" class="provider-item" data-provider-id="${esc(provider.id)}" aria-current="${provider.id === selectedId}">
              ${providerLogo(provider, 28)}
              <span class="provider-item-text"><span class="provider-item-name">${esc(provider.name)}</span><span class="provider-item-meta">${esc(meta)}</span></span>
              <span class="provider-dot is-${state}" aria-hidden="true"></span>
            </button>`;
          })
          .join("")
      : `<p class="provider-empty-list">${providers().length ? ui("没有匹配的供应商") : ui("还没有供应商")}</p>`;
  };

  /* ---------------------------------------------------------- provider detail */

  const draftOf = (provider) => drafts().get(provider.id) || {};
  const value = (provider, field) => draftOf(provider)[field] ?? provider[field];
  const dirty = (provider) => Object.keys(draftOf(provider)).length > 0;

  const renderDetail = () => {
    const provider = selected();
    detail.innerHTML = providerDetailMarkup(provider, provider && draftOf(provider), managed() || busy);
  };

  /* -------------------------------------------------------------- rendering */

  const render = () => {
    showNotice();
    renderList();
    renderDetail();
  };

  const apply = (next) => {
    snapshot = next;
    if (!providers().some((provider) => provider.id === selectedId)) selectedId = providers()[0]?.id || "";
    for (const id of drafts().keys())
      if (!providers().some((provider) => provider.id === id)) drafts().delete(id);
    render();
  };

  /** Only the newest read answers; an older one for another backend is dropped. */
  let reading = 0;
  const refresh = async () => {
    const revision = ++reading;
    try {
      const next = await status();
      if (revision === reading) apply(next);
    } catch (error) {
      if (revision !== reading) return;
      notice.textContent = errorMessage(error);
      notice.hidden = false;
    }
  };

  /** Run one change; the panel shows the backend's answer and stays usable on failure. */
  const run = async (work, success) => {
    if (busy) return;
    busy = true;
    render();
    try {
      const next = await work();
      busy = false;
      if (next?.providers) apply(next);
      else await refresh();
      if (success) showToast(success);
      onSaved?.();
      return true;
    } catch (error) {
      busy = false;
      render();
      showToast(errorMessage(error));
      return false;
    }
  };

  const post = (path, body) => request("POST", body, path);
  const saveDraft = async (provider) => {
    const draft = draftOf(provider);
    const ok = await run(
      () => post("/api/model-settings/providers", { id: provider.id, ...draft }),
      ui("供应商已保存")
    );
    if (ok) drafts().delete(provider.id);
    render();
  };

  /* ------------------------------------------------------------------ dialogs */

  const dialogs = [];
  const createDialog = (className, label) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop provider-dialog-backdrop";
    backdrop.hidden = true;
    backdrop.innerHTML = `<section class="modal-card provider-dialog ${className}" role="dialog" aria-modal="true" aria-label="${esc(label)}">
      <header class="provider-dialog-head"><h2>${esc(label)}</h2><button type="button" class="settings-icon-button" data-dialog-close aria-label="${esc(ui("关闭"))}">${icon("close")}</button></header>
      <div class="provider-dialog-body" data-dialog-body></div>
      <footer class="provider-dialog-foot" data-dialog-foot></footer>
    </section>`;
    document.body.append(backdrop);
    const modal = createModal(backdrop, backdrop.querySelector("[data-dialog-close]"));
    const dialog = {
      backdrop,
      body: backdrop.querySelector("[data-dialog-body]"),
      foot: backdrop.querySelector("[data-dialog-foot]"),
      open: modal.open,
      close: modal.close,
      title: (text) => (backdrop.querySelector(".provider-dialog-head h2").textContent = text)
    };
    dialogs.push(dialog);
    return dialog;
  };

  /* Add provider: presets grouped by region, then the key. */
  const addDialog = createDialog("is-add", ui("添加供应商"));
  let addPreset = "deepseek";
  const renderAdd = () => {
    const preset = presetById(addPreset);
    const custom = !preset;
    addDialog.body.innerHTML = `
      <p class="provider-dialog-lead">${ui("预置供应商会自动填好 API 地址和接口格式，只需填写 API Key；其他兼容 OpenAI 或 Anthropic 接口的服务选「自定义」。")}</p>
      ${PRESET_REGIONS.map(
        ([region, label]) =>
          `<div class="preset-section"><h3>${esc(ui(label))}</h3><div class="preset-grid">${PROVIDER_PRESETS.filter(
            (entry) => entry.region === region
          )
            .map(
              (entry) =>
                `<button type="button" class="preset-item" data-add-preset="${entry.id}" aria-pressed="${entry.id === addPreset}">${providerLogo({ preset: entry.id, name: entry.name }, 24)}<span>${esc(ui(entry.name))}</span></button>`
            )
            .join("")}${
            region === "local"
              ? `<button type="button" class="preset-item" data-add-preset="custom" aria-pressed="${custom}"><span class="provider-logo is-letter" style="--logo-size:24px">${icon("plus")}</span><span>${ui("自定义")}</span></button>`
              : ""
          }</div></div>`
      ).join("")}
      <div class="provider-dialog-fields">
        ${
          custom
            ? `<label class="provider-field"><span class="provider-field-label">${ui("名称")}</span><span class="provider-input"><input data-add="name" maxlength="80" required placeholder="${esc(ui("例如：公司网关"))}"></span></label>
               <label class="provider-field"><span class="provider-field-label">${ui("API 地址")}</span><span class="provider-input"><input data-add="baseUrl" type="url" required placeholder="https://example.com/v1"></span></label>
               <div class="provider-field"><span class="provider-field-label">${ui("接口格式")}</span><div class="settings-segmented" role="radiogroup">${Object.entries(
                 API_LABELS
               )
                 .map(
                   ([id, label], index) =>
                     `<button type="button" role="radio" data-add-api="${id}" aria-checked="${index === 0}">${esc(label)}</button>`
                 )
                 .join("")}</div></div>`
            : ""
        }
        <label class="provider-field"><span class="provider-field-label">API Key</span><span class="provider-input"><input data-add="apiKey" type="password" autocomplete="off" spellcheck="false" value="${esc(preset?.apiKey || "")}" placeholder="${esc(ui("填写 API Key"))}"></span>
          ${preset?.keyUrl ? `<small><a href="${esc(preset.keyUrl)}" target="_blank" rel="noreferrer">${esc(ui`前往 ${ui(preset.name)} 获取 API Key`)} ↗</a></small>` : ""}</label>
        ${preset ? `<small class="provider-preview">${esc(ui`API 地址：${preset.baseUrl}`)} · ${esc(API_LABELS[preset.api])}</small>` : ""}
      </div>`;
    addDialog.foot.innerHTML = `<span data-add-error class="provider-dialog-error" role="alert"></span><span class="settings-row-spacer"></span>
      <button type="button" class="app-button is-secondary" data-add-cancel>${ui("取消")}</button>
      <button type="button" class="app-button is-primary" data-add-submit>${ui("添加并获取模型")}</button>`;
  };
  addDialog.backdrop.addEventListener("click", async (event) => {
    const presetButton = event.target.closest("[data-add-preset]");
    if (presetButton) {
      addPreset = presetButton.dataset.addPreset;
      renderAdd();
      addDialog.body.querySelector('[data-add="name"], [data-add="apiKey"]')?.focus();
      return;
    }
    const apiButton = event.target.closest("[data-add-api]");
    if (apiButton)
      for (const button of addDialog.body.querySelectorAll("[data-add-api]"))
        button.setAttribute("aria-checked", String(button === apiButton));
    if (event.target.closest("[data-add-cancel]")) addDialog.close();
    if (!event.target.closest("[data-add-submit]") || busy) return;
    const field = (name) => addDialog.body.querySelector(`[data-add="${name}"]`)?.value.trim() || "";
    const preset = presetById(addPreset);
    const body = preset
      ? {
          preset: preset.id,
          name: ui(preset.name),
          baseUrl: preset.baseUrl,
          api: preset.api,
          apiKey: field("apiKey")
        }
      : {
          name: field("name"),
          baseUrl: field("baseUrl"),
          api: addDialog.body.querySelector('[data-add-api][aria-checked="true"]')?.dataset.addApi,
          apiKey: field("apiKey")
        };
    const error = addDialog.foot.querySelector("[data-add-error]");
    error.textContent = "";
    const before = new Set(providers().map((provider) => provider.id));
    const submit = addDialog.foot.querySelector("[data-add-submit]");
    const pending = (on) => {
      submit.setAttribute("aria-busy", String(on));
      submit.disabled = on;
    };
    busy = true;
    pending(true);
    try {
      const next = await post("/api/model-settings/providers", body);
      busy = false;
      pending(false);
      apply(next);
      selectedId = providers().find((provider) => !before.has(provider.id))?.id || selectedId;
      render();
      addDialog.close();
      onSaved?.();
      void openFetch();
    } catch (failure) {
      busy = false;
      pending(false);
      error.textContent = errorMessage(failure);
    }
  });
  const openAdd = (preset = "deepseek") => {
    if (managed()) return;
    addPreset = preset;
    renderAdd();
    addDialog.open();
    addDialog.body.querySelector('[data-add="apiKey"]')?.focus();
  };

  /* Fetch the provider's model list and pick what to add. */
  const fetchDialog = createDialog("is-fetch", ui("获取模型列表"));
  let listing = [];
  let listingLoading = false;
  let picked = new Set();
  let filter = { text: "", kind: "all" };
  const renderFetch = () => {
    const shown = listing.filter(
      (model) =>
        model.id.toLowerCase().includes(filter.text.toLowerCase()) &&
        (filter.kind === "all" ||
          (filter.kind === "reasoning" && model.reasoning) ||
          (filter.kind === "images" && model.images))
    );
    fetchDialog.body.querySelector("[data-fetch-list]").innerHTML = listingLoading
      ? `<div class="fetch-loading" role="status"><span class="ui-spinner" aria-hidden="true"></span><span>${ui("正在读取模型列表…")}</span></div>`
      : shown.length
        ? shown
            .map(
              (model) => `<label class="fetch-item${model.added ? " is-added" : ""}">
              <input type="checkbox" value="${esc(model.id)}"${model.added || picked.has(model.id) ? " checked" : ""}${model.added ? " disabled" : ""}>
              <span class="fetch-item-text"><span class="provider-model-id">${esc(model.id)}</span>${model.name ? `<small>${esc(model.name)}</small>` : ""}</span>
              <span class="model-tags">${capabilityTags({ ...model, supportsImages: model.images })}</span>
              <span class="settings-row-spacer"></span>
              ${model.added ? `<small>${ui("已加入")}</small>` : ""}
            </label>`
            )
            .join("")
        : `<p class="provider-empty-list">${listing.length ? ui("没有匹配的模型") : ui("服务商没有返回模型。请检查 API Key 和地址，或关闭后手动添加。")}</p>`;
    fetchDialog.foot.querySelector("[data-fetch-count]").textContent = picked.size
      ? ui`新选 ${picked.size} 个模型`
      : "";
    const submit = fetchDialog.foot.querySelector("[data-fetch-submit]");
    submit.disabled = !picked.size || busy;
    submit.textContent = picked.size ? ui`加入 ${picked.size} 个模型` : ui("加入模型");
  };
  const openFetch = async () => {
    const provider = selected();
    if (!provider || managed()) return;
    listing = [];
    listingLoading = true;
    picked = new Set();
    filter = { text: "", kind: "all" };
    fetchDialog.title(ui`${provider.name} 的可用模型`);
    fetchDialog.body.innerHTML = `<p class="provider-dialog-lead" data-fetch-lead></p>
      <div class="fetch-toolbar"><label class="provider-search">${icon("search")}<input type="search" data-fetch-filter placeholder="${esc(ui("筛选"))}"></label>
      <div class="settings-segmented" role="radiogroup">${[
        ["all", ui("全部")],
        ["reasoning", ui("推理")],
        ["images", ui("视觉")]
      ]
        .map(
          ([id, label]) =>
            `<button type="button" role="radio" data-fetch-kind="${id}" aria-checked="${id === "all"}">${esc(label)}</button>`
        )
        .join("")}</div></div>
      <div class="fetch-list" data-fetch-list></div>`;
    fetchDialog.foot.innerHTML = `<small data-fetch-count></small><span class="settings-row-spacer"></span>
      <button type="button" class="app-button is-secondary" data-fetch-cancel>${ui("取消")}</button>
      <button type="button" class="app-button is-primary" data-fetch-submit disabled>${ui("加入模型")}</button>`;
    fetchDialog.open();
    renderFetch();
    try {
      listing = (await post("/api/model-settings/models/list", { id: provider.id })).models || [];
      fetchDialog.body.querySelector("[data-fetch-lead]").textContent = listing.length
        ? ui`从服务商获取到 ${listing.length} 个模型。勾选要加入的模型，已加入的会保留。`
        : ui("服务商没有返回模型。");
    } catch (error) {
      fetchDialog.body.querySelector("[data-fetch-lead]").textContent = errorMessage(error);
    }
    listingLoading = false;
    renderFetch();
  };
  fetchDialog.backdrop.addEventListener("input", (event) => {
    if (event.target.matches("[data-fetch-filter]")) {
      filter.text = event.target.value;
      renderFetch();
    }
  });
  fetchDialog.backdrop.addEventListener("change", (event) => {
    if (event.target.type !== "checkbox") return;
    if (event.target.checked) picked.add(event.target.value);
    else picked.delete(event.target.value);
    renderFetch();
  });
  fetchDialog.backdrop.addEventListener("click", async (event) => {
    const kind = event.target.closest("[data-fetch-kind]");
    if (kind) {
      filter.kind = kind.dataset.fetchKind;
      for (const button of fetchDialog.body.querySelectorAll("[data-fetch-kind]"))
        button.setAttribute("aria-checked", String(button === kind));
      renderFetch();
    }
    if (event.target.closest("[data-fetch-cancel]")) fetchDialog.close();
    if (!event.target.closest("[data-fetch-submit]") || !picked.size) return;
    const provider = selected();
    const models = listing
      .filter((model) => picked.has(model.id))
      .map((model) => ({
        id: model.id,
        ...(model.name ? { name: model.name } : {}),
        supportsImages: model.images === true,
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens
          ? {
              mainMaxTokens: Math.max(1, Math.min(model.maxTokens, 65536)),
              subagentMaxTokens: Math.max(1, Math.min(model.maxTokens, 65536))
            }
          : {}),
        ...(model.reasoning ? { supportsReasoningEffort: true } : {}),
        autoLimits: ["contextWindow", "maxTokens", "images"]
      }));
    const ok = await run(
      () => post("/api/model-settings/models", { providerId: provider.id, models }),
      ui`已加入 ${models.length} 个模型`
    );
    if (ok) fetchDialog.close();
  });

  /* Add one model by id. */
  const manualDialog = createDialog("is-manual", ui("手动添加模型"));
  const openManual = () => {
    manualDialog.body.innerHTML = `<label class="provider-field"><span class="provider-field-label">${ui("模型 ID")}</span>
      <span class="provider-input"><input data-manual-id required spellcheck="false" placeholder="${esc(ui("填写服务商提供的模型 ID"))}"></span></label>
      <label class="provider-field"><span class="provider-field-label">${ui("显示名称（可选）")}</span><span class="provider-input"><input data-manual-name maxlength="120"></span></label>`;
    manualDialog.foot.innerHTML = `<span class="provider-dialog-error" data-manual-error role="alert"></span><span class="settings-row-spacer"></span>
      <button type="button" class="app-button is-secondary" data-manual-cancel>${ui("取消")}</button>
      <button type="button" class="app-button is-primary" data-manual-submit>${ui("添加")}</button>`;
    manualDialog.open();
    manualDialog.body.querySelector("[data-manual-id]").focus();
  };
  manualDialog.backdrop.addEventListener("click", async (event) => {
    if (event.target.closest("[data-manual-cancel]")) manualDialog.close();
    if (!event.target.closest("[data-manual-submit]") || busy) return;
    const id = manualDialog.body.querySelector("[data-manual-id]").value.trim();
    const name = manualDialog.body.querySelector("[data-manual-name]").value.trim();
    const error = manualDialog.foot.querySelector("[data-manual-error]");
    error.textContent = "";
    busy = true;
    try {
      const next = await post("/api/model-settings/models", {
        providerId: selectedId,
        models: [{ id, ...(name ? { name } : {}) }]
      });
      // The panel re-renders from the answer, so it must no longer read as busy.
      busy = false;
      apply(next);
      manualDialog.close();
      onSaved?.();
    } catch (failure) {
      busy = false;
      error.textContent = errorMessage(failure);
    }
  });

  /* One model's limits and reasoning levels. */
  const modelDialog = createDialog("is-model", ui("模型参数"));
  let modelAuto = new Set();
  let modelLimits = {};
  let modelSource = "manual";
  const openModel = async (modelId) => {
    const provider = selected();
    const model = provider?.models.find((entry) => entry.id === modelId);
    if (!model) return;
    modelDialog.title(model.id);
    // A model saved without `autoLimits` follows the endpoint while a field still holds its default.
    modelAuto = new Set(
      model.autoLimits ?? [
        ...(model.contextWindow === 256000 ? ["contextWindow"] : []),
        ...(model.mainMaxTokens === 8192 && model.subagentMaxTokens === 8192 ? ["maxTokens"] : []),
        ...(model.supportsImages ? [] : ["images"])
      ]
    );
    modelLimits = {};
    modelSource = "manual";
    const chosen = model.reasoningLevels?.length ? model.reasoningLevels : LEVELS;
    modelDialog.body.innerHTML = `
      <p class="provider-dialog-lead">${ui("标「自动」的值来自服务商接口或内置目录；手动修改后以填写的为准。")}</p>
      ${[
        ["contextWindow", ui("上下文窗口（token）"), model.contextWindow, "contextWindow"],
        ["mainMaxTokens", ui("Main 每次输出上限"), model.mainMaxTokens, "maxTokens"],
        ["subagentMaxTokens", ui("子 Agent 每次输出上限"), model.subagentMaxTokens, "maxTokens"]
      ]
        .map(
          ([
            name,
            label,
            current,
            auto
          ]) => `<label class="provider-field is-inline"><span>${esc(label)}<small class="model-auto" data-auto-tag="${auto}" hidden>${ui("自动")}</small></span>
          <span class="provider-input is-number"><input type="number" min="1" step="1" data-model-field="${name}" data-auto="${auto}" value="${esc(current)}"></span></label>`
        )
        .join("")}
      <div class="provider-field"><span class="provider-field-label">${ui("推理档位")}<small class="model-auto" data-levels-source hidden></small></span>
        <div class="level-chips" data-level-chips>${LEVELS.map(
          (level) =>
            `<label class="level-chip"><input type="checkbox" value="${level}"${chosen.includes(level) ? " checked" : ""}><span>${esc(LEVEL_LABELS[level] || level)}</span></label>`
        ).join("")}</div></div>
      <label class="provider-field is-inline"><span>${ui("默认推理强度")}</span><select class="settings-select is-effort" data-model-field="reasoningEffort">${LEVELS.map(
        (level) =>
          `<option value="${level}"${level === model.reasoningEffort ? " selected" : ""}>${esc(LEVEL_LABELS[level] || level)}</option>`
      ).join("")}</select></label>
      <div class="provider-field is-inline"><span>${ui("服务支持推理强度参数")}<small>reasoning_effort / thinking</small></span><button type="button" class="ui-switch" role="switch" data-model-switch="supportsReasoningEffort" aria-checked="${model.supportsReasoningEffort === true}"></button></div>
      <div class="provider-field is-inline"><span>${ui("图片输入")}<small class="model-auto" data-auto-tag="images" hidden>${ui("自动")}</small></span><button type="button" class="ui-switch" role="switch" data-model-switch="supportsImages" data-auto="images" aria-checked="${model.supportsImages === true}"></button></div>`;
    modelDialog.foot.innerHTML = `<button type="button" class="settings-link" data-model-reset>${ui("恢复自动值")}</button><span class="provider-dialog-error" data-model-error role="alert"></span><span class="settings-row-spacer"></span>
      <button type="button" class="app-button is-secondary" data-model-cancel>${ui("取消")}</button>
      <button type="button" class="app-button is-primary" data-model-save>${ui("保存")}</button>`;
    modelDialog.open();
    showAuto();
    try {
      const result = await post("/api/model-settings/levels", { id: provider.id, model: model.id });
      modelLimits = result.limits || {};
      modelSource = result.source;
      if (result.source !== "manual")
        for (const box of modelDialog.body.querySelectorAll("[data-level-chips] input")) {
          box.checked = result.levels.includes(box.value);
          box.disabled = true;
        }
      const badge = modelDialog.body.querySelector("[data-levels-source]");
      badge.hidden = result.source === "manual";
      badge.textContent = result.source === "endpoint" ? ui("来自 /models 接口") : ui("官方 · 自动");
      showAuto();
    } catch (error) {
      console.warn("model level detection failed", error);
    }
  };
  /** Fields that still follow the endpoint show its value and an "auto" tag. */
  const showAuto = () => {
    const values = {
      contextWindow: modelLimits.contextWindow,
      maxTokens: modelLimits.maxOutputTokens && Math.min(modelLimits.maxOutputTokens, 65536),
      images: modelLimits.images
    };
    for (const input of modelDialog.body.querySelectorAll("[data-auto]")) {
      const field = input.dataset.auto;
      if (!modelAuto.has(field) || values[field] === undefined) continue;
      if (input.matches("[role=switch]")) input.setAttribute("aria-checked", String(values[field] === true));
      else input.value = String(values[field]);
    }
    for (const tag of modelDialog.body.querySelectorAll("[data-auto-tag]"))
      tag.hidden = !(modelAuto.has(tag.dataset.autoTag) && values[tag.dataset.autoTag] !== undefined);
  };
  modelDialog.backdrop.addEventListener("input", (event) => {
    const field = event.target.dataset?.auto;
    if (field) {
      modelAuto.delete(field);
      showAuto();
    }
  });
  modelDialog.backdrop.addEventListener("change", (event) => {
    if (!event.target.closest("[data-level-chips]")) return;
    const boxes = [...modelDialog.body.querySelectorAll("[data-level-chips] input")];
    if (!boxes.some((box) => box.checked)) event.target.checked = true;
  });
  modelDialog.backdrop.addEventListener("click", async (event) => {
    const toggle = event.target.closest("[data-model-switch]");
    if (toggle) {
      toggle.setAttribute("aria-checked", String(toggle.getAttribute("aria-checked") !== "true"));
      if (toggle.dataset.auto) {
        modelAuto.delete(toggle.dataset.auto);
        showAuto();
      }
    }
    if (event.target.closest("[data-model-reset]")) {
      modelAuto = new Set(["contextWindow", "maxTokens", "images"]);
      showAuto();
    }
    if (event.target.closest("[data-model-cancel]")) modelDialog.close();
    if (!event.target.closest("[data-model-save]") || busy) return;
    const body = modelDialog.body;
    const number = (name) => Number(body.querySelector(`[data-model-field="${name}"]`).value);
    const levels = [...body.querySelectorAll("[data-level-chips] input")]
      .filter((box) => box.checked)
      .map((box) => box.value);
    const entry = {
      id: modelDialog.backdrop.querySelector(".provider-dialog-head h2").textContent,
      contextWindow: number("contextWindow"),
      mainMaxTokens: number("mainMaxTokens"),
      subagentMaxTokens: number("subagentMaxTokens"),
      reasoningEffort: body.querySelector('[data-model-field="reasoningEffort"]').value,
      reasoningLevels: modelSource !== "manual" || levels.length === LEVELS.length ? null : levels,
      supportsReasoningEffort:
        body.querySelector('[data-model-switch="supportsReasoningEffort"]').getAttribute("aria-checked") ===
        "true",
      supportsImages:
        body.querySelector('[data-model-switch="supportsImages"]').getAttribute("aria-checked") === "true",
      autoLimits: [...modelAuto]
    };
    const error = modelDialog.foot.querySelector("[data-model-error]");
    error.textContent = "";
    busy = true;
    try {
      const next = await post("/api/model-settings/models", { providerId: selectedId, models: [entry] });
      busy = false;
      apply(next);
      modelDialog.close();
      onSaved?.();
    } catch (failure) {
      busy = false;
      error.textContent = errorMessage(failure);
    }
  });

  /* ------------------------------------------------------------------ events */

  panel.addEventListener("click", (event) => {
    const target = event.target;
    const item = target.closest("[data-provider-id]");
    if (item) {
      selectedId = item.dataset.providerId;
      renderList();
      return renderDetail();
    }
    if (target.closest("[data-provider-add]")) return openAdd();
    const quick = target.closest("[data-preset]");
    if (quick) return openAdd(quick.dataset.preset);
    const provider = selected();
    if (!provider) return;
    if (target.closest("[data-reveal]")) {
      const input = detail.querySelector('[data-field="apiKey"]');
      input.type = input.type === "password" ? "text" : "password";
      return;
    }
    const apiButton = target.closest("[data-api]");
    if (apiButton) {
      drafts().set(provider.id, { ...draftOf(provider), api: apiButton.dataset.api });
      return renderDetail();
    }
    const fieldSwitch = target.closest("[data-field-switch]");
    if (fieldSwitch) {
      const field = fieldSwitch.dataset.fieldSwitch;
      drafts().set(provider.id, { ...draftOf(provider), [field]: !(value(provider, field) === true) });
      return renderDetail();
    }
    if (target.closest("[data-provider-enabled]"))
      return void run(
        () => post("/api/model-settings/providers", { id: provider.id, enabled: !provider.enabled }),
        provider.enabled ? ui("已停用供应商") : ui("已启用供应商")
      );
    const remove = target.closest("[data-provider-delete]");
    if (remove) {
      if (remove.dataset.confirm !== "1") {
        remove.dataset.confirm = "1";
        remove.classList.add("is-confirming");
        remove.title = ui("再次点击确认删除");
        showToast(ui`再次点击删除「${provider.name}」，它的模型也会一并移除`);
        return;
      }
      return void run(
        () => post("/api/model-settings/providers/delete", { id: provider.id }),
        ui("供应商已删除")
      );
    }
    if (target.closest("[data-provider-discard]")) {
      drafts().delete(provider.id);
      return renderDetail();
    }
    if (target.closest("[data-provider-save]")) return void saveDraft(provider);
    if (target.closest("[data-provider-check]")) {
      const result = detail.querySelector("[data-check-result]");
      const model = provider.models[0]?.id;
      if (!model) {
        result.textContent = ui("先添加一个模型，再检查连接。");
        return;
      }
      result.textContent = ui`正在用 ${model} 检查连接与工具调用…（会消耗少量额度）`;
      void post("/api/model-settings/test", { id: provider.id, model, ...draftOf(provider) }).then(
        (answer) => {
          result.textContent = ui`连接通过 · 工具调用可用 · ${(answer.durationMs / 1000).toFixed(1)} 秒`;
        },
        (error) => {
          result.textContent = errorMessage(error);
        }
      );
      return;
    }
    if (target.closest("[data-models-fetch]")) return void openFetch();
    if (target.closest("[data-models-add]")) return openManual();
    const settings = target.closest("[data-model-settings]");
    if (settings) return void openModel(settings.dataset.modelSettings);
    const removeModel = target.closest("[data-model-remove]");
    if (removeModel)
      return void run(
        () =>
          post("/api/model-settings/models", {
            providerId: provider.id,
            remove: [removeModel.dataset.modelRemove]
          }),
        ui("模型已移除")
      );
  });
  panel.addEventListener("input", (event) => {
    if (event.target.matches("[data-provider-search]")) {
      query = event.target.value;
      return renderList();
    }
    const field = event.target.dataset?.field;
    const provider = selected();
    if (!field || !provider) return;
    const next = { ...draftOf(provider) };
    const raw = event.target.value;
    if (field === "apiKey" ? raw.trim() : raw !== provider[field]) next[field] = raw;
    else delete next[field];
    if (Object.keys(next).length) drafts().set(provider.id, next);
    else drafts().delete(provider.id);
    detail.querySelector(".provider-save").hidden = !dirty(provider);
    if (field === "baseUrl")
      detail.querySelector(".provider-preview").textContent = requestPreview(raw, value(provider, "api"))
        ? ui`请求地址：${requestPreview(raw, value(provider, "api"))}`
        : "";
  });
  panel.addEventListener("change", (event) => {
    const select = event.target.closest("select[data-field]");
    const provider = selected();
    if (select && provider) {
      drafts().set(provider.id, { ...draftOf(provider), [select.dataset.field]: select.value });
      detail.querySelector(".provider-save").hidden = false;
    }
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches("[data-field]") && selected() && dirty(selected())) {
      event.preventDefault();
      void saveDraft(selected());
    }
  });

  return {
    refresh,
    /** Show the panel ready for a first provider when nothing is configured. */
    openSetup: () => {
      void refresh().then(() => {
        if (!providers().length) openAdd();
      });
    }
  };
}
