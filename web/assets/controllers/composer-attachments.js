import { ui } from "../ui/language.js";
import { icon } from "../ui/icons.js";
import { escapeHtml as esc } from "../ui/html.js";
import { formatArtifactSize } from "../artifacts.js";
import { createComposerClipboard } from "./composer-clipboard.js";
import { createFileUpload } from "./file-upload.js";
import { installAttachmentPreview } from "./attachment-preview.js";

export function createComposerAttachments({
  $,
  state,
  api,
  upload,
  mediaUrl,
  session,
  updateSendButton,
  showToast
}) {
  let readingAttachments = false;

  function renderAttachments() {
    const strip = $("#attachment-strip");
    if (!strip) return;
    strip.innerHTML = state.attachments
      .map(
        (file, index) =>
          ui`<span class="attachment-chip"><span class="attachment-chip-icon">${icon(file.kind === "image" ? "image" : "paperclip")}</span>${file.uploadId ? ui`<button type="button" class="attachment-name" data-upload-preview="${esc(file.uploadId)}" title="预览 ${esc(file.name)}">${esc(file.name)}</button>` : `<span class="attachment-name">${esc(file.name)}</span>`}<small>${esc(formatArtifactSize(file.size ?? new TextEncoder().encode(file.text || "").length))}</small><button data-remove-attachment="${index}" aria-label="移除 ${esc(file.name)}">${icon("close")}</button></span>`
      )
      .join("");
    strip.hidden = state.attachments.length === 0;
    strip.querySelectorAll("[data-remove-attachment]").forEach((node) =>
      node.addEventListener("click", () => {
        state.attachments.splice(Number(node.dataset.removeAttachment), 1);
        renderAttachments();
        session().save();
        updateSendButton();
      })
    );
  }

  function clearAttachments() {
    state.attachments = [];
    const input = $("#file-input");
    if (input) input.value = "";
    renderAttachments();
  }

  const attachmentPreview = installAttachmentPreview({ api, mediaUrl });
  const fileUpload = createFileUpload({
    upload: (file, options) => upload(file, options),
    getDraftIdentity: () => session().shownDraftIdentity,
    getFiles: () => state.attachments,
    setFiles: (files) => {
      state.attachments = files;
      renderAttachments();
      session().save();
      updateSendButton();
    },
    onBusy: (busy) => {
      readingAttachments = busy;
      updateSendButton();
    },
    onError: showToast,
    onStatus: (status) => {
      const panel = $("#upload-status");
      panel.hidden = !status;
      panel.innerHTML = !status
        ? ""
        : status.failed
          ? ui`<span>${status.failed} 个文件未添加</span><button type="button" data-upload-retry>重试</button><button type="button" data-upload-cancel>关闭</button>`
          : ui`<span>${esc(status.name)} · ${status.progress}% (${status.index}/${status.total})</span><button type="button" data-upload-cancel>取消</button>`;
      panel
        .querySelector("[data-upload-retry]")
        ?.addEventListener("click", () => fileUpload.retry().catch((error) => showToast(error.message)));
      panel.querySelector("[data-upload-cancel]")?.addEventListener("click", () => fileUpload.cancel());
    }
  });
  async function addFiles(files) {
    try {
      await fileUpload.add(Array.from(files));
    } catch (error) {
      showToast(error.message);
    }
  }
  $(".attach-button").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    void addFiles(files);
  });
  createComposerClipboard({
    input: $("#composer-input"),
    addFiles,
    attachedNames: () => state.attachments.map((file) => file.name)
  });
  window.addEventListener("dragover", (event) => {
    if (Array.from(event.dataTransfer?.types || []).includes("Files")) event.preventDefault();
  });
  $(".composer").addEventListener("dragover", (event) => {
    if (Array.from(event.dataTransfer?.types || []).includes("Files")) {
      $(".composer").classList.add("is-file-drop");
      event.preventDefault();
    }
  });
  $(".composer").addEventListener("dragleave", (event) => {
    if (!$(".composer").contains(event.relatedTarget)) $(".composer").classList.remove("is-file-drop");
  });
  $(".composer").addEventListener("drop", (event) => {
    const files = event.dataTransfer?.files;
    if (files?.length) {
      event.preventDefault();
      event.stopPropagation();
      $(".composer").classList.remove("is-file-drop");
      void addFiles(files);
    }
  });

  window.addEventListener("drop", (event) => {
    if (event.dataTransfer?.files?.length) {
      event.preventDefault();
      showToast(ui("请将文件拖入对话输入区；当前内容已保留。"));
    }
  });

  function setDraft(files) {
    // A kept upload still owns the busy state: sending and closing stay blocked
    // until it ends, so only a navigation that retires it releases them here.
    if (fileUpload.retireUnlessShownDraft()) readingAttachments = false;
    attachmentPreview.close({ restoreFocus: false });
    state.attachments = files;
    renderAttachments();
  }
  return {
    setDraft,
    clear: clearAttachments,
    get busy() {
      return readingAttachments;
    }
  };
}
