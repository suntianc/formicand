import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteProvider } from "../dist/src/runtime/model-providers.js";
import { withFallbackModel } from "../dist/src/runtime/session-summary.js";
import { extractTitle } from "../dist/src/runtime/session-title.js";
import {
  parseUtilityModel,
  resolveUtilityModel,
  saveUtilityModel
} from "../dist/src/runtime/utility-model.js";
import { profileId, providerConfig } from "./model-provider-fixture.mjs";

const entry = {
  id: "cheap",
  baseUrl: "https://cheap.example.test/v1",
  model: "cheap-model",
  apiKey: "key-cheap"
};
const config = providerConfig([
  { id: "main", baseUrl: "https://main.example.test/v1", model: "main-model", apiKey: "key-main" },
  entry
]);

test("a reply's title loses its label, quotes, end punctuation and later lines", () => {
  assert.equal(extractTitle("标题：「修复登录跳转」。\n解释"), "修复登录跳转");
  assert.equal(extractTitle('<think>x</think>\n\n"Fix the login redirect."'), "Fix the login redirect");
  assert.equal(extractTitle("  \n "), undefined);
  assert.equal(extractTitle("长".repeat(80)).length, 60);
});

test("the utility model is a saved connection, and without one each session uses its own", () => {
  assert.equal(resolveUtilityModel(config), undefined);
  const saved = saveUtilityModel(config, { profileId: profileId(entry) });
  assert.deepEqual(saved.utilityModel, { profileId: "cheap#cheap-model" });
  const selection = resolveUtilityModel(saved);
  assert.equal(selection.baseUrl, entry.baseUrl);
  assert.equal(selection.model, "cheap-model");
  assert.equal(selection.apiKey, "key-cheap");
  assert.equal(saveUtilityModel(saved, { profileId: "" }).utilityModel, undefined);
  assert.throws(() => saveUtilityModel(config, { profileId: "gone#model" }), /模型不存在/);
  assert.throws(() => parseUtilityModel({ profileId: "x", extra: 1 }), /未知字段/);
});

test("a provider the utility model uses cannot be deleted", () => {
  const saved = saveUtilityModel(config, { profileId: profileId(entry) });
  assert.throws(() => deleteProvider(saved, { id: "cheap" }), /辅助模型/);
});

test("the session's model answers when the utility model fails, but not after an abort", async () => {
  const reply = (text) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
  const second = { contextWindow: 200_000, complete: async () => reply("second") };
  const failing = {
    contextWindow: 100_000,
    complete: async () => {
      throw new Error("down");
    }
  };
  const combined = withFallbackModel(failing, second);
  assert.equal(combined.contextWindow, 100_000);
  assert.equal((await combined.complete({}, new AbortController().signal)).content[0].text, "second");
  const empty = withFallbackModel({ contextWindow: 1, complete: async () => reply(" ") }, second);
  assert.equal((await empty.complete({}, new AbortController().signal)).content[0].text, "second");
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(() => combined.complete({}, aborted.signal), /down/);
  assert.equal(withFallbackModel(undefined, second), second);
});
