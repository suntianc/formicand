import { icon } from "../ui/icons.js";
import { presetById } from "../model-provider-presets.js";

export const API_LABELS = {
  "openai-completions": "Chat Completions",
  "openai-responses": "Responses",
  "anthropic-messages": "Anthropic Messages"
};
const API_PATHS = {
  "openai-completions": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/v1/messages"
};

/** The URL requests go to, as the backend builds it (`requestBaseUrl`). */
export function requestPreview(baseUrl, api) {
  const base = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) return "";
  if (!URL.canParse(base)) return "";
  const path = new URL(base).pathname;
  const root = api === "anthropic-messages" || (path !== "/" && path !== "") ? base : `${base}/v1`;
  return `${root}${API_PATHS[api] || API_PATHS["openai-completions"]}`;
}

/** Model families a custom provider's model ids are recognized by. */
const MODEL_FAMILIES = [
  [/^(gpt|o\d|chatgpt|codex)/i, "openai"],
  [/deepseek/i, "deepseek"],
  [/claude/i, "anthropic"],
  [/gemini|gemma/i, "gemini"],
  [/^(glm|chatglm)/i, "zhipu"],
  [/kimi|moonshot/i, "moonshot"],
  [/qwen|qwq/i, "bailian"],
  [/grok/i, "xai"],
  [/mistral|mixtral|codestral|devstral/i, "mistral"],
  [/minimax|abab/i, "minimax"],
  [/hunyuan/i, "hunyuan"],
  [/doubao|seed-/i, "volcengine"],
  [/ernie/i, "qianfan"],
  [/mimo/i, "xiaomimimo"]
];

/** The preset whose logo a model id belongs to, e.g. `gpt-5` or `openai/gpt-5` → openai. */
export function modelFamily(model) {
  const id = String(model || "").trim();
  if (!id) return undefined;
  const name = id.split("/").pop();
  const match = MODEL_FAMILIES.find(([pattern]) => pattern.test(name) || pattern.test(id));
  return match ? presetById(match[1]) : undefined;
}

/**
 * A provider's mark: its preset logo. A custom provider has none, so the mark
 * follows the model it serves (a gpt model shows OpenAI's), and a model of no
 * known family shows a plain chip mark.
 */
export function providerLogo(provider, size = 28, model) {
  const preset = presetById(provider?.preset) || modelFamily(model);
  const style = `--logo-size:${size}px`;
  if (!preset)
    return `<span class="provider-logo is-generic" data-logo="generic" style="${style}" aria-hidden="true">${icon("cpu")}</span>`;
  const url = `/assets/brand/providers/${preset.logo ?? preset.id}.svg`;
  return preset.mono
    ? `<span class="provider-logo" data-logo="${preset.id}" style="${style}" aria-hidden="true"><span class="provider-logo-mono" style="--logo:url('${url}')"></span></span>`
    : `<span class="provider-logo" data-logo="${preset.id}" style="${style}" aria-hidden="true"><img src="${url}" alt=""></span>`;
}
