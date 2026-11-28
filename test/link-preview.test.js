import { listenOnFixtureHttpPort } from "./fixtures/http-server.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createLinkPreviewService,
  LinkPreviewRefused,
  readHead
} from "../dist/src/dashboard/link-preview-service.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

test("the head gives the page title and the sharpest declared icon", () => {
  const head = readHead(
    `<html><head><title> Old &amp; plain </title>
     <meta property="og:title" content="Modern Web Guidance">
     <link rel="icon" href="/favicon-16.png" sizes="16x16">
     <link rel="icon" type="image/svg+xml" href="/mark.svg">
     </head><body><title>not this</title></body></html>`
  );
  assert.deepEqual(head, { title: "Modern Web Guidance", icon: "/mark.svg" });
  assert.deepEqual(readHead("<title>A &#x4e2d; B</title>"), { title: "A 中 B", icon: undefined });
});

test("only public http(s) addresses are read", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-preview-"));
  try {
    const service = createLinkPreviewService({ cacheRoot: root });
    for (const address of [
      "http://localhost:8080/",
      "http://127.0.0.1/",
      "http://10.0.0.8/admin",
      "http://192.168.1.1/",
      "http://[::1]/",
      "ftp://example.com/file",
      "https://user:secret@example.com/",
      "not a url"
    ])
      await assert.rejects(service.preview(address), LinkPreviewRefused, address);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a page is read once: its title and icon are kept on disk for later reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-preview-"));
  let pageReads = 0;
  const server = createServer((request, response) => {
    if (request.url === "/moved") {
      response.writeHead(302, { location: "/guide" });
      response.end();
      return;
    }
    if (request.url === "/guide") {
      pageReads += 1;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<head><title>指南</title><link rel="icon" href="/icon.png"></head><body></body>');
      return;
    }
    if (request.url === "/icon.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(PNG);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await listenOnFixtureHttpPort(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const service = createLinkPreviewService({ cacheRoot: root, localAllowed: true });
    const [first, again] = await Promise.all([
      service.preview(`${base}/moved#part`),
      service.preview(`${base}/moved`)
    ]);
    assert.equal(first.title, "指南");
    assert.equal(first.icon, `data:image/png;base64,${PNG.toString("base64")}`);
    assert.deepEqual(again, first);
    assert.equal(pageReads, 1);
    assert.equal((await readdir(root)).length, 1);

    // A fresh service over the same cache reads the file, not the site.
    const restarted = createLinkPreviewService({ cacheRoot: root, localAllowed: true });
    assert.deepEqual(await restarted.preview(`${base}/moved`), first);
    assert.equal(pageReads, 1);

    // A site that does not answer keeps its address and no icon.
    const missing = await service.preview(`${base}/missing`);
    assert.deepEqual(missing, { url: `${base}/missing`, title: "", icon: "" });
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
