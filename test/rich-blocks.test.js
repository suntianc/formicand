import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { renderMarkdown } from "../web/assets/markdown.js";
import {
  ansiToHtml,
  fileReference,
  linkedFileReference,
  parseDiffText,
  renderDiffSplit,
  sourceKey,
  stripAnsi
} from "../web/assets/rich-blocks.js";

const dom = (html) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;

test("file references name a path with a known extension and an optional line", () => {
  assert.deepEqual(fileReference("useChangeStages.ts:222"), { path: "useChangeStages.ts", line: 222 });
  assert.deepEqual(fileReference("web/app.js"), { path: "web/app.js", line: undefined });
  assert.deepEqual(fileReference("useChangeStages.ts (line 222)"), { path: "useChangeStages.ts", line: 222 });
  assert.deepEqual(fileReference("stages.json"), { path: "stages.json", line: undefined });
  for (const text of ["console.log", "npm test", "obj.method", "v1.2", "x = 1", "foo()"])
    assert.equal(fileReference(text), undefined, text);
  assert.deepEqual(linkedFileReference("/repo/web/app.js#L12"), { path: "/repo/web/app.js", line: 12 });
  assert.equal(linkedFileReference("/repo/README"), undefined);
});

test("inline file references become chips; only resolvable ones are buttons", () => {
  const html = renderMarkdown("改在 `web/app.js:12` 和 `stages.json`，调用 `console.log`。", {
    resolveFile: (path) => path === "web/app.js"
  });
  const document = dom(html);
  const button = document.querySelector("button.file-chip");
  assert.equal(button.dataset.fileRef, "web/app.js");
  assert.equal(button.dataset.fileLine, "12");
  assert.equal(button.querySelector(".file-chip-line").textContent, ":12");
  assert.equal(document.querySelector("span.file-chip .file-chip-name").textContent, "stages.json");
  assert.equal(document.querySelector("code").textContent, "console.log");
  // An unresolved local link reads as a file, not as raw Markdown.
  const link = dom(renderMarkdown("见 [app.js](/repo/web/app.js#L3)"));
  assert.equal(link.querySelector(".file-chip").title, "/repo/web/app.js:3");
  assert.ok(!link.body.textContent.includes("]("));
});

test("a unified diff without git headers still numbers its lines", () => {
  const diff = parseDiffText("@@ -218,3 +218,2 @@\n ctx\n-old one\n-old two\n+new\n", "web/a.ts");
  assert.equal(diff.path, "web/a.ts");
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 2);
  assert.deepEqual(
    diff.rows.map((row) => [row.kind, row.oldNumber, row.newNumber]),
    [
      ["hunk", undefined, undefined],
      ["context", 218, 218],
      ["remove", 219, undefined],
      ["remove", 220, undefined],
      ["add", undefined, 219]
    ]
  );
  assert.equal(parseDiffText("--- a/x.ts\n+++ b/y.ts\n-a\n+b").path, "y.ts");
  const document = dom(renderMarkdown("```diff\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n```"));
  const block = document.querySelector(".diff-block");
  assert.equal(block.dataset.diffView, "inline");
  assert.equal(block.querySelector(".diff-path").textContent, "x.ts");
  assert.equal(block.querySelector(".diff-count.is-add").textContent, "+1");
  assert.ok(block.querySelector(".diff-split").hasAttribute("hidden"));
  assert.equal(
    block.querySelectorAll(".diff-split .diff-pair").length,
    0,
    "split view stays empty until requested"
  );
  const splitDom = dom(renderDiffSplit(block.querySelector(".diff-inline code").dataset.copyText));
  assert.equal(splitDom.querySelectorAll(".diff-pair").length, 2, "hunk row and one paired change");
});

test("terminal output keeps colours, drops other escapes and folds long output", () => {
  assert.equal(
    ansiToHtml("\u001b[32m✔ ok\u001b[0m \u001b[1;31mfail\u001b[0m\u001b[2K"),
    '<span class="ansi-green">✔ ok</span> <span class="ansi-red ansi-bold">fail</span>'
  );
  assert.equal(stripAnsi("\u001b[32mok\u001b[0m"), "ok");
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
  const document = dom(renderMarkdown(`\`\`\`terminal npm test exit=1\n${lines}\n\`\`\``));
  const block = document.querySelector(".terminal-block");
  assert.equal(block.querySelector(".terminal-command").textContent, "npm test");
  assert.equal(block.querySelector(".terminal-exit").textContent, "退出码 1");
  assert.ok(block.querySelector(".terminal-exit").classList.contains("is-failed"));
  assert.equal(block.querySelectorAll(":scope pre > code > .terminal-line").length, 12);
  assert.equal(block.querySelectorAll("[data-terminal-rest] .terminal-line").length, 8);
  assert.equal(block.querySelector("[data-terminal-more]").textContent, "展开其余 8 行");
  assert.equal(block.querySelector("[data-copy-text]"), null, "terminal output does not duplicate text");
  assert.equal(
    [...block.querySelectorAll(".terminal-line")].map((line) => line.textContent).join("\n"),
    lines
  );
  // ANSI in an ordinary fence is still terminal output.
  assert.ok(dom(renderMarkdown("```\n\u001b[31mred\u001b[0m\n```")).querySelector(".terminal-block"));
});

test("tables, task lists, callouts and diagrams render as their own blocks", () => {
  const document = dom(
    renderMarkdown(
      [
        "| 阶段 | 来源 |",
        "|---|---|",
        "| 开发 | 记录 |",
        "| 审查 | 状态 |",
        "",
        "- [x] 推导阶段",
        "- [ ] 补测试",
        "",
        "> [!WARNING]",
        "> 格式变了，**需要**升级。",
        "",
        "> 普通引用",
        "> 第二行",
        "",
        "```mermaid",
        "graph LR; A-->B",
        "```"
      ].join("\n")
    )
  );
  assert.equal(document.querySelector(".table-block .code-block-language").textContent, "2 行 × 2 列");
  assert.equal(document.querySelectorAll(".table-block tbody tr").length, 2);
  const tasks = document.querySelectorAll(".task-list .task-item input");
  assert.deepEqual(
    [...tasks].map((box) => box.hasAttribute("checked")),
    [true, false]
  );
  const warning = document.querySelector(".callout.is-warning");
  assert.equal(warning.querySelector(".callout-title").textContent, "警告");
  assert.equal(warning.querySelector("strong").textContent, "需要");
  assert.equal(document.querySelectorAll("blockquote").length, 1, "consecutive quoted lines are one quote");
  assert.equal(document.querySelector("blockquote").querySelectorAll("p").length, 1);
  const diagram = document.querySelector(".diagram-block");
  assert.ok(diagram.querySelector("[data-diagram-canvas]"));
  assert.equal(diagram.querySelector("[data-copy-text]"), null, "diagram source is stored once");
  assert.equal(diagram.querySelector(".diagram-source code").textContent, "graph LR; A-->B");
});

test("a block's ownership key follows its source only", () => {
  const first = dom(renderMarkdown("```js\nconst a = 1;\n```")).querySelector(".code-block");
  const again = dom(renderMarkdown("前言\n\n```js\nconst a = 1;\n```")).querySelector(".code-block");
  const changed = dom(renderMarkdown("```js\nconst a = 2;\n```")).querySelector(".code-block");
  assert.equal(first.dataset.uiOwned, again.dataset.uiOwned);
  assert.notEqual(first.dataset.uiOwned, changed.dataset.uiOwned);
  assert.notEqual(sourceKey("a"), sourceKey("b"));
});

test("files read as chips with their kind's mark; a long path in prose shows only the file name", () => {
  const document = dom(
    renderMarkdown(
      "改了 `src/aggregate.ts`、`ci.yml`、`data.json`、`shot.png` 和 `report.md`。\n输出在 /Users/fixture/.formicand/workspace/task-1/work/retro-timing.tsv，看看。",
      { linkify: true }
    )
  );
  const kinds = [...document.querySelectorAll(".file-chip")].map((chip) => chip.dataset.fileKind);
  assert.deepEqual(kinds, ["language", "language", "json", "image", "text", "table"]);
  assert.equal(
    document.querySelector(".file-chip use").getAttribute("href"),
    "/assets/file-icons.svg#lang-typescript"
  );
  const path = document.querySelectorAll(".file-chip")[5];
  assert.equal(path.querySelector(".file-chip-name").textContent, "retro-timing.tsv");
  assert.equal(path.title, "/Users/fixture/.formicand/workspace/task-1/work/retro-timing.tsv");
  assert.ok(document.body.textContent.includes("，看看。"));
});

test("a link broken between its label and its target is still one link", () => {
  const document = dom(
    renderMarkdown("包含验证。[耗时明细]\n(/Users/fixture/work/retro-timing.tsv)", {
      resolveLocalLink: () => ({
        href: "/api/artifact?x",
        artifactPath: "work/retro-timing.tsv",
        taskId: "t"
      })
    })
  );
  const chip = document.querySelector("a.file-chip");
  assert.equal(chip.dataset.messageArtifact, "work/retro-timing.tsv");
  assert.equal(chip.querySelector(".file-chip-name").textContent, "耗时明细");
  assert.equal(chip.dataset.fileKind, "table");
  assert.ok(!document.body.textContent.includes("]("));
});

test("web links read as the site's mark, the title and the domain", () => {
  const document = dom(
    renderMarkdown(
      "参考 [Modern Web Guidance](https://web.dev/articles/guide) 和 https://docs.python.org/3/library/os.html。",
      {
        linkify: true
      }
    )
  );
  const [labelled, bare] = document.querySelectorAll("a.link-chip");
  assert.equal(labelled.querySelector(".link-chip-title").textContent, "Modern Web Guidance");
  assert.equal(labelled.querySelector(".link-chip-host").textContent, "web.dev");
  assert.equal(labelled.dataset.linkPreview, "https://web.dev/articles/guide");
  assert.ok(!labelled.hasAttribute("data-link-bare"));
  // Until the page is read, a bare address shows itself without its scheme.
  assert.ok(bare.hasAttribute("data-link-bare"));
  assert.equal(bare.querySelector(".link-chip-title").textContent, "docs.python.org/3/library/os.html");
  assert.equal(bare.querySelector(".link-chip-host"), null);
  assert.equal(bare.getAttribute("target"), "_blank");
});

test("file:// links become file chips or registered artifact links, never raw file anchors", () => {
  const source = [
    "- 入口：[desktop/update-host.cjs](file:///Users/fixture/repo/desktop/update-host.cjs)",
    "- 范围：[desktop/main.cjs](file:///Users/fixture/repo/desktop/main.cjs#L547-L588)",
    "- 本机：[desktop/preload.cjs](file://localhost/Users/fixture/repo/desktop/preload.cjs#L276-L284)",
    "- 产物：[report.md](file:///Users/fixture/artifacts/report.md#L12)",
    "- 远端：[remote](file://other-host/Users/fixture/repo/app.js)"
  ].join("\n");
  const document = dom(
    renderMarkdown(source, {
      linkify: true,
      resolveFile: () => true,
      resolveLocalLink: (path) =>
        path === "/Users/fixture/artifacts/report.md"
          ? {
              href: "/api/tasks/t/artifact?path=report.md&download=1",
              artifactPath: "report.md",
              taskId: "t"
            }
          : undefined
    })
  );
  const buttons = [...document.querySelectorAll("button.file-chip")];
  assert.deepEqual(
    buttons.map((button) => [
      button.querySelector(".file-chip-name").textContent,
      button.dataset.fileRef,
      button.dataset.fileLine || ""
    ]),
    [
      ["desktop/update-host.cjs", "/Users/fixture/repo/desktop/update-host.cjs", ""],
      ["desktop/main.cjs", "/Users/fixture/repo/desktop/main.cjs", "547"],
      ["desktop/preload.cjs", "/Users/fixture/repo/desktop/preload.cjs", "276"]
    ]
  );
  const artifact = document.querySelector("a.file-chip");
  assert.equal(artifact.dataset.messageArtifact, "report.md");
  assert.equal(artifact.getAttribute("href"), "/api/tasks/t/artifact?path=report.md&download=1");
  assert.equal(artifact.querySelector(".file-chip-line").textContent, ":12");
  assert.equal(document.querySelectorAll("a").length, 1);
  assert.ok(document.body.textContent.includes("[remote](file://other-host/Users/fixture/repo/app.js)"));
});

test("linked file references strip :line, decode percent paths, and recognise dotfiles and project files", () => {
  assert.deepEqual(linkedFileReference("/repo/desktop/main.cjs:547"), {
    path: "/repo/desktop/main.cjs",
    line: 547
  });
  assert.deepEqual(linkedFileReference("app.js:12"), { path: "app.js", line: 12 });
  assert.deepEqual(linkedFileReference("file:///repo/%E6%B1%87%E6%8A%A5%20v2.md#L8"), {
    path: "/repo/汇报 v2.md",
    line: 8
  });
  assert.equal(fileReference("console.log"), undefined);
  assert.equal(fileReference("process.env"), undefined);
  assert.equal(fileReference("node scripts/release-local.mjs"), undefined);
  assert.deepEqual(fileReference(".eslintrc.json"), { path: ".eslintrc.json", line: undefined });
  assert.deepEqual(fileReference(".gitignore"), { path: ".gitignore", line: undefined });
  assert.deepEqual(fileReference(".env.local"), { path: ".env.local", line: undefined });
  assert.deepEqual(fileReference("Dockerfile"), { path: "Dockerfile", line: undefined });

  const document = dom(
    renderMarkdown(
      [
        "[main.cjs](/repo/desktop/main.cjs:547)",
        "[app.js](app.js:12)",
        "[my doc](</Users/fixture/repo/my doc.md#L4>)",
        "[汇报](file:///Users/fixture/repo/%E6%B1%87%E6%8A%A5%20v2.md#L8)",
        "[.eslintrc.json](file:///repo/.eslintrc.json)",
        "[.gitignore](file:///repo/.gitignore)",
        "[Dockerfile](file:///repo/Dockerfile)",
        "[Makefile](file:///repo/Makefile)",
        "[types.mts](file:///repo/types.mts)",
        "[schema.graphql](file:///repo/schema.graphql)",
        "[service.proto](file:///repo/service.proto)",
        "[app.log](file:///repo/logs/app.log)",
        "命令 `node scripts/release-local.mjs`、`console.log` 和 `process.env` 保持代码。"
      ].join("\n"),
      { resolveFile: () => true }
    )
  );
  const chips = [...document.querySelectorAll("button.file-chip")];
  assert.equal(chips.length, 12);
  assert.equal(chips[0].dataset.fileRef, "/repo/desktop/main.cjs");
  assert.equal(chips[0].dataset.fileLine, "547");
  assert.equal(chips[0].dataset.fileKind, "language");
  assert.equal(chips[0].title, "打开 /repo/desktop/main.cjs:547");
  assert.equal(chips[1].dataset.fileRef, "app.js");
  assert.equal(chips[1].dataset.fileLine, "12");
  assert.equal(chips[2].dataset.fileRef, "/Users/fixture/repo/my doc.md");
  assert.equal(chips[2].dataset.fileLine, "4");
  assert.equal(chips[3].dataset.fileRef, "/Users/fixture/repo/汇报 v2.md");
  assert.equal(chips[3].dataset.fileLine, "8");
  assert.deepEqual(
    chips.slice(4).map((chip) => chip.dataset.fileRef),
    [
      "/repo/.eslintrc.json",
      "/repo/.gitignore",
      "/repo/Dockerfile",
      "/repo/Makefile",
      "/repo/types.mts",
      "/repo/schema.graphql",
      "/repo/service.proto",
      "/repo/logs/app.log"
    ]
  );
  assert.deepEqual(
    [...document.querySelectorAll("code")].map((node) => node.textContent),
    ["node scripts/release-local.mjs", "console.log", "process.env"]
  );
});

test("bare absolute paths and file:// URLs preserve line locators and open when resolvable", () => {
  const source = [
    "见 /Users/fixture/repo/desktop/main.cjs:547 和 /Users/fixture/repo/desktop/preload.cjs#L276-L284，",
    "以及 file:///Users/fixture/repo/docs/%E8%AF%B4%E6%98%8E%201.md#L3 和 file:///Users/fixture/artifacts/report.md#L9，",
    "但 file://other-host/Users/fixture/repo/app.js 保持原样。"
  ].join("\n");
  const document = dom(
    renderMarkdown(source, {
      linkify: true,
      resolveFile: () => true,
      resolveLocalLink: (path) =>
        path === "/Users/fixture/artifacts/report.md"
          ? {
              href: "/api/tasks/t/artifact?path=report.md&download=1",
              artifactPath: "report.md",
              taskId: "t"
            }
          : undefined
    })
  );
  const buttons = [...document.querySelectorAll("button.file-chip")];
  assert.deepEqual(
    buttons.map((button) => [
      button.querySelector(".file-chip-name").textContent,
      button.dataset.fileRef,
      button.dataset.fileLine || ""
    ]),
    [
      ["main.cjs", "/Users/fixture/repo/desktop/main.cjs", "547"],
      ["preload.cjs", "/Users/fixture/repo/desktop/preload.cjs", "276"],
      ["说明 1.md", "/Users/fixture/repo/docs/说明 1.md", "3"]
    ]
  );
  const artifact = document.querySelector("a.file-chip");
  assert.equal(artifact.dataset.messageArtifact, "report.md");
  assert.equal(artifact.querySelector(".file-chip-line").textContent, ":9");
  assert.equal(document.querySelectorAll("a").length, 1);
  assert.ok(document.body.textContent.includes("file://other-host/Users/fixture/repo/app.js"));
});

test("split links inside list items stay inside the same item, including angle-bracket targets", () => {
  const source = [
    "- **开发版已支持应用内更新**: [desktop/update-host.cjs]",
    "  (file:///Users/fixture/repo/desktop/update-host.cjs) 和 [my doc]",
    "  (<file:///Users/fixture/repo/my doc.md#L5>) 都在同一条。",
    "- 第二条列表项"
  ].join("\n");
  const document = dom(renderMarkdown(source, { linkify: true, resolveFile: () => true }));
  assert.equal(document.querySelectorAll("ul").length, 1);
  assert.equal(document.querySelectorAll("li").length, 2);
  assert.equal(document.querySelectorAll("p").length, 0);
  const chips = [...document.querySelectorAll("li button.file-chip")];
  assert.deepEqual(
    chips.map((chip) => [
      chip.querySelector(".file-chip-name").textContent,
      chip.dataset.fileRef,
      chip.dataset.fileLine || ""
    ]),
    [
      ["desktop/update-host.cjs", "/Users/fixture/repo/desktop/update-host.cjs", ""],
      ["my doc", "/Users/fixture/repo/my doc.md", "5"]
    ]
  );
  assert.ok(!document.body.textContent.includes("]("));
});
