import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAIN_MODEL_FROM_CONFIG,
  MAIN_TURN_MODEL,
  resolveMainTurnModel
} from "../dist/src/runtime/main-turn-model.js";
import { profileId, providerConfig } from "./model-provider-fixture.mjs";

/**
 * Which connection a resident Main's next turn should use.
 *
 * The launch copied a resolved connection into `FORMICAND_API_*`; these values
 * outrank the host file in ordinary role resolution. A turn boundary must read
 * the saved configuration instead, and must never do that for a connection the
 * environment pinned.
 */

const connection = (id, overrides = {}) => ({
  id: `ctx-${id}`,
  name: `连接 ${id.toUpperCase()}`,
  baseUrl: `https://${id}.example.test/v1`,
  model: `model-${id}`,
  api: "openai-completions",
  apiKey: `key-${id}`,
  supportsImages: false,
  supportsReasoningEffort: true,
  supportsPromptCacheKey: false,
  reasoningEffort: "low",
  mainMaxTokens: 8192,
  subagentMaxTokens: 8192,
  contextWindow: 256000,
  ...overrides
});
const a = connection("a");
const b = connection("b", { api: "openai-responses", model: "model-b", reasoningEffort: "max" });

const config = {
  ...providerConfig([a, b]),
  roleModels: {
    version: 1,
    host: { main: { profileId: profileId(b) } }
  }
};

const launch = {
  [MAIN_MODEL_FROM_CONFIG]: "1",
  FORMICAND_API_BASE: "https://launch.example/v1",
  FORMICAND_API_KEY: "launch-key",
  FORMICAND_MODEL: "launch-model"
};

test("an environment-pinned launch keeps the connection it was started with", () => {
  assert.equal(
    resolveMainTurnModel(config, {}, { FORMICAND_API_BASE: "https://launch.example/v1" }),
    undefined
  );
});

test("a Dashboard-resolved launch reads the saved connection, not the values copied into the environment", () => {
  const turn = resolveMainTurnModel(config, {}, launch);
  assert.equal(turn.baseUrl, "https://b.example.test/v1");
  assert.equal(turn.apiKey, "key-b");
  assert.equal(turn.model, "model-b");
  assert.equal(turn.profile.api, "openai-responses");
  assert.equal(turn.thinkingLevel, "max");
});

test("the host binding and the message's explicit level win for that turn", () => {
  const rebound = resolveMainTurnModel(
    { ...config, roleModels: { version: 1, host: { main: { profileId: profileId(a) } } } },
    {},
    launch
  );
  assert.equal(rebound.connectionId, "ctx-a");
  assert.equal(rebound.thinkingLevel, "low");
  assert.equal(resolveMainTurnModel(config, { thinkingLevel: "high" }, launch).thinkingLevel, "high");
});

test("a saved configuration with no usable connection leaves the running connection alone", () => {
  assert.equal(
    resolveMainTurnModel({ modelProviders: { version: 1, providers: [] } }, {}, launch),
    undefined
  );
});

test("the model a message picked outlasts the turn boundary on the same connection", () => {
  // Every turn start re-reads the saved connection; its default model must not
  // replace the one the person picked (after a 429 on the default, a Run
  // resumed on another model went straight back to it).
  const picked = { ...launch, FORMICAND_CONNECTION_ID: "ctx-b", [MAIN_TURN_MODEL]: "codex/picked" };
  const turn = resolveMainTurnModel(config, {}, picked);
  assert.equal(turn.connectionId, "ctx-b");
  assert.equal(turn.model, "codex/picked");
  // Another connection saved since the launch starts from its own default.
  const moved = resolveMainTurnModel(config, {}, { ...picked, FORMICAND_CONNECTION_ID: "ctx-a" });
  assert.equal(moved.model, "model-b");
});
