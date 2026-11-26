import { agentName } from "../agent-names.js";
import {
  artifactRequestUrls,
  artifactVersion,
  formatArtifactSize,
  normalizeArtifactPreview,
  projectFileUrls,
  renderArtifactMedia
} from "../artifacts.js";
import { parseUnifiedDiff } from "../diff-view.js";
import { renderMarkdown } from "../markdown.js";
import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../ui/html.js";
import { createOpenWith } from "./open-with.js";

/**
 * Owns the read-only file preview beside a conversation: published artifacts,
 * files of the project folder, and the files of a development change. It
 * never writes a file.
 */
export function createArtifactController({
  state,
  $,
  api,
  showToast,
  renderRightPanel,
  mediaUrl,
  openArtifactViewer,
  previewImage,
  getDelivery = () => undefined
}) {
  /** Types the preview endpoint renders in place; everything else downloads. */
  const TEXTUAL_TYPES = [
    "application/json",
    "application/x-ndjson",
    "application/xml",
    "application/javascript"
  ];
  const OFFICE_TYPES = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ];
  function previewable(artifact) {
    const mime = String(artifact?.mimeType || "");
    return (
      mime === "application/pdf" ||
      mime.startsWith("image/") ||
      mime.startsWith("text/") ||
      TEXTUAL_TYPES.includes(mime) ||
      OFFICE_TYPES.includes(mime)
    );
  }

  /** Previews of project files, by session and path. */
  const projectCache = new Map();
  /** Rendered PDF pages, and the page each PDF shows. */
  const pdfPages = new Map();
  const pdfPage = new Map();
  /** A file reference that matched several project files, waiting for a choice. */
  let choosing = null;
  const openWith = createOpenWith({
    bridge: globalThis.window?.formicandDesktop?.files,
    showToast,
    onChange: () => renderArtifactDrawer()
  });
  const projectKey = (path) => `${state.selected}\0${path}`;

  function downloadArtifact(artifact) {
    const urls = artifactRequestUrls(state.selected, artifact.relativePath, artifactVersion(artifact));
    const link = document.createElement("a");
    link.href = urls.downloadUrl;
    link.download = artifact.displayName || fileBaseName(artifact.relativePath);
    document.body.append(link);
    link.click();
    link.remove();
  }
  function fileBaseName(path) {
    const parts = String(path || "")
      .split(/[\\/]/)
      .filter(Boolean);
    return parts.at(-1) || String(path || ui("未命名文件"));
  }

  function fileLanguage(path) {
    const extension = fileBaseName(path).split(".").at(-1)?.toLowerCase() || "text";
    return (
      {
        md: "Markdown",
        markdown: "Markdown",
        json: "JSON",
        js: "JavaScript",
        mjs: "JavaScript",
        cjs: "JavaScript",
        ts: "TypeScript",
        css: "CSS",
        html: "HTML",
        htm: "HTML",
        py: "Python",
        sh: "Shell",
        yaml: "YAML",
        yml: "YAML",
        diff: "Diff",
        patch: "Diff",
        txt: "Plain text",
        log: "Log"
      }[extension] || extension.toUpperCase()
    );
  }

  function artifactSource(artifact) {
    if (artifact.producerAgentId === "main") return "Formicand";
    const agents = state.detail?.progress?.agents || state.detail?.coordination?.calls || [];
    const agent = agents.find((entry) => entry.agentId === artifact.producerAgentId);
    if (!agent) return "";
    return agentName(agent);
  }

  /** Images open in the full-screen viewer, never as a drawer tab. */
  const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);
  function isImagePath(path) {
    return IMAGE_EXTENSIONS.has(fileBaseName(path).split(".").at(-1)?.toLowerCase() ?? "");
  }

  function openArtifact(path) {
    if (!path) return;
    const artifact = state.detail?.artifacts?.find((entry) => entry.relativePath === path);
    if (!artifact) return;
    if (String(artifact.mimeType || "").startsWith("image/")) {
      const urls = artifactRequestUrls(state.selected, path, artifactVersion(artifact));
      previewImage({
        name: artifact.displayName || fileBaseName(path),
        source: urls.rawUrl,
        download: urls.downloadUrl
      });
      return;
    }
    // A file the preview cannot show is offered as a download instead of an
    // empty pane.
    if (!previewable(artifact)) return downloadArtifact(artifact);
    showTab(`attachment:${path}`);
    ensureArtifactLoaded(path);
  }

  /** A tab's id names what it shows: `diff`, `choose`, or `<kind>:<path>`. */
  function parseTab(id) {
    if (id === "diff" || id === "choose") return { id, kind: id };
    const split = id.indexOf(":");
    return { id, kind: id.slice(0, split), path: id.slice(split + 1) };
  }

  /**
   * Shows `id` in the drawer, after the tabs already open. Only what the
   * reader opened gets a tab; opening it again selects the same tab.
   *
   * The drawer is the work entry's own preview, so opening it never navigates
   * away from the conversation and closing it returns to the same reading
   * position.
   */
  function showTab(id) {
    rememberDrawerTrigger();
    if (!state.openFiles.includes(id)) state.openFiles.push(id);
    state.drawerTab = id;
    state.artifactDrawerOpen = true;
    renderRightPanel();
  }

  function closeTab(id) {
    const index = state.openFiles.indexOf(id);
    state.openFiles = state.openFiles.filter((entry) => entry !== id);
    if (id === "choose") choosing = null;
    if (state.drawerTab === id)
      state.drawerTab = state.openFiles[Math.min(index, state.openFiles.length - 1)] ?? null;
    if (state.openFiles.length) renderRightPanel();
    else closeArtifactDrawer(true);
  }

  /** The panel's change: the whole change, or one file of it opened on its diff. */
  function openPreview({ tab, path } = {}) {
    if (!state.selected) return;
    if (tab === "diff") showTab("diff");
    else if (tab === "file" && path) openChangeFile(path, { view: "diff" });
  }

  /** One file of the change in its own tab, on its content or its diff. */
  function openChangeFile(path, { view, line } = {}) {
    if (isImagePath(path)) return previewChangeImage(path);
    state.drawerLine = line ? { path, line } : null;
    if (view) changeViews.set(projectKey(path), view);
    showTab(`change:${path}`);
  }

  /** A changed image opens in the viewer as the change left it. */
  function previewChangeImage(path) {
    const entry = loadChangeFile(path);
    if (!entry) return;
    const show = () => {
      if (entry.status === "error") return showToast(entry.error);
      const content = entry.content;
      if (content?.kind === "image" && content.data)
        previewImage({
          name: fileBaseName(path),
          source: `data:${content.mimeType};base64,${content.data}`
        });
      else
        showToast(content?.kind === "deleted" ? ui("这张图片在这次改动里已删除") : ui("图片太大，无法预览"));
    };
    if (entry.status === "loading") void entry.done.then(show);
    else show();
  }

  /** A file a reply names that this page already knows: an artifact, or a file of the change. */
  function fileTarget(path) {
    const clean = String(path).replace(/^\.\//, "");
    const matches = (candidate) =>
      typeof candidate === "string" &&
      (candidate === clean || candidate.endsWith(`/${clean}`) || clean.endsWith(`/${candidate}`));
    const artifact = (state.detail?.artifacts || []).find(
      (entry) => entry.taskId === state.selected && matches(entry.relativePath)
    );
    if (artifact) return { kind: "attachment", path: artifact.relativePath };
    const changed = changedFiles().find((file) => matches(file.path));
    if (changed) return { kind: "file", path: changed.path };
  }

  /** Every reference in a session can be looked up; the project folder is asked last. */
  function canOpenReference() {
    return Boolean(state.selected);
  }

  /**
   * Opens the preview a file chip points at, at its line once the text is
   * there. A name this page does not know is looked up in the project folder:
   * one match opens, several are offered to choose from.
   */
  function openFileReference(path, line) {
    const target = fileTarget(path);
    if (target) {
      state.drawerLine = line ? { path: target.path, line } : null;
      if (target.kind === "attachment") openArtifact(target.path);
      else openChangeFile(target.path, { view: "content", line });
      revealLine();
      return true;
    }
    const taskId = state.selected;
    if (!taskId) return false;
    api(`/api/tasks/${encodeURIComponent(taskId)}/project-file/resolve?path=${encodeURIComponent(path)}`, {
      cache: "no-store"
    })
      .then(({ matches }) => {
        if (state.selected !== taskId) return;
        if (!matches?.length) return showToast(ui("项目里找不到这个文件"));
        if (matches.length === 1) return openProjectFile(matches[0], line);
        choosing = { taskId, reference: String(path), line, matches };
        showTab("choose");
      })
      .catch((error) => showToast(error.message));
    return true;
  }

  /** Opens one file of the project folder in its own tab, reading it afresh. */
  function openProjectFile(path, line) {
    const taskId = state.selected;
    if (!taskId || !path) return;
    if (choosing) {
      choosing = null;
      state.openFiles = state.openFiles.filter((entry) => entry !== "choose");
    }
    if (isImagePath(path)) {
      const urls = projectFileUrls(taskId, path);
      previewImage({ name: fileBaseName(path), source: urls.rawUrl, download: urls.downloadUrl });
      return;
    }
    projectCache.delete(projectKey(path));
    state.drawerLine = line ? { path, line } : null;
    showTab(`project:${path}`);
    ensureProjectLoaded(path);
  }

  function ensureProjectLoaded(path) {
    const taskId = state.selected;
    const key = projectKey(path);
    if (projectCache.has(key)) return;
    const pending = { status: "loading" };
    projectCache.set(key, pending);
    api(projectFileUrls(taskId, path).previewUrl, { cache: "no-store" })
      .then((result) => {
        if (projectCache.get(key) !== pending) return;
        const entry = { ...normalizeArtifactPreview(result), status: "ready", signature: result.version };
        projectCache.set(key, entry);
        loadMedia(projectCache, key, projectFileUrls(taskId, path, result.version, result));
        if (state.selected === taskId) renderArtifactDrawer();
      })
      .catch((error) => {
        if (projectCache.get(key) !== pending) return;
        projectCache.set(key, { status: "error", error: error.message });
        if (state.selected === taskId) renderArtifactDrawer();
      });
  }

  function revealLine() {
    const wanted = state.drawerLine;
    if (!wanted) return;
    const node = $("#artifact-drawer")?.querySelectorAll(".drawer-file-line, .code-line")[wanted.line - 1];
    if (!node) return;
    state.drawerLine = null;
    for (const previous of node.parentElement.querySelectorAll(".is-target"))
      previous.classList.remove("is-target");
    node.classList.add("is-target");
    node.scrollIntoView({ block: "center" });
  }

  /** Closing the preview returns the reader to the control that opened it. */
  function rememberDrawerTrigger() {
    // Switching tabs inside an open drawer keeps the original trigger.
    if (state.artifactDrawerOpen) return;
    const active = document.activeElement;
    state.drawerTrigger = active && active !== document.body ? active : null;
  }

  function closeArtifactDrawer(restoreFocus = false) {
    state.artifactDrawerOpen = false;
    renderArtifactDrawer();
    if (!restoreFocus) return;
    const trigger = state.drawerTrigger;
    state.drawerTrigger = null;
    if (trigger?.isConnected) trigger.focus();
  }

  /**
   * Binary previews are fetched through the bound backend, which may be another
   * local origin the page's own URL cannot reach. The bytes become one object
   * URL per versioned request; a version change asks for a new URL.
   */
  const mediaUrls = new Map();
  function cachedMediaUrl(path) {
    const existing = mediaUrls.get(path);
    if (existing) return existing;
    const pending = mediaUrl(path)
      .then((href) => {
        if (href && mediaUrls.get(path) === pending) mediaUrls.set(path, Promise.resolve(href));
        return href;
      })
      // eslint-disable-next-line no-restricted-syntax -- a failed media read drops the cached entry, so the drawer falls back to the plain artifact link
      .catch(() => {
        if (mediaUrls.get(path) === pending) mediaUrls.delete(path);
        return undefined;
      });
    mediaUrls.set(path, pending);
    return pending;
  }

  /** Image and PDF bytes become an object URL once the preview says what the file is. */
  function loadMedia(cache, key, urls) {
    const entry = cache.get(key);
    if (!mediaUrl || !entry || entry.status !== "ready") return;
    if (entry.mediaHref || !["pdf", "image"].includes(entry.previewKind)) return;
    void cachedMediaUrl(urls.rawUrl).then((href) => {
      const current = cache.get(key);
      if (!href || current !== entry) return;
      cache.set(key, { ...current, mediaHref: href });
      renderArtifactDrawer();
    });
  }

  function ensureArtifactLoaded(path) {
    const artifact = state.detail?.artifacts?.find((entry) => entry.relativePath === path);
    if (!artifact) return;
    const signature = artifactVersion(artifact);
    const cached = state.artifactCache.get(path);
    if (cached?.signature === signature) return;
    const taskId = state.selected;
    const pending = { status: "loading", signature };
    state.artifactCache.set(path, pending);
    api(artifactRequestUrls(taskId, path, signature).previewUrl, { cache: "no-store" })
      .then((result) => {
        if (state.selected !== taskId || state.artifactCache.get(path) !== pending) return;
        state.artifactCache.set(path, { ...normalizeArtifactPreview(result), status: "ready", signature });
        loadMedia(state.artifactCache, path, artifactRequestUrls(taskId, path, signature));
        if (state.drawerTab === `attachment:${path}`) renderArtifactDrawer();
      })
      .catch((error) => {
        if (state.selected !== taskId || state.artifactCache.get(path) !== pending) return;
        state.artifactCache.set(path, { status: "error", signature, error: error.message });
        if (state.drawerTab === `attachment:${path}`) renderArtifactDrawer();
      });
  }

  function changedFiles() {
    return getDelivery()?.view?.diff?.files || [];
  }

  /** The file the whole-change tab shows. */
  function selectedFile() {
    const files = changedFiles();
    return files.find((file) => file.path === state.drawerFile)?.path ?? files[0]?.path;
  }

  /** The tabs the reader opened that still have something to show, in opening order. */
  function drawerTabs() {
    const artifacts = state.detail?.artifacts || [];
    const changed = new Set(changedFiles().map((file) => file.path));
    return state.openFiles
      .map(parseTab)
      .filter((tab) => {
        if (tab.kind === "diff") return changed.size > 0;
        if (tab.kind === "change") return changed.has(tab.path);
        if (tab.kind === "attachment") return artifacts.some((entry) => entry.relativePath === tab.path);
        if (tab.kind === "choose") return choosing?.taskId === state.selected;
        return true;
      })
      .map((tab) => ({
        ...tab,
        label:
          tab.kind === "diff"
            ? ui("改动")
            : tab.kind === "choose"
              ? fileBaseName(choosing.reference)
              : tab.kind === "attachment"
                ? artifacts.find((entry) => entry.relativePath === tab.path)?.displayName ||
                  fileBaseName(tab.path)
                : fileBaseName(tab.path)
      }));
  }

  function currentTab(tabs) {
    return tabs.find((entry) => entry.id === state.drawerTab) ?? tabs.at(-1);
  }

  /**
   * One file of the change: its patch and what it holds at the candidate,
   * read once per candidate. Each file is read on its own, so a large change
   * never has to arrive whole before one file can be shown.
   */
  const changeFiles = new Map();
  /** Whether each opened file of the change shows its content or its diff. */
  const changeViews = new Map();
  function changeRequest(path) {
    const developmentId = getDelivery()?.view?.development?.developmentId;
    return api(`/api/tasks/${encodeURIComponent(state.selected)}/deliveries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "diff", developmentId, ...(path === undefined ? {} : { path }) })
    });
  }
  function changeKey(path) {
    const view = getDelivery()?.view;
    const developmentId = view?.development?.developmentId;
    if (!developmentId || !view?.diff) return undefined;
    return `${state.selected}\0${developmentId}\0${view.diff.candidateCommit}\0${path}`;
  }
  function loadChangeFile(path) {
    const key = changeKey(path);
    if (!key) return undefined;
    const existing = changeFiles.get(key);
    if (existing) return existing;
    const entry = { key, status: "loading" };
    changeFiles.set(key, entry);
    entry.done = changeRequest(path)
      .then((result) => {
        Object.assign(entry, {
          status: "ready",
          file: parseUnifiedDiff(result.diff.patch)[0],
          content: result.diff.contents?.[0],
          patch: result.diff.patch,
          truncated: Boolean(result.diff.truncated)
        });
      })
      .catch((error) => {
        Object.assign(entry, { status: "error", error: error.message });
      })
      .then(() => {
        if (changeFiles.get(key) === entry) renderArtifactDrawer();
      });
    return entry;
  }

  /** The preview entry behind a file tab, with the URLs its source serves it from. */
  function fileEntry(tab) {
    if (tab.kind === "attachment") {
      const artifact = (state.detail?.artifacts || []).find((entry) => entry.relativePath === tab.path) || {};
      const cached = state.artifactCache.get(tab.path);
      return {
        cache: state.artifactCache,
        key: tab.path,
        cached,
        size: cached?.size ?? artifact.size,
        urls: artifactRequestUrls(
          state.selected,
          tab.path,
          cached?.version || artifactVersion(artifact),
          cached
        )
      };
    }
    const cached = projectCache.get(projectKey(tab.path));
    return {
      cache: projectCache,
      key: projectKey(tab.path),
      cached,
      size: cached?.size,
      urls: projectFileUrls(state.selected, tab.path, cached?.version, cached)
    };
  }

  /** What the "Open" button hands to the desktop for this tab, if anything. */
  function openTarget(tab) {
    if (tab.kind === "attachment") return { source: "artifact", path: tab.path };
    if (tab.kind === "project") return { source: "project", path: tab.path };
    const developmentId = getDelivery()?.view?.development?.developmentId;
    if (tab.kind === "change" && developmentId) return { source: "change", path: tab.path, developmentId };
    return undefined;
  }

  /** One rendered page of a PDF, read once per file version and page. */
  function pdfPageEntry(file, page) {
    const key = `${file.key}\0${file.cached?.version ?? ""}\0${page}`;
    const entry = pdfPages.get(key);
    if (entry) return entry;
    const pending = { status: "loading" };
    pdfPages.set(key, pending);
    api(`${file.urls.previewUrl}&page=${page}`, { cache: "no-store" })
      .then((result) => {
        if (pdfPages.get(key) !== pending) return;
        pdfPages.set(key, { status: "ready", image: result.image, pages: result.pages });
        renderArtifactDrawer();
      })
      .catch((error) => {
        if (pdfPages.get(key) !== pending) return;
        pdfPages.set(key, { status: "error", error: error.message });
        renderArtifactDrawer();
      });
    return pending;
  }

  function renderPdf(file, name) {
    const page = pdfPage.get(file.key) ?? 1;
    const entry = pdfPageEntry(file, page);
    if (entry.status === "loading")
      return `<div class="drawer-state"><span class="editor-spinner"></span><strong>${ui`正在打开 ${esc(
        name
      )}`}</strong></div>`;
    // Without a rendered page (no PDF parser here, or a damaged file) the
    // isolated viewer still opens it.
    if (entry.status === "error" || !entry.image)
      return `<div class="drawer-state"><strong>${esc(name)}</strong><p>${ui("点击“打开 ↗”查看 PDF。")}</p></div>`;
    const pages = Number(entry.pages) || 1;
    const pager =
      pages > 1
        ? `<nav class="drawer-pdf-pager" aria-label="${ui("PDF 翻页")}"><button type="button" class="drawer-action is-icon" data-pdf-page="${
            page - 1
          }" aria-label="${ui("上一页")}" title="${ui("上一页")}"${page <= 1 ? " disabled" : ""}>${icon(
            "chevron-left"
          )}</button><span>${page} / ${pages}</span><button type="button" class="drawer-action is-icon" data-pdf-page="${
            page + 1
          }" aria-label="${ui("下一页")}" title="${ui("下一页")}"${page >= pages ? " disabled" : ""}>${icon(
            "chevron-right"
          )}</button></nav>`
        : "";
    return `${pager}<div class="drawer-pdf-page"><img src="data:image/png;base64,${String(
      entry.image
    ).replace(/[^A-Za-z0-9+/=]/g, "")}" alt="${page} / ${pages}" /></div>`;
  }

  function renderChoices() {
    return `<div class="drawer-choices" role="list">${choosing.matches
      .map(
        (path) =>
          `<button type="button" role="listitem" class="drawer-choice" data-choose-file="${esc(path)}">${icon(
            "file"
          )}<span>${esc(path)}</span></button>`
      )
      .join("")}</div>`;
  }

  function renderDiffLines(file) {
    return file.lines
      .map(
        (hunk) =>
          `${file.lines.length > 1 ? `<div class="drawer-hunk">${esc(hunk.header)}</div>` : ""}${hunk.lines
            .map(
              (line) =>
                `<div class="drawer-line" data-kind="${line.kind}"><span class="drawer-line-number">${line.number}</span><span class="drawer-line-sign">${
                  line.kind === "add" ? "+" : line.kind === "delete" ? "−" : ""
                }</span><code>${esc(line.text) || " "}</code></div>`
            )
            .join("")}`
      )
      .join("");
  }

  function downloadText(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.dataset.managedDownload = "local";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const drawerState = (title, detail = "") =>
    `<div class="drawer-state"><strong>${title}</strong>${detail ? `<p>${detail}</p>` : ""}</div>`;

  /** A changed file still being read, or the reason it could not be. */
  function changeFileState(entry, name) {
    if (!entry || entry.status === "loading")
      return `<div class="drawer-state"><formicand-spinner class="editor-spinner" aria-hidden="true"></formicand-spinner><strong>${ui`正在打开 ${esc(
        name
      )}`}</strong></div>`;
    if (entry.status === "error")
      return `<div class="drawer-state is-error"><strong>${ui("无法显示改动")}</strong><p>${esc(
        entry.error
      )}</p><button class="drawer-action" data-retry-change>${ui("重新加载")}</button></div>`;
    return undefined;
  }

  function renderFileDiff(entry) {
    if (entry.file?.lines.length) return `<div class="drawer-lines">${renderDiffLines(entry.file)}</div>`;
    return ["binary", "image", "large"].includes(entry.content?.kind)
      ? drawerState(ui("二进制文件，没有文字改动"))
      : drawerState(ui("没有文字改动"), ui("可能只改了文件名或权限。"));
  }

  function renderFileContent(entry) {
    const content = entry.content;
    if (content?.kind === "deleted") return drawerState(ui("这个文件在这次改动里已删除"));
    if (content?.kind === "binary") return drawerState(ui("二进制文件，不能预览"));
    if (content?.kind === "large") return drawerState(ui("文件太大，不能预览"), ui("可以切到“改动”查看。"));
    if (content?.kind !== "text") return drawerState(ui("读不到这个文件"));
    // A final newline ends the last line; it does not start another.
    return `<div class="drawer-lines">${content.content
      .replace(/\n$/, "")
      .split("\n")
      .map(
        (line, index) =>
          `<div class="drawer-file-line"><span class="drawer-line-number">${index + 1}</span><code>${
            esc(line) || " "
          }</code></div>`
      )
      .join("")}</div>`;
  }

  /** One file of the change; a file the change deleted has only its diff. */
  function changeView(tab, entry) {
    if (entry?.content?.kind === "deleted") return "diff";
    return changeViews.get(projectKey(tab.path)) ?? "content";
  }

  function renderChangeTab(tab, entry) {
    const waiting = changeFileState(entry, fileBaseName(tab.path));
    if (waiting) return waiting;
    const view = changeView(tab, entry);
    const toggle =
      entry.content?.kind === "deleted"
        ? ""
        : `<div class="drawer-view-toggle" role="group" aria-label="${ui("查看方式")}">${[
            ["content", ui("内容")],
            ["diff", ui("改动")]
          ]
            .map(
              ([id, label]) =>
                `<button type="button" data-change-view="${id}" aria-pressed="${view === id}">${label}</button>`
            )
            .join("")}</div>`;
    return `${toggle}${view === "diff" ? renderFileDiff(entry) : renderFileContent(entry)}`;
  }

  /** The whole change: its files on the left, the chosen file's diff beside them. */
  function renderWholeChange(files, entry) {
    const selected = selectedFile();
    const counts = (file) =>
      `<span class="rp-add">+${Number(file.additions)}</span><span class="rp-del">−${Number(file.deletions)}</span>`;
    const list = files
      .map((file) => {
        const name = fileBaseName(file.path);
        const folder = file.path.slice(0, -name.length).replace(/\/$/, "");
        return `<button type="button" class="drawer-change-file${
          file.path === selected ? " active" : ""
        }" data-change-select="${esc(file.path)}" aria-current="${file.path === selected}" title="${esc(
          file.path
        )}"><span class="drawer-change-name">${esc(name)}${
          folder ? `<small>${esc(folder)}</small>` : ""
        }</span>${counts(file)}</button>`;
      })
      .join("");
    const picker = `<select class="drawer-change-picker" data-change-pick aria-label="${ui("改动文件")}">${files
      .map(
        (file) =>
          `<option value="${esc(file.path)}"${file.path === selected ? " selected" : ""}>${esc(file.path)}</option>`
      )
      .join("")}</select>`;
    const main = isImagePath(selected)
      ? `<div class="drawer-state"><strong>${esc(fileBaseName(selected))}</strong><button type="button" class="drawer-action" data-change-image="${esc(
          selected
        )}">${ui("查看图片")}</button></div>`
      : (changeFileState(entry, fileBaseName(selected)) ?? renderFileDiff(entry));
    return `<div class="drawer-change"><nav class="drawer-change-files" aria-label="${ui(
      "改动文件"
    )}">${list}</nav><div class="drawer-change-main">${picker}${main}</div></div>`;
  }

  function renderArtifactDrawer() {
    const drawer = $("#artifact-drawer");
    if (!drawer) return;
    const attachments = state.detail?.artifacts || [];
    const tabs = drawerTabs();
    const tab = currentTab(tabs);
    if (!state.artifactDrawerOpen || !tab) {
      drawer.hidden = true;
      drawer.innerHTML = "";
      delete drawer.dataset.signature;
      delete drawer.dataset.tab;
      return;
    }
    const isChange = tab.kind === "diff" || tab.kind === "change";
    const isFile = tab.kind === "attachment" || tab.kind === "project";
    const artifact = attachments.find((entry) => entry.relativePath === tab.path) || {};
    const file = isFile ? fileEntry(tab) : undefined;
    const cached = file?.cached;
    const changePath = tab.kind === "diff" ? selectedFile() : tab.path;
    const change =
      isChange && !(tab.kind === "diff" && isImagePath(changePath)) ? loadChangeFile(changePath) : undefined;
    const view = tab.kind === "change" ? changeView(tab, change) : undefined;
    const target = openTarget(tab);
    const pdf = cached?.status === "ready" && cached.previewKind === "pdf";
    const pdfState = pdf
      ? pdfPages.get(`${file.key}\0${cached.version ?? ""}\0${pdfPage.get(file.key) ?? 1}`)
      : undefined;
    const signature = JSON.stringify([
      state.selected,
      tabs.map((entry) => [entry.id, entry.label]),
      tab.id,
      changePath,
      change?.key,
      change?.status,
      view,
      cached?.status,
      cached?.version,
      cached?.mediaHref,
      cached?.error,
      pdf ? [pdfPage.get(file.key) ?? 1, pdfState?.status] : null,
      tab.kind === "choose" ? choosing?.matches : null,
      openWith.signature(state.selected, target)
    ]);
    // Polling task status must not reload a PDF or reset the reader every 3.5 s.
    if (drawer.dataset.signature === signature) return;
    const scrollTop =
      drawer.dataset.tab === tab.id ? drawer.querySelector(".drawer-content")?.scrollTop || 0 : 0;
    drawer.dataset.signature = signature;
    drawer.dataset.tab = tab.id;
    const files = changedFiles();
    const changed = files.find((entry) => entry.path === tab.path);
    const totalAdds = files.reduce((sum, entry) => sum + Number(entry.additions || 0), 0);
    const totalDels = files.reduce((sum, entry) => sum + Number(entry.deletions || 0), 0);
    const commit = String(getDelivery()?.view?.diff?.candidateCommit || "").slice(0, 8);
    const title =
      tab.kind === "diff"
        ? ui("改动")
        : tab.kind === "attachment"
          ? artifact.displayName || tab.label
          : tab.label;
    const meta =
      tab.kind === "diff"
        ? `${commit ? ui`候选 ${commit} · ` : ""}${ui`${files.length} 个文件`} · +${totalAdds} −${totalDels}`
        : tab.kind === "change"
          ? [
              tab.path === tab.label ? "" : tab.path,
              changed ? `+${changed.additions} −${changed.deletions}` : ""
            ]
              .filter(Boolean)
              .join(" · ")
          : tab.kind === "choose"
            ? ui`${choosing.matches.length} 个同名文件`
            : `${tab.kind === "project" ? `${tab.path} · ` : ""}${fileLanguage(tab.path)} · ${formatArtifactSize(file.size)}`;
    const urls = file?.urls ?? { previewUrl: "", rawUrl: "", downloadUrl: "" };
    const downloadHref = pdf && cached.mediaHref ? cached.mediaHref : urls.downloadUrl;
    const canCopy = isFile && cached?.status === "ready" && ["text", "office"].includes(cached.previewKind);
    const copyAction = canCopy
      ? `<button type="button" class="drawer-action is-icon" data-copy-drawer aria-label="${ui(
          "复制内容"
        )}" title="${ui("复制内容")}">${icon("copy")}</button>`
      : "";
    const openAction = isFile
      ? `<a class="drawer-action is-icon" data-open-artifact-viewer href="${esc(
          urls.rawUrl
        )}" target="_blank" rel="noopener noreferrer" aria-label="${ui("打开 ↗")}" title="${ui(
          "打开 ↗"
        )}">${icon("external")}</a>`
      : "";
    const downloadAction = isChange
      ? `<button type="button" class="drawer-action is-icon" data-download-diff aria-label="${ui(
          "下载"
        )}" title="${ui("下载")}">${icon("download")}</button>`
      : isFile
        ? `<a class="drawer-action is-icon" href="${esc(downloadHref)}" download="${esc(
            fileBaseName(tab.path)
          )}" aria-label="${ui("下载")}" title="${ui("下载")}">${icon("download")}</a>`
        : "";
    let content;
    if (tab.kind === "diff") content = renderWholeChange(files, change);
    else if (tab.kind === "change") content = renderChangeTab(tab, change);
    else if (tab.kind === "choose") content = renderChoices();
    else if (!cached || cached.status === "loading")
      content = `<div class="drawer-state"><formicand-spinner class="editor-spinner" aria-hidden="true"></formicand-spinner><strong>${ui`正在打开 ${esc(
        title
      )}`}</strong></div>`;
    else if (cached.status === "error")
      content = `<div class="drawer-state is-error"><strong>${ui("文件读取失败")}</strong><p>${esc(
        cached.error || ui("未知错误")
      )}</p><button class="drawer-action" data-retry-artifact>${ui("重新加载")}</button></div>`;
    else if (pdf) content = renderPdf(file, title);
    else
      content = renderArtifactDocument(cached, tab.path, {
        ...urls,
        rawUrl: cached.mediaHref || (mediaUrl ? "" : urls.rawUrl)
      });
    const partial = isChange
      ? view === "content"
        ? change?.content?.truncated
        : change?.status === "ready" && change.truncated
      : cached?.truncated;
    const previewNote = partial
      ? `<div class="artifact-preview-note" role="status">${
          view === "content" || !isChange
            ? ui("文件较大，仅显示前部分内容。下载可查看完整文件。")
            : ui("改动较大，仅显示前部分内容。下载可查看完整改动。")
        }</div>`
      : "";
    drawer.hidden = false;
    drawer.innerHTML = `<header class="artifact-drawer-head">${icon(
      isChange ? "git-commit" : "file"
    )}<div class="artifact-drawer-title"><strong>${esc(title)}</strong><span>${esc(
      meta
    )}</span></div><span class="rp-spacer"></span><div class="drawer-actions">${openWith.markup(
      state.selected,
      target
    )}${copyAction}${openAction}${downloadAction}<button type="button" class="drawer-close" data-close-drawer aria-label="${ui(
      "关闭预览"
    )}" title="${ui("关闭预览")}">${icon("close")}</button></div></header><nav class="drawer-tabs" role="tablist" aria-label="${ui(
      "预览内容"
    )}">${tabs
      .map(
        (entry) =>
          `<span class="drawer-tab${entry.id === tab.id ? " active" : ""}"><button type="button" role="tab" aria-selected="${
            entry.id === tab.id
          }" data-drawer-tab="${esc(entry.id)}" ${
            entry.kind === "attachment" || entry.kind === "project" || entry.kind === "change"
              ? `data-drawer-file="${esc(entry.path)}"`
              : ""
          } title="${esc(entry.path ?? entry.label)}">${esc(entry.label)}</button><button type="button" class="drawer-tab-close" data-close-tab="${esc(
            entry.id
          )}" aria-label="${esc(ui`关闭 ${entry.label}`)}" title="${ui("关闭")}">${icon("close")}</button></span>`
      )
      .join("")}</nav><div class="artifact-drawer-body"><div class="drawer-content ${
      pdf ? "is-pdf" : ""
    }">${previewNote}${content}</div></div>`;
    drawer.querySelector(".drawer-content").scrollTop = scrollTop;
    if (view === "content" || isFile) revealLine();
    openWith.bind(drawer, state.selected, target);
    for (const node of drawer.querySelectorAll("[data-drawer-tab]"))
      node.addEventListener("click", () => {
        state.drawerTab = node.dataset.drawerTab;
        renderArtifactDrawer();
      });
    for (const node of drawer.querySelectorAll("[data-close-tab]"))
      node.addEventListener("click", () => closeTab(node.dataset.closeTab));
    const pick = (path) => {
      if (isImagePath(path)) return previewChangeImage(path);
      state.drawerFile = path;
      renderArtifactDrawer();
      drawer.querySelector(`[data-change-select="${CSS.escape(path)}"]`)?.focus();
    };
    for (const node of drawer.querySelectorAll("[data-change-select]"))
      node.addEventListener("click", () => pick(node.dataset.changeSelect));
    drawer.querySelector(".drawer-change-files")?.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const index = files.findIndex((entry) => entry.path === selectedFile());
      const next = files[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      state.drawerFile = next.path;
      renderArtifactDrawer();
      drawer.querySelector(`[data-change-select="${CSS.escape(next.path)}"]`)?.focus();
    });
    drawer
      .querySelector("[data-change-pick]")
      ?.addEventListener("change", (event) => pick(event.target.value));
    drawer
      .querySelector("[data-change-image]")
      ?.addEventListener("click", (event) => previewChangeImage(event.currentTarget.dataset.changeImage));
    for (const node of drawer.querySelectorAll("[data-change-view]"))
      node.addEventListener("click", () => {
        changeViews.set(projectKey(tab.path), node.dataset.changeView);
        renderArtifactDrawer();
      });
    drawer.querySelector("[data-retry-change]")?.addEventListener("click", () => {
      changeFiles.delete(change.key);
      renderArtifactDrawer();
    });
    for (const node of drawer.querySelectorAll("[data-choose-file]"))
      node.addEventListener("click", () => openProjectFile(node.dataset.chooseFile, choosing?.line));
    for (const node of drawer.querySelectorAll("[data-pdf-page]"))
      node.addEventListener("click", () => {
        pdfPage.set(file.key, Number(node.dataset.pdfPage));
        renderArtifactDrawer();
      });
    drawer.querySelector("[data-download-diff]")?.addEventListener("click", () => {
      if (tab.kind === "change") {
        if (change?.status === "ready") downloadText(change.patch, `${fileBaseName(tab.path)}.diff`);
        return;
      }
      changeRequest()
        .then((result) => downloadText(result.diff.patch, "changes.diff"))
        .catch((error) => showToast(error.message));
    });
    drawer.querySelector("[data-close-drawer]")?.addEventListener("click", () => closeArtifactDrawer(true));
    drawer.querySelector("[data-open-artifact-viewer]")?.addEventListener("click", (event) => {
      event.preventDefault();
      void openArtifactViewer(urls.rawUrl).catch((error) => showToast(error.message));
    });
    drawer.querySelector("[data-retry-artifact]")?.addEventListener("click", () => {
      file.cache.delete(file.key);
      renderArtifactDrawer();
    });
    drawer.querySelector("[data-copy-drawer]")?.addEventListener("click", async () => {
      const preview = file.cache.get(file.key);
      if (!["text", "office"].includes(preview?.previewKind)) return;
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(preview.content);
        showToast(preview.truncated ? ui("已复制当前预览内容") : ui("文件内容已复制"));
        // eslint-disable-next-line no-restricted-syntax -- the browser refuses clipboard writes outside a secure context or without permission; the toast reports that copy is unavailable
      } catch {
        showToast(ui("当前环境不支持复制"));
      }
    });
    if (tab.kind === "attachment" && !cached) ensureArtifactLoaded(tab.path);
    if (tab.kind === "project" && !cached) ensureProjectLoaded(tab.path);
  }

  function renderArtifactDocument(preview, path, urls) {
    const media = renderArtifactMedia(preview, {
      name: fileBaseName(path),
      typeLabel: fileLanguage(path),
      ...urls
    });
    if (media !== null) return media;
    const text = preview.content;
    if (preview.previewKind === "office")
      return `<div class="artifact-code-wrap">${renderCodeEditor(text, path)}</div>`;
    const language = fileLanguage(path);
    if (language === "Markdown")
      return `<article class="artifact-markdown markdown-body">${renderMarkdown(text)}</article>`;
    let normalized = text;
    if (language === "JSON") {
      try {
        normalized = JSON.stringify(JSON.parse(text), null, 2);
        // eslint-disable-next-line no-restricted-syntax -- artifact content is user data and may not be valid JSON; the raw text is rendered instead
      } catch {
        /* keep malformed JSON readable */
      }
    }
    return `<div class="artifact-code-wrap">${renderCodeEditor(normalized, path)}</div>`;
  }

  function renderCodeEditor(content, path) {
    const text = String(content ?? "");
    const lines = text.split("\n");
    const lineMarkup = lines
      .map(
        (line, index) =>
          `<div class="code-line"><span class="line-number">${index + 1}</span><code>${esc(line) || " "}</code></div>`
      )
      .join("");
    return `<div class="code-editor" data-language="${esc(fileLanguage(path))}">${lineMarkup}</div>`;
  }

  return {
    fileTarget,
    canOpenReference,
    openFileReference,
    openProjectFile,
    fileBaseName,
    artifactSource,
    openArtifact,
    downloadArtifact,
    closeArtifactDrawer,
    ensureArtifactLoaded,
    renderArtifactDrawer,
    openPreview,
    resetMedia() {
      mediaUrls.clear();
      changeFiles.clear();
      changeViews.clear();
      projectCache.clear();
      pdfPages.clear();
      openWith.clear();
    }
  };
}
