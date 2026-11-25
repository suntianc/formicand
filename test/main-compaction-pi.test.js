import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { HumanRequestStore } from "../dist/src/runtime/human.js";
import { DurableScheduler } from "../dist/src/runtime/scheduler.js";
import { FIXTURE_SUMMARY, providerText, sessionContextFixture } from "./fixtures/session-context-pi.mjs";

const settings = { enabled: true, reserveTokens: 8000, keepRecentTokens: 1 };
const tool = (name, args, usage) => ({ name, arguments: args, usage });
const lastTool = (body) =>
  providerText({ messages: [body.messages.findLast((message) => message.role === "tool")] });
const notice = "Context capacity: about ";
const handoff = "Context window handoff";

test(
  "real Pi warns once above 75%, switches at its threshold, and resumes with a recorded handoff",
  { timeout: 60_000 },
  async (t) => {
    const originalUser = "PRESERVE_VERBATIM: keep the public export name.";
    const notes = "Notebook: tests are pending.";
    const olderOutput = "OLDER_TOOL_ORIGINAL" + "x".repeat(10_000);
    let fixture, scheduler;
    fixture = await sessionContextFixture(
      t,
      async (body, step) => {
        assert.ok(body.tools.length, "only ordinary agent requests reach the provider");
        const visible = providerText(body);
        if (step === 1) return tool("read", { path: "older.txt" });
        if (step === 2) {
          assert.match(visible, /OLDER_TOOL_ORIGINAL/);
          return tool("session_notes", { action: "append", text: notes }, 49000);
        }
        if (step === 3) {
          assert.equal(visible.split(notice).length - 1, 1);
          const remaining = Number(/about (\d+) tokens remain/.exec(visible)?.[1]);
          assert.ok(remaining >= 14_000 && remaining <= 15_000);
          return tool("read", { path: "recent.txt" }, 51_000);
        }
        if (step === 4) {
          assert.equal(visible.split(notice).length - 1, 1);
          await new HumanRequestStore(fixture.workspace).create({
            taskId: fixture.taskId,
            runId: fixture.runId,
            question: "UNANSWERED: Which target should be kept?"
          });
          await scheduler.enqueue({
            stepId: "delegated-check",
            taskId: fixture.taskId,
            runId: fixture.runId,
            agentId: "reviewer",
            importance: "normal",
            payload: { task: "Check the fixture without edits." }
          });
          return tool("read", { path: "recent.txt" }, 57_000);
        }
        for (const marker of [
          handoff,
          originalUser,
          notes,
          "UNANSWERED:",
          "delegated-check",
          "Check the fixture without edits.",
          FIXTURE_SUMMARY,
          "search_history",
          "read_history"
        ]) {
          assert.ok(visible.includes(marker), marker);
        }
        assert.doesNotMatch(visible, /OLDER_TOOL_ORIGINAL/);
        assert.doesNotMatch(visible, /<analysis>/, "the summary's analysis is discarded");
        assert.ok(!visible.includes(notice));
        return { text: "Kept the original constraints." };
      },
      { compaction: settings }
    );
    scheduler = new DurableScheduler(
      join(fixture.workspace, fixture.taskId, "runs", fixture.runId, "queue.json")
    );
    await writeFile(join(fixture.project, "older.txt"), olderOutput);
    await writeFile(join(fixture.project, "recent.txt"), "Recent file evidence.");
    await fixture.launch(originalUser);
    const entries = await fixture.history();
    const windows = entries.filter((entry) => entry.type === "compaction");
    assert.equal(windows.length, 1);
    assert.equal(windows[0].details.reason, "threshold");
    assert.equal(windows[0].fromHook, true);
    assert.ok(windows[0].summary.length <= 60_000);
    // The model summarized the window it was leaving, from its conversation, without tools.
    assert.equal(fixture.summaries.length, 1);
    assert.equal(fixture.summaries[0].tools, undefined);
    assert.match(providerText(fixture.summaries[0]), /PRESERVE_VERBATIM/);
    assert.equal(entries.filter((entry) => entry.customType === "formicand-context-capacity").length, 1);
    assert.ok(entries.some((entry) => entry.message?.content?.some?.((block) => block.text === olderOutput)));
    await fixture.launch("Continue using the previous window.", { resume: true });
    assert.equal(fixture.requests.length, 6);
  }
);

for (const role of ["main", "executor"]) {
  test(
    `real ${role} Pi changes windows with clear_context and restores its notes`,
    { timeout: 60_000 },
    async (t) => {
      const goal = "Original handoff constraint: leave protected files alone.";
      const notes = "Session note for the current agent.";
      const fixture = await sessionContextFixture(t, (body, step) => {
        assert.ok(body.tools.length);
        if (step === 1) return tool("session_notes", { action: "rewrite", text: notes });
        if (step === 2) return tool("clear_context", { reason: "New phase" });
        assert.match(providerText(body), /Context window handoff/);
        assert.match(providerText(body), /Original handoff constraint/);
        assert.ok(providerText(body).includes(notes));
        if (step === 3) return tool("session_notes", { action: "read" });
        assert.match(lastTool(body), /Session note for the current agent/);
        return { text: "Continued in the new window." };
      });
      await fixture.launch(
        goal,
        role === "executor"
          ? {
              launchEnv: {
                FORMICAND_AGENT_ROLE: "executor",
                FORMICAND_AGENT_ID: "fixture-executor",
                FORMICAND_SUBAGENT_CALL_ID: "fixture-call",
                FORMICAND_SUBAGENT_TOKEN: "fixture-token",
                FORMICAND_SUBAGENT_RESULT: join(fixture.root, "result.json")
              }
            }
          : {}
      );
      const entries = await fixture.history();
      const window = entries.find((entry) => entry.type === "compaction");
      assert.equal(window.details.reason, "manual");
      assert.equal(fixture.requests.length, 4);
    }
  );
}

for (const hugeFirst of [true, false]) {
  test(
    `real Pi recovers a provider overflow ${hugeFirst ? "on a single oversized first turn" : "after tool activity"} without retaining raw tail`,
    { timeout: 60_000 },
    async (t) => {
      const marker = "OVERSIZED_ORIGINAL_TAIL";
      const original = hugeFirst
        ? "P".repeat(100_000) + marker
        : "Preserve this small user message verbatim.";
      let historyId;
      const fixture = await sessionContextFixture(
        t,
        (body, step) => {
          assert.ok(body.tools.length);
          const visible = providerText(body);
          const failAt = hugeFirst ? 1 : 2;
          if (step < failAt) return tool("read", { path: "large-receipt.txt" });
          if (step === failAt) {
            assert.ok(visible.includes(marker));
            return { error: { code: "context_length_exceeded", message: "maximum context length exceeded" } };
          }
          assert.match(visible, /Context window handoff/);
          if (step === failAt + 1) {
            assert.ok(!visible.includes(marker));
            assert.ok(visible.length < 30_000, "the retry fits the fixture's provider limit");
            if (hugeFirst)
              assert.match(visible, /User #1 \(entry [a-f0-9]+, \d+ characters\) is too long to show here/);
            else assert.ok(visible.includes(original));
            return tool("search_history", { query: marker, role: hugeFirst ? "user" : "toolResult" });
          }
          if (step === failAt + 2) {
            const [result] = JSON.parse(lastTool(body));
            historyId = result.id;
            return tool("read_history", {
              id: historyId,
              start: result.offset,
              end: result.offset + marker.length
            });
          }
          assert.equal(lastTool(body).split("\n").at(-1), marker);
          return { text: "Recovered the exact source after overflow." };
        },
        { compaction: settings }
      );
      await writeFile(join(fixture.project, "large-receipt.txt"), "b".repeat(12_000) + marker);
      await fixture.launch(original);
      const entries = await fixture.history();
      const window = entries.find((entry) => entry.type === "compaction");
      assert.equal(window.details.reason, "overflow");
      assert.equal(window.firstKeptEntryId, window.id, "emergency has no retained original tail");
      assert.ok(window.summary.length <= 6_000);
      assert.equal(fixture.summaries.length, 0, "an overflow handoff asks for no summary");
      assert.ok(entries.some((entry) => entry.id === historyId));
      assert.equal(fixture.requests.length, hugeFirst ? 4 : 5);
    }
  );
}
