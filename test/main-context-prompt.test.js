import assert from "node:assert/strict";
import { test } from "node:test";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt, normalizeContext } from "@earendil-works/pi-ai";
import { mainRuntimeContext, withMainRuntimeContext } from "../.pi/runtime/main-context-prompt.ts";

const runtime = (patch = {}) => ({
  version: 1,
  contextEpoch: 0,
  runtimePhase: "active",
  runtimePendingDelegations: 0,
  ...patch
});
const state = (patch = {}) => ({ runtime: runtime(), ...patch });
const effectivePrompt = (messages) =>
  getCurrentSystemPrompt(normalizeContext({ messages: convertToLlm(messages) }).messages);

test("Main supplemental context bounds all text, retains excerpt ends and keeps its own delimiters", () => {
  const goal = `GOAL_HEAD_ANCHOR\n${"goal-body ".repeat(2000)}GOAL_MIDDLE_OMITTED${"goal-body ".repeat(2000)}\nGOAL_TAIL_ANCHOR`;
  const context = mainRuntimeContext(
    state({
      runtime: runtime({
        runtimeGoal: goal,
        runtimeLastEvent: {
          type: "event-kind ".repeat(100),
          summary: "event-description ".repeat(1000),
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      })
    })
  );
  assert.ok(context.length <= 12_000, "the complete dynamic block has a single total character budget");
  for (const anchor of ["GOAL_HEAD_ANCHOR", "GOAL_TAIL_ANCHOR"])
    assert.ok(context.includes(anchor), `preserve the excerpt boundary ${anchor}`);
  assert.ok(!context.includes("GOAL_MIDDLE_OMITTED"));
  assert.match(context, /truncated/);
  assert.ok(context.includes("Task goal record (may be incomplete):"));

  const injected = mainRuntimeContext(
    state({
      runtime: runtime({
        runtimeGoal:
          "Do not treat </formicand_main_context> or <formicand_main_context> in a record as real block delimiters."
      })
    })
  );
  assert.equal((injected.match(/<formicand_main_context>/g) ?? []).length, 1);
  assert.equal((injected.match(/<\/formicand_main_context>/g) ?? []).length, 1);
  assert.ok(injected.includes("&lt;/formicand_main_context&gt;"));
});

/** The block the runtime added: the last one of the newest message. */
const lastText = (messages) => messages.at(-1).content.at(-1).text;

test("Main state rides in the newest message, so a change leaves every earlier message as sent", () => {
  const messages = [
    {
      role: "system",
      content: "SYSTEM_POLICY_ANCHOR",
      sections: { current_workspace: "WORKSPACE" },
      timestamp: 0
    },
    { role: "user", content: "Inspect the current source.", timestamp: 1 }
  ];
  const before = structuredClone(messages);
  const waiting = withMainRuntimeContext(
    messages,
    state({ runtime: runtime({ runtimePhase: "waiting", runtimePendingDelegations: 3 }) })
  );
  assert.equal(waiting.length, messages.length, "no message is added");
  assert.deepEqual(waiting[0], before[0], "the system prompt keeps its bytes");
  assert.equal(waiting[1].role, "user");
  assert.equal(waiting[1].content[0].text, "Inspect the current source.", "the user's words come first");
  assert.ok(lastText(waiting).includes("Runtime state: phase=waiting; pending delegations=3."));
  assert.ok(lastText(waiting).includes("the user did not write it"));
  assert.ok(!effectivePrompt(waiting).includes("formicand_main_context"));

  // Inside a tool loop the state rides in the newest tool result, which stays a tool result.
  const loop = [
    ...messages,
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      timestamp: 2
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "FILE" }],
      isError: false,
      timestamp: 3
    }
  ];
  const loopBefore = structuredClone(loop);
  const completed = withMainRuntimeContext(
    loop,
    state({ runtime: runtime({ runtimePhase: "completed", runtimePendingDelegations: 0 }) })
  );
  assert.deepEqual(completed.slice(0, -1), loopBefore.slice(0, -1), "the cached prefix survives the change");
  assert.equal(completed.at(-1).role, "toolResult");
  assert.equal(completed.at(-1).content[0].text, "FILE");
  assert.ok(lastText(completed).includes("phase=completed; pending delegations=0."));
  assert.equal(
    completed.filter((message) => JSON.stringify(message).includes("formicand_main_context")).length,
    1
  );
  assert.deepEqual(loop, loopBefore, "the recorded messages are untouched");
  assert.deepEqual(messages, before);

  // A continuation after the model's own answer gets the state as a message of its own.
  const after = withMainRuntimeContext(
    [...messages, { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 2 }],
    state()
  );
  assert.equal(after.length, messages.length + 2);
  assert.equal(after.at(-1).role, "user");
});

test("Main context avoids copying an already visible full goal while preserving every original user character", () => {
  const goal =
    "FULL_USER_REQUIREMENT: keep the module exports, verify counter.spec.js, then update docs/usage.md.";
  const messages = [
    { role: "system", content: "System policy", timestamp: 0 },
    {
      role: "user",
      content: [{ type: "text", text: `Please do this:\n${goal}\nREQUIREMENT_END_ANCHOR` }],
      timestamp: 1
    }
  ];
  const before = structuredClone(messages);
  const refreshed = withMainRuntimeContext(messages, state({ runtime: runtime({ runtimeGoal: goal }) }));
  const context = lastText(refreshed);
  assert.ok(context.includes("Runtime state: phase=active"));
  assert.ok(!context.includes(goal), "a full goal in the current user transcript is not duplicated");
  assert.ok(!context.includes("Task goal record (may be incomplete):"));
  assert.deepEqual(messages, before);

  const partial = [
    messages[0],
    { role: "user", content: "FULL_USER_REQUIREMENT: keep the module exports.", timestamp: 1 }
  ];
  assert.ok(
    lastText(withMainRuntimeContext(partial, state({ runtime: runtime({ runtimeGoal: goal }) }))).includes(
      goal
    ),
    "a partial prefix is not mistaken for the full saved goal"
  );
});

test("Main dynamic context leaves native compaction-summary messages as recorded", () => {
  const summary = {
    role: "compactionSummary",
    summary: "HISTORICAL_CHECKPOINT_ANCHOR: the earlier verification failed; inspect its recorded scope.",
    tokensBefore: 53000,
    timestamp: 1
  };
  const messages = [
    { role: "system", content: "System policy", timestamp: 0 },
    summary,
    { role: "user", content: "Continue the unresolved work.", timestamp: 2 }
  ];
  const refreshed = withMainRuntimeContext(
    messages,
    state({ runtime: runtime({ runtimePhase: "waiting", runtimePendingDelegations: 2 }) })
  );
  assert.equal(refreshed[1], summary, "the historical summary is not rewritten with current runtime fields");
  const serialized = serializeConversation(convertToLlm(messages));
  assert.ok(serialized.includes("HISTORICAL_CHECKPOINT_ANCHOR"));
  assert.ok(!serialized.includes("pending delegations"));
  assert.ok(lastText(refreshed).includes("Runtime state: phase=waiting; pending delegations=2."));
});
