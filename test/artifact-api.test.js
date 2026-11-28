import { availableLocalHttpPort } from "../dist/src/platform/local-http-port.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { GlobalProjectCatalog } from "../dist/src/workspace/project-catalog.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

test(
  "Dashboard discovers final files and preserves binary downloads, ranges and bounded Unicode previews",
  { timeout: 20000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "formicand-artifact-api-"));
    let child;
    try {
      const workspaceRoot = join(root, "workspace");
      const projectDirectory = join(root, "project");
      await mkdir(projectDirectory);
      const catalog = new GlobalProjectCatalog(join(root, "projects.json"));
      const project = await catalog.create({ projectName: "Artifact API", projectDirectory });
      const store = new LocalWorkspaceStore(workspaceRoot);
      await store.createTask("task", {
        goal: "artifact API regression",
        projectId: project.projectId,
        projectCatalogPath: catalog.filePath,
        projectDirectory
      });
      const artifacts = join(workspaceRoot, "task", "artifacts");
      const candidate = join(workspaceRoot, "task", "agents", "main", "deliverables");
      await mkdir(candidate, { recursive: true });
      await writeFile(join(candidate, "candidate.md"), "not a final file");
      await writeFile(join(artifacts, "报告 说明.md"), "# 已验收\n");
      await writeFile(join(artifacts, "long.txt"), "中".repeat(400000));
      await writeFile(join(artifacts, "result.json"), '{"purpose":"user requested JSON"}');
      const binary = Buffer.from([80, 75, 3, 4, 255, 0, 128, 33]);
      await writeFile(join(artifacts, "演示 文稿.pptx"), binary);
      await writeFile(join(artifacts, "preview.pdf"), Buffer.from("%PDF-1.7\nfixture"));
      await writeFile(join(artifacts, "preview.png"), Buffer.from([137, 80, 78, 71, 0, 255]));
      await writeFile(join(root, "secret.txt"), "outside");
      await mkdir(join(projectDirectory, "src", "hazard"), { recursive: true });
      await mkdir(join(projectDirectory, "docs"), { recursive: true });
      await mkdir(join(projectDirectory, ".git"));
      await writeFile(join(projectDirectory, ".git", "config"), "[core]\n");
      await writeFile(join(projectDirectory, "src", "hazard", "HazardQuery.kt"), "fun query() = 1\n");
      await writeFile(join(projectDirectory, "src", "Other.kt"), "class Other\n");
      await writeFile(join(projectDirectory, "docs", "说明 1.md"), "# 说明\n");
      await writeFile(join(projectDirectory, "blob.bin"), Buffer.from([1, 0, 2]));
      await symlink(join(root, "secret.txt"), join(projectDirectory, "linked.txt"));
      await symlink(join(root, "secret.txt"), join(artifacts, "escape.txt"));
      const config = join(root, "config.json");
      await writeFile(config, "{}");
      const port = await availableLocalHttpPort();
      child = spawn(process.execPath, ["dist/src/cli/dashboard.js"], {
        cwd: resolve("."),
        stdio: "ignore",
        env: {
          ...process.env,
          FORMICAND_WORKSPACE: workspaceRoot,
          FORMICAND_HOME: join(root, "home"),
          FORMICAND_GLOBAL_INDEX: join(root, "global.json"),
          FORMICAND_CONFIG: config,
          FORMICAND_UI_PORT: String(port),
          FORMICAND_API_BASE: "",
          FORMICAND_API_KEY: ""
        }
      });
      const base = `http://127.0.0.1:${port}`;
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          if ((await fetch(`${base}/api/tasks`)).ok) break;
        } catch {
          /* wait for listener */
        }
        if (child.exitCode !== null) throw new Error("dashboard exited before listening");
        await delay(20);
      }
      const fileUrl = (name, extra = "") =>
        `${base}/api/tasks/task/artifact?path=${encodeURIComponent(name)}${extra}`;
      let detail = await (await fetch(`${base}/api/tasks/task`)).json();
      assert.equal(detail.artifacts.length, 6);
      assert.equal(
        detail.artifacts.some((entry) => /candidate|escape/.test(entry.relativePath)),
        false
      );
      assert.ok(
        detail.artifacts.some((entry) => entry.relativePath === "result.json"),
        "final JSON files must not be filtered as logs"
      );
      let preview = await (await fetch(fileUrl("报告 说明.md"))).json();
      assert.equal(preview.previewKind, "text");
      assert.equal(preview.content, "# 已验收\n");
      const oldVersion = preview.version;
      await writeFile(join(artifacts, "报告 说明.md"), "# 新版\n");
      detail = await (await fetch(`${base}/api/tasks/task`)).json();
      preview = await (await fetch(fileUrl("报告 说明.md"))).json();
      assert.notEqual(preview.version, oldVersion);
      assert.equal(preview.content, "# 新版\n");
      const long = await (await fetch(fileUrl("long.txt"))).json();
      assert.equal(long.truncated, true);
      assert.ok(Buffer.byteLength(long.content) <= 1024 * 1024);
      assert.equal(long.content.includes("\uFFFD"), false);
      const binaryPreview = await (await fetch(fileUrl("演示 文稿.pptx"))).json();
      assert.equal(binaryPreview.previewKind, "download");
      assert.equal(binaryPreview.content, undefined);
      const download = await fetch(fileUrl("演示 文稿.pptx", "&download=1"));
      assert.match(download.headers.get("content-disposition"), /^attachment; filename\*=UTF-8''/);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), binary);
      assert.equal((await (await fetch(fileUrl("preview.pdf"))).json()).previewKind, "pdf");
      assert.equal((await (await fetch(fileUrl("preview.png"))).json()).previewKind, "image");
      const range = await fetch(fileUrl("演示 文稿.pptx", "&raw=1"), { headers: { range: "bytes=2-5" } });
      assert.equal(range.status, 206);
      assert.equal(range.headers.get("content-range"), "bytes 2-5/8");
      assert.deepEqual(Buffer.from(await range.arrayBuffer()), binary.subarray(2, 6));
      const changedRange = await fetch(fileUrl("演示 文稿.pptx", "&raw=1"), {
        headers: { range: "bytes=2-5", "if-range": '"old-revision"' }
      });
      assert.equal(changedRange.status, 200);
      assert.deepEqual(Buffer.from(await changedRange.arrayBuffer()), binary);
      const invalidRange = await fetch(fileUrl("preview.pdf", "&raw=1"), {
        headers: { range: "bytes=999-" }
      });
      assert.equal(invalidRange.status, 416);
      for (const path of [
        "../secret.txt",
        "escape.txt",
        "/etc/passwd",
        "agents/main/deliverables/candidate.md"
      ]) {
        assert.equal((await fetch(fileUrl(path))).status, 400);
      }
      const projectUrl = (name, extra = "") =>
        `${base}/api/tasks/task/project-file?path=${encodeURIComponent(name)}${extra}`;
      const source = await (await fetch(projectUrl("src/hazard/HazardQuery.kt"))).json();
      assert.equal(source.previewKind, "text");
      assert.equal(source.content, "fun query() = 1\n");
      assert.match(source.rawUrl, /project-file\?path=src%2Fhazard%2FHazardQuery\.kt&raw=1$/);
      assert.equal((await (await fetch(projectUrl("blob.bin"))).json()).previewKind, "download");
      assert.equal((await fetch(projectUrl("missing.kt"))).status, 404);
      for (const path of [".git/config", "linked.txt", "../secret.txt", "/etc/passwd"])
        assert.equal((await fetch(projectUrl(path))).status, 400, path);
      const resolveUrl = (reference) =>
        `${base}/api/tasks/task/project-file/resolve?path=${encodeURIComponent(reference)}`;
      const resolved = async (reference) => (await (await fetch(resolveUrl(reference))).json()).matches;
      assert.deepEqual(await resolved("./src/hazard/HazardQuery.kt"), ["src/hazard/HazardQuery.kt"]);
      assert.deepEqual(await resolved(join(projectDirectory, "src/Other.kt")), ["src/Other.kt"]);
      assert.deepEqual(
        await resolved(`file://localhost${pathToFileURL(join(projectDirectory, "src/Other.kt")).pathname}`),
        ["src/Other.kt"]
      );
      assert.deepEqual(
        await resolved(`${pathToFileURL(join(projectDirectory, "docs/说明 1.md")).href}#L12-L20`),
        ["docs/说明 1.md"]
      );
      assert.deepEqual(
        await resolved(`file://other-host${pathToFileURL(join(projectDirectory, "src/Other.kt")).pathname}`),
        []
      );
      assert.deepEqual(await resolved("file:///etc/passwd"), []);
      assert.deepEqual(await resolved("hazard/HazardQuery.kt"), ["src/hazard/HazardQuery.kt"]);
      assert.deepEqual(await resolved("HazardQuery.kt"), ["src/hazard/HazardQuery.kt"]);
      assert.deepEqual(await resolved("/etc/passwd"), []);
      const located = await (
        await fetch(`${base}/api/tasks/task/file-location?source=project&path=src%2FOther.kt`)
      ).json();
      assert.equal(located.absolutePath, join(await realpath(projectDirectory), "src", "Other.kt"));
      const artifactLocation = await fetch(
        `${base}/api/tasks/task/file-location?source=artifact&path=${encodeURIComponent("报告 说明.md")}`
      );
      assert.equal(
        (await artifactLocation.json()).absolutePath,
        join(await realpath(artifacts), "报告 说明.md")
      );
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      await rm(root, { recursive: true, force: true });
    }
  }
);
