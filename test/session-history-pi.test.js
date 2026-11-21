import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { providerText, sessionContextFixture } from "./fixtures/session-context-pi.mjs";

function lastToolText(body) {
  return providerText({ messages: [body.messages.filter((message) => message.role === "tool").at(-1)] });
}

test(
  "real Pi reads original archived and edited results and retains notes after a pause and restart",
  { timeout: 60_000 },
  async (t) => {
    const marker = "Source[42].中文";
    const prefix = "x".repeat(11_000);
    const original = prefix + marker + "y".repeat(11_000);
    const edited = "CLEARED_RECEIPT_MARKER";
    let fixture, archivedId, clearedId, archivePath;
    const call = (name, args, usage) => ({ name, arguments: args, usage });
    fixture = await sessionContextFixture(t, async (body, step) => {
      assert.ok(body.tools.length);
      if (step === 1) return call("session_notes", { action: "rewrite", text: "Obsolete note" });
      if (step === 2)
        return call("session_notes", { action: "rewrite", text: "Keep exact fixture constraints." });
      if (step === 3) return call("session_notes", { action: "append", text: "暂停后保留这行。" });
      if (step === 4) return call("read", { path: "long.txt" });
      if (step === 5)
        archivePath = /Full output saved to: (tool-results\/\S+\.json)/.exec(providerText(body))?.[1];
      if (step < 12) return call("read", { path: `receipt-${step}.txt` }, step === 11 ? 36000 : 1000);
      if (step === 12) {
        assert.doesNotMatch(providerText(body), /CLEARED_RECEIPT_MARKER/);
        assert.match(providerText(body), /\[Old tool result content cleared\]/);
        await fixture.store.updateTask(fixture.taskId, {
          pause: { requestedAt: new Date().toISOString(), requestedBy: "user" }
        });
        return { text: "Paused after saving notes." };
      }
      if (step === 13) return call("session_notes", { action: "read" });
      if (step === 14) {
        assert.match(lastToolText(body), /Keep exact fixture constraints\.\n暂停后保留这行。/);
        assert.doesNotMatch(lastToolText(body), /Obsolete note/);
        return call("search_history", { query: marker.toLowerCase(), role: "toolResult", tool: "read" });
      }
      if (step === 15) {
        const [match] = JSON.parse(lastToolText(body));
        assert.equal(match.offset, prefix.length);
        assert.match(match.snippet, /Source\[42\]\.中文/);
        archivedId = match.id;
        return call("read_history", {
          id: archivedId,
          start: prefix.length,
          end: prefix.length + marker.length
        });
      }
      if (step === 16) {
        assert.equal(lastToolText(body).split("\n").at(-1), marker);
        return call("search_history", { query: edited, role: "toolResult", tool: "read" });
      }
      if (step === 17) {
        const [match] = JSON.parse(lastToolText(body));
        assert.notEqual(match.id, archivedId);
        clearedId = match.id;
        return call("read_history", { id: clearedId, start: 0, end: edited.length });
      }
      if (step === 18) {
        assert.equal(lastToolText(body).split("\n").at(-1), edited);
        return call("search_history", { query: "earlier instruction", role: "user" });
      }
      if (step === 19) {
        const [match] = JSON.parse(lastToolText(body));
        assert.equal(match.role, "user");
        assert.match(match.snippet, /Earlier instruction/);
        assert.ok(archivePath);
        return call("read_history", {
          id: archivePath,
          start: prefix.length,
          end: prefix.length + marker.length
        });
      }
      assert.equal(lastToolText(body).split("\n").at(-1), marker);
      return { text: "Restored notes and read both original receipts." };
    });
    await writeFile(join(fixture.project, "long.txt"), original);
    for (let i = 5; i < 12; i++)
      await writeFile(
        join(fixture.project, `receipt-${i}.txt`),
        (i === 5 ? edited : "") + `chunk-${i} `.repeat(2000)
      );
    await fixture.store.transitionTask(fixture.taskId, "running", { runId: fixture.runId });
    await fixture.launch("Earlier instruction: preserve the original receipts.");
    const paused = await fixture.store.readTask(fixture.taskId);
    assert.equal(paused.status, "paused");
    assert.ok(paused.pause.pausedAt);
    await fixture.store.updateTask(fixture.taskId, { pause: undefined });
    await fixture.store.transitionTask(fixture.taskId, "running", { runId: fixture.runId });
    await fixture.launch("Continue after pause.", { resume: true });
    const entries = await fixture.history();
    assert.ok(entries.some((entry) => entry.type === "context_edit" && entry.targetId === clearedId));
    assert.equal(fixture.requests.length, 20);
  }
);
