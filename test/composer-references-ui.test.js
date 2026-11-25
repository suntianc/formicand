import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { escapeHtml as esc } from "../web/assets/ui/html.js";
import {
  agentIcon,
  fileTypeIcon,
  referenceIcon,
  resourceIcon,
  skillIcon
} from "../web/assets/ui/reference-icons.js";
import {
  findReferenceSpans,
  markReferences,
  referenceLabel,
  referenceTitle,
  renderReferenceChip,
  splitReferences
} from "../web/assets/references.js";
import { serializeRichNode } from "../web/assets/controllers/composer-rich.js";
import { conversationTitle, taskGoalText } from "../web/assets/controllers/work-title.js";

test("handcrafted file-type icons map extensions and dotfiles to bespoke badges with unique masks", () => {
  const jsA = fileTypeIcon("src/agents.mjs");
  const jsB = fileTypeIcon("web/app.js");
  assert.match(jsA, />JS<\/text>/);
  assert.match(jsB, />JS<\/text>/);
  const maskA = /id="(ref-icon-m\d+)"/.exec(jsA)?.[1];
  const maskB = /id="(ref-icon-m\d+)"/.exec(jsB)?.[1];
  assert.ok(maskA && maskB && maskA !== maskB, "each badge gets an isolated mask id");

  assert.match(fileTypeIcon("src/index.ts"), />TS<\/text>/);
  assert.match(fileTypeIcon("migrations/0007.sql"), />SQL<\/text>/);
  assert.match(fileTypeIcon("scripts/run.py"), />PY<\/text>/);
  assert.match(fileTypeIcon("package.json"), /ref-icon-json/);
  assert.match(fileTypeIcon("README.md"), /ref-icon-markdown/);
  assert.match(fileTypeIcon("scripts/install.sh"), /ref-icon-shell/);
  assert.match(fileTypeIcon("web/index.html"), /ref-icon-html/);
  assert.match(fileTypeIcon(".env.local"), /ref-icon-env/);
  assert.match(fileTypeIcon(".gitignore"), /ref-icon-git/);
  assert.match(fileTypeIcon("Dockerfile"), /ref-icon-container/);
  assert.match(fileTypeIcon("assets/hero.png"), /ref-icon-image/);
  assert.match(fileTypeIcon("src/"), /ref-icon-folder/);
  assert.match(fileTypeIcon("notes.unknownext"), /ref-icon-file/);

  assert.match(skillIcon(), /ref-icon-skill/);
  assert.match(agentIcon(), /ref-icon-agent/);
  assert.match(resourceIcon(), /ref-icon-resource/);
  assert.match(referenceIcon({ kind: "skill", name: "tidy-docs" }), /ref-icon-skill/);
  assert.match(referenceIcon({ kind: "file", path: "agents.mjs" }), />JS<\/text>/);
});

test("reference labels strip raw prefixes and paths while preserving full tooltips and canonical tokens", () => {
  const refs = [
    { kind: "skill", name: "tidy-docs" },
    { kind: "file", path: "src/runtime/agents.mjs" },
    { kind: "agent", name: "reviewer" },
    { kind: "mcp_resource", server: "postgres", uri: "schema://public/tasks" }
  ];
  const resourceNames = new Map([["postgres:schema://public/tasks", "public.tasks"]]);

  assert.equal(referenceLabel(refs[0]), "tidy-docs");
  assert.equal(referenceTitle(refs[0]), "/tidy-docs");
  assert.equal(referenceLabel(refs[1]), "agents.mjs");
  assert.equal(referenceTitle(refs[1]), "src/runtime/agents.mjs");
  assert.equal(referenceLabel(refs[2]), "reviewer");
  assert.equal(referenceTitle(refs[2]), "@reviewer");
  assert.equal(referenceLabel(refs[3], { resourceNames }), "public.tasks");
  assert.equal(referenceLabel(refs[3]), "public/tasks");
  assert.equal(referenceTitle(refs[3]), "postgres:schema://public/tasks");

  const text = "/tidy-docs 整理 @src/runtime/agents.mjs 交给 @reviewer 对照 @postgres:schema://public/tasks";
  const spans = findReferenceSpans(text, refs);
  assert.deepEqual(
    spans.map((s) => s.token),
    ["/tidy-docs", "@src/runtime/agents.mjs", "@reviewer", "@postgres:schema://public/tasks"]
  );

  const html = markReferences(text, refs, esc, { editable: true, resourceNames });
  assert.match(html, /contenteditable="false"/);
  assert.match(html, /data-ref-token="\/tidy-docs"/);
  assert.match(html, /class="reference-chip-label">agents\.mjs</);
  assert.match(html, /class="reference-chip-label">public\.tasks</);
});

test("serializeRichNode restores canonical reference tokens, normalizes NBSP and ignores trailing sentinel br", () => {
  const { document } = parseHTML("<html><body><div id='r'></div></body></html>");
  const root = document.getElementById("r");
  const skillChip = renderReferenceChip({ kind: "skill", name: "tidy-docs" }, esc, { editable: true });
  const fileChip = renderReferenceChip({ kind: "file", path: "src/agents.mjs" }, esc, { editable: true });
  root.innerHTML = `${skillChip}\u00a0${fileChip}\u00a0整理<br>第二行<br><br data-sentinel="true">`;

  assert.equal(serializeRichNode(root), "/tidy-docs @src/agents.mjs 整理\n第二行\n");
});

test("conversationTitle and taskGoalText hide a leading references manifest", () => {
  const manifest = `<formicand_references>\n${JSON.stringify({
    version: 1,
    note: "manifest",
    references: [{ kind: "skill", name: "tidy-docs" }]
  })}\n</formicand_references>`;
  assert.equal(
    conversationTitle({ taskId: "task-1", goal: `${manifest}\n\n/tidy-docs 整理文档\n第二行` }),
    "/tidy-docs 整理文档"
  );
  assert.equal(taskGoalText(`${manifest}\n\n/tidy-docs 整理文档`), "/tidy-docs 整理文档");
  assert.equal(splitReferences(manifest).text, "");
  assert.equal(conversationTitle({ taskId: "task-1", goal: manifest }), "task-1");
});
