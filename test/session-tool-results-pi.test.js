import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { providerText, sessionContextFixture } from "./fixtures/session-context-pi.mjs";

test(
  "real Pi archives large tool results and clears older results in one worthwhile batch",
  { timeout: 60_000 },
  async (t) => {
    const big =
      "RESULT_HEAD\n" + "middle ".repeat(1450) + "ORIGINAL_ONLY" + " middle".repeat(1450) + "\nRESULT_TAIL";
    const chunks = Array.from(
      { length: 7 },
      (_, index) => `CHUNK_${index}_MARKER\n` + `sample-${index} `.repeat(1800)
    );
    const read = (path, usage) => ({ name: "read", arguments: { path }, usage });
    const fixture = await sessionContextFixture(t, (body, step) => {
      assert.ok(body.tools.length);
      const visible = body.messages.filter((message) => message.role === "tool");
      if (step === 1) return read("big.txt");
      if (step === 2) {
        const preview = providerText({ messages: visible });
        for (const marker of ["RESULT_HEAD", "RESULT_TAIL", "tool-results/"])
          assert.ok(preview.includes(marker));
        assert.ok(!preview.includes("ORIGINAL_ONLY"));
      }
      if (step < 9) {
        // The first eligible batch saves under 10%, so it is left intact.
        if (step === 8) assert.match(providerText({ messages: visible }), /CHUNK_0_MARKER/);
        return read(`chunk-${step - 2}.txt`, step >= 8 ? 36000 : 1000);
      }
      const text = providerText({ messages: visible });
      assert.match(text, /result call_2 cleared.*read_history/);
      assert.ok(!text.includes("CHUNK_0_MARKER"));
      assert.ok(!text.includes("CHUNK_1_MARKER"));
      for (const index of [2, 3, 4, 5, 6]) assert.ok(text.includes(`CHUNK_${index}_MARKER`));
      assert.ok(body.messages.some((message) => message.tool_calls?.some((call) => call.id === "call_2")));
      return { text: "Results retained in the transcript." };
    });
    await writeFile(join(fixture.project, "big.txt"), big);
    for (const [index, chunk] of chunks.entries())
      await writeFile(join(fixture.project, `chunk-${index}.txt`), chunk);
    await fixture.launch("Inspect all the evidence files in order.");
    const entries = await fixture.history();
    const results = entries.filter((entry) => entry.message?.role === "toolResult");
    const edits = entries.filter((entry) => entry.type === "context_edit");
    assert.deepEqual(
      edits.map((entry) => entry.targetId),
      results.slice(0, 3).map((entry) => entry.id)
    );
    assert.match(results[1].message.content[0].text, /CHUNK_0_MARKER/);
    const [path] = results[0].message.content[0].text.match(/tool-results\/[^\]]+/);
    const original = JSON.parse(await readFile(join(fixture.sessions, path), "utf8"));
    assert.equal(original.content[0].text, big);
  }
);
