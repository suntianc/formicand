import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { providerText, sessionContextFixture, withoutMainState } from "./fixtures/session-context-pi.mjs";

const evidence = () => ({
  big: "RESULT_HEAD\n" + "middle ".repeat(1450) + "ORIGINAL_ONLY" + " middle".repeat(1450) + "\nRESULT_TAIL",
  // About 4.5K tokens each: four of them clear the 16K a 64K window asks for.
  chunks: Array.from({ length: 9 }, (_, index) => `CHUNK_${index}_MARKER\n` + `sample-${index} `.repeat(2000))
});
const read = (path, usage) => ({ name: "read", arguments: { path }, usage });

test(
  "real Pi archives large tool results and clears older results in one worthwhile batch",
  { timeout: 60_000 },
  async (t) => {
    const { big, chunks } = evidence();
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
      if (step < 11) {
        // Past half the window, but the four results old enough to clear hold
        // less than half of that: they are left for a batch that repays the cache.
        if (step === 10) assert.match(providerText({ messages: visible }), /CHUNK_0_MARKER/);
        return read(`chunk-${step - 2}.txt`, step >= 9 ? 36000 : 1000);
      }
      // Without the state Main's runtime adds to the newest result.
      const text = withoutMainState(providerText({ messages: visible }));
      assert.match(text, /\[Old tool result content cleared\]/);
      assert.doesNotMatch(text, /read_history/, "the placeholder does not explain the tools");
      for (const index of [0, 1, 2, 3]) assert.ok(!text.includes(`CHUNK_${index}_MARKER`));
      for (const index of [4, 5, 6, 7, 8]) assert.ok(text.includes(`CHUNK_${index}_MARKER`));
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
      results.slice(0, 5).map((entry) => entry.id)
    );
    assert.match(results[1].message.content[0].text, /CHUNK_0_MARKER/);
    const [path] = results[0].message.content[0].text.match(/tool-results\/\S+\.json/);
    const original = JSON.parse(await readFile(join(fixture.sessions, path), "utf8"));
    assert.equal(original.content[0].text, big);
  }
);

test(
  "with the settings switch off, old results stay however large the context grows",
  { timeout: 60_000 },
  async (t) => {
    const { big, chunks } = evidence();
    const fixture = await sessionContextFixture(
      t,
      (body, step) => {
        if (step === 1) return read("big.txt");
        if (step < 12) return read(`chunk-${step - 2}.txt`, step >= 9 ? 36000 : 1000);
        assert.match(
          providerText({ messages: body.messages.filter((m) => m.role === "tool") }),
          /CHUNK_0_MARKER/
        );
        return { text: "Everything is still here." };
      },
      { config: { contextTrim: false } }
    );
    await writeFile(join(fixture.project, "big.txt"), big);
    for (const [index, chunk] of chunks.entries())
      await writeFile(join(fixture.project, `chunk-${index}.txt`), chunk);
    await fixture.launch("Inspect all the evidence files in order.");
    assert.equal((await fixture.history()).filter((entry) => entry.type === "context_edit").length, 0);
  }
);

test(
  "a 1M-token window starts clearing at 100K tokens, not at half the window",
  { timeout: 60_000 },
  async (t) => {
    // Each stays under the archive size, about 4.7K tokens: eleven clear the 50K that 100K asks for.
    const pad = (index) => String(index).padStart(2, "0");
    const chunks = Array.from(
      { length: 17 },
      (_, index) => `WIDE_${pad(index)}_MARKER\n` + `x${pad(index)} `.repeat(4700)
    );
    const fixture = await sessionContextFixture(
      t,
      (body, step) => {
        if (step <= 17) return read(`wide-${step - 1}.txt`, step === 17 ? 130000 : 1000);
        const text = providerText({ messages: body.messages.filter((message) => message.role === "tool") });
        assert.ok(!text.includes("WIDE_00_MARKER"), "the oldest result is cleared");
        for (const index of [12, 13, 14, 15, 16]) assert.ok(text.includes(`WIDE_${pad(index)}_MARKER`));
        return { text: "Cleared the oldest." };
      },
      { contextWindow: 1_000_000 }
    );
    for (const [index, chunk] of chunks.entries())
      await writeFile(join(fixture.project, `wide-${index}.txt`), chunk);
    await fixture.launch("Inspect all the wide files in order.");
    const edits = (await fixture.history()).filter((entry) => entry.type === "context_edit").length;
    assert.ok(edits >= 10 && edits <= 12, `one batch of about 50K tokens, not ${edits} results`);
  }
);
