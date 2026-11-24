/**
 * Web link chips read the linked page's icon and title through the backend,
 * which fetches each page once and keeps what it read on disk.
 *
 * Markdown rendering asks `linkPreview(url)` synchronously, so a chip that was
 * read once renders complete on every later pass. `hydrateLinkPreviews(roots)`
 * finds chips still missing their preview, reads each address once at a time
 * limit, and fills every chip for that address in place.
 */

const previews = new Map();
const queued = new Set();
const waiting = [];
let reader;
let active = 0;
const CONCURRENCY = 4;

/** What was read for `url`, or undefined while it is unknown. */
export function linkPreview(url) {
  return previews.get(url);
}

/** Installs the function that reads one preview: `(url) => Promise<{ title, icon }>`. */
export function configureLinkPreviews(read) {
  reader = read;
}

function apply(chip, preview) {
  chip.dataset.previewState = "done";
  if (preview.icon) {
    const mark = chip.querySelector(".link-chip-mark");
    if (mark && !mark.querySelector("img")) {
      const image = document.createElement("img");
      image.className = "link-chip-favicon";
      image.alt = "";
      image.width = 14;
      image.height = 14;
      image.decoding = "async";
      image.src = preview.icon;
      mark.replaceChildren(image);
    }
  }
  if (chip.hasAttribute("data-link-bare") && preview.title) {
    const title = chip.querySelector(".link-chip-title");
    if (title) title.textContent = preview.title;
    if (!chip.querySelector(".link-chip-host")) {
      const host = document.createElement("span");
      host.className = "link-chip-host";
      host.textContent = new URL(chip.dataset.linkPreview).hostname.replace(/^www\./, "");
      title?.after(host);
    }
  }
}

function pump() {
  while (active < CONCURRENCY && waiting.length) {
    const url = waiting.shift();
    active += 1;
    reader(url)
      .then(
        (preview) => {
          previews.set(url, { title: preview?.title || "", icon: preview?.icon || "" });
        },
        // An address that cannot be read keeps its globe and address.
        () => previews.set(url, { title: "", icon: "" })
      )
      .finally(() => {
        active -= 1;
        queued.delete(url);
        const preview = previews.get(url);
        for (const chip of document.querySelectorAll(`a.link-chip[data-link-preview="${CSS.escape(url)}"]`))
          apply(chip, preview);
        pump();
      });
  }
}

/** Fills the chips under `roots` from what is known and reads what is not. */
export function hydrateLinkPreviews(roots) {
  if (!reader) return;
  for (const root of roots) {
    if (!root?.querySelectorAll) continue;
    for (const chip of root.querySelectorAll("a.link-chip[data-link-preview]:not([data-preview-state])")) {
      const url = chip.dataset.linkPreview;
      const known = previews.get(url);
      if (known) {
        apply(chip, known);
        continue;
      }
      chip.dataset.previewState = "loading";
      if (queued.has(url)) continue;
      queued.add(url);
      waiting.push(url);
    }
  }
  pump();
}
