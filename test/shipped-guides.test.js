import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { FileMatcher } from "app-builder-lib/out/fileMatcher.js";
import { decorateArticle } from "../docs/site/components.mjs";
import { markdownAnchors, markdownLinks } from "../scripts/check-docs.mjs";
import { installRefusal } from "../dist/src/tools/private-data.js";

/**
 * The shipped guides and the statements that cite them. The desktop package picks
 * files by an allowlist while skills and statements keep writing relative links,
 * so a link can point outside what an install actually carries; these tests read
 * the same list the packager uses.
 */
const require = createRequire(import.meta.url);
const config = require("../electron-builder.config.cjs");
const root = resolve(".");
const packaged = new FileMatcher(root, root, (pattern) => pattern, config.files).createFilter();
const shipped = async (file) => packaged(resolve(root, file), await stat(resolve(root, file)));

test("the CUA skill opens shipped, readable guide content", async () => {
  const skill = await readFile(".pi/skills/cua/SKILL.md", "utf8");
  const link = markdownLinks(skill).find((entry) =>
    /(?:^|\/)docs\/en\/README\.md(?:#|$)/.test(entry.destination ?? "")
  );
  assert.ok(link, "the CUA skill links an English guide");
  const [path, anchor] = link.destination.split("#");
  const target = resolve(".pi/skills/cua", path);
  // Agents may read their skills and the docs beside them, nothing else in an install.
  assert.ok(target.startsWith(resolve("docs") + sep), `${path} lives under docs/`);
  assert.equal(await shipped(target), true, `${path} is shipped by the desktop package`);
  const guide = await readFile(target, "utf8");
  assert.match(guide, /cua_script\(/, "the guide carries the CUA body, not just an index");
  if (anchor) assert.ok(markdownAnchors(guide).has(anchor), `${target} has the #${anchor} anchor`);
  assert.equal(
    installRefusal({ path: target }, root, "/Users/example/project", "/Users/example"),
    undefined,
    "a Main in the user's project can read the guide"
  );
});

test("a shipped statement only links guides the desktop package ships", async () => {
  for (const file of ["THIRD_PARTY_NOTICES.md", "docs/en/README.md"]) {
    const text = await readFile(file, "utf8");
    for (const { destination } of markdownLinks(text)) {
      if (!destination || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(destination)) continue;
      const [path, anchor] = destination.split("#");
      const target = resolve(dirname(resolve(root, file)), decodeURIComponent(path));
      const rest = relative(root, target);
      // A statement may cite repository material (provider icons, skill licenses,
      // the site's lockfile); the docs guides it points at are what an install must carry.
      if (file === "THIRD_PARTY_NOTICES.md" && !(rest.startsWith(`docs${sep}`) && rest.endsWith(".md")))
        continue;
      assert.equal(
        await shipped(rest),
        true,
        `${file} links ${destination}, which the desktop package does not ship`
      );
      if (anchor)
        assert.ok(
          markdownAnchors(await readFile(target, "utf8")).has(anchor),
          `${target} has the #${anchor} anchor`
        );
    }
  }
});

test("the CUA guide carries the browser, window and script text an install can read", async () => {
  const guideFile = "docs/en/README.md";
  assert.equal(await shipped(guideFile), true, "the desktop package ships the guide");
  const guide = await readFile(guideFile, "utf8");
  const anchors = markdownAnchors(guide);
  for (const anchor of [
    "built-in-capabilities",
    "browser",
    "native-windows",
    "cua-scripts",
    "resuming-after-an-interruption"
  ])
    assert.ok(anchors.has(anchor), `${guideFile} has the #${anchor} anchor`);
  for (const body of ["browser_wait", "computer_wait", "cua_script("])
    assert.ok(guide.includes(body), `${guideFile} writes out ${body}`);
  // An installed agent reads only .pi/skills and the docs beside them, so a
  // capability section may not send it to the repository-root README.
  const capabilities = guide.slice(guide.indexOf("## Built-in capabilities"), guide.indexOf("## Records"));
  assert.ok(capabilities.length, `${guideFile} has the capability sections`);
  for (const { destination } of markdownLinks(capabilities)) {
    const [path] = decodeURIComponent(destination ?? "").split("#");
    if (!path) continue;
    const rest = relative(root, resolve(dirname(guideFile), path));
    assert.ok(rest.startsWith(`docs${sep}`), `${rest} is inside the readable part of an install`);
    assert.equal(await shipped(rest), true, `${rest} ships with the desktop package`);
  }
  const readme = await readFile("README.md", "utf8");
  assert.match(
    readme,
    /\(docs\/en\/README\.md#built-in-capabilities\)/,
    "the product guide points at the CUA guide instead of repeating it"
  );
});

test("the English entry keeps its language switch and the process-record index", async () => {
  const entry = await readFile("docs/en/README.md", "utf8");
  assert.match(entry, /^\[简体中文\]\(\.\.\/README\.md\) \| English$/m, "the Chinese switch is back");
  const records = markdownLinks(entry.slice(entry.indexOf("## Records"))).map(({ destination }) =>
    decodeURIComponent(destination ?? "")
  );
  for (const page of [
    "../development-handoffs.md",
    "../pitfalls/README.md",
    "../adr-history.md",
    "../retrospectives.md"
  ])
    assert.ok(records.includes(page), `the records index links ${page}`);
});

test("the code map links the capability implementations", async () => {
  const map = await readFile("docs/development.md", "utf8");
  for (const file of [
    "src/tools/read-image.ts",
    "src/gui/browser-contracts.ts",
    ".pi/runtime/tools/browser-use.ts",
    "src/tools/cua-script-guest.js"
  ])
    assert.ok(map.includes(`](${relative("docs", file)})`), `the code map links ${file}`);
});

test("the document standards match the merged layout", async () => {
  const standards = await readFile("docs/development.md", "utf8");
  assert.doesNotMatch(
    standards,
    /上手、配置、内置能力、架构、开发、测试[^。]*docs\/en\//,
    "the retired bilingual guide list is gone"
  );
  assert.match(standards, /docs\/en\/README\.md/, "the shipped English guide is documented");
  const agents = await readFile("AGENTS.md", "utf8");
  const registered = /\| `docs\/development\.md`\s*\|\s*standards\s*\|\s*([^|]+?)\s*\|/.exec(agents);
  assert.ok(registered, "the registry lists the development standard");
  const glossary = await readFile("GLOSSARY.md", "utf8");
  assert.match(
    glossary,
    new RegExp(`\\*\\*${registered[1]}\\*\\*`),
    `GLOSSARY.md defines “${registered[1]}”`
  );
});

test("the English home still marks the product guide as the install card", () => {
  const html = '<ul><li><a href="../../README.html">Product guide</a></li></ul>';
  const decorated = decorateArticle({ file: "docs/en/README.md", english: true }, html);
  assert.match(decorated, /entry-install/, "the card is the install entry");
  assert.match(decorated, /macOS 14\+ · Linux · Node\.js 22\.19\+/, "the card states the platforms");
});

test("the draft-recovery entry links pages that record drafts", async () => {
  const text = await readFile("docs/retrospectives.md", "utf8");
  const row = text.split("\n").find((line) => line.includes("草稿恢复文档与实现一致"));
  assert.ok(row, "the entry is still in the fixed-issues index");
  const links = markdownLinks(row).filter(
    (entry) => entry.destination && !/^https?:/i.test(entry.destination)
  );
  assert.ok(links.length, "the entry cites where the evidence lives");
  for (const { destination } of links) {
    const [path] = destination.split("#");
    const content = await readFile(resolve("docs", path), "utf8");
    assert.ok(
      /composer-drafts|api\/composer/.test(content),
      `${destination} does not record the draft file or its endpoint`
    );
  }
});
