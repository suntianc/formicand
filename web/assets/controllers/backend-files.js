import { createManagedMedia } from "./managed-media.js";

export function createBackendFiles(management, showToast) {
  /**
   * Backend files shown as images or iframes.
   *
   * A page may be managing another local backend, where a bare `<img src="/api/…">`
   * would reach the wrong origin without the session. Fetch the bytes through the
   * shared client and hand the DOM one object URL per path.
   */
  const managedMedia = createManagedMedia({
    read: (path) => management.blob(path),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url)
  });
  function mediaObjectUrl(path) {
    return managedMedia.get(path);
  }
  function clear() {
    managedMedia.clear();
  }

  function hydrateImages(root) {
    for (const image of root.querySelectorAll("img[data-upload-src]")) {
      if (image.dataset.uploadLoaded) continue;
      image.dataset.uploadLoaded = "1";
      const id = image.dataset.uploadSrc;
      void mediaObjectUrl(`/api/uploads/${encodeURIComponent(id)}`)
        .then((href) => {
          image.src = href;
        })
        // eslint-disable-next-line no-restricted-syntax -- a failed media read leaves this one upload image unloaded, and the transcript keeps rendering
        .catch(() => undefined);
    }
  }

  /**
   * A download that needs the management client addresses one backend file.
   *
   * Only root-relative `/api/` paths are backend files. A `blob:`/`data:` URL or
   * any other link was produced locally (the Markdown export builds a blob) or
   * belongs to someone else; rerouting it would ask the backend for a path it
   * never served. The client marks its own synthetic anchor so this listener
   * never intercepts the click it just created.
   */
  function isBackendDownload(href) {
    return typeof href === "string" && href.startsWith("/api/");
  }

  document.addEventListener(
    "click",
    (event) => {
      const link = event.target.closest?.("a[download]");
      if (!link || link.dataset.managedDownload) return;
      const href = link.getAttribute("href");
      if (!isBackendDownload(href)) return;
      // The bytes belong to the bound backend; a plain navigation would carry
      // neither the session nor the right origin.
      event.preventDefault();
      void management.download(href, link.getAttribute("download") || undefined).catch((error) => {
        showToast(error.message);
      });
    },
    true
  );

  return { mediaUrl: mediaObjectUrl, clear, hydrateImages };
}
