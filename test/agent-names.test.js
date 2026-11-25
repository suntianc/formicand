import assert from "node:assert/strict";
import { test } from "node:test";
import { agentAvatar, agentDisplayName } from "../web/assets/agent-names.js";

test("a genus always wears the same ant and Main keeps the brand mark", () => {
  const file = (agentId) => /ant-(\d+)-light\.webp/.exec(agentAvatar(agentId))?.[1];
  assert.equal(file("subagent_1"), "01");
  assert.equal(file("subagent_32"), "32");
  assert.equal(file("subagent_33"), "01");
  assert.equal(agentDisplayName("subagent_73"), "Atta A");
  assert.equal(file("subagent_73"), file("subagent_1"));
  assert.match(agentAvatar("main"), /i-formicand-mark-small/);
  assert.equal(agentAvatar(""), "");
});
