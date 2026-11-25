const PAGE_SIZE = 12;

// Keep the server projection separate from SSE additions. On navigation the old
// projection is released; only the selected task owns a scrollback window.
export function createConversationPages() {
  let metadata, revision;
  let saved,
    limit = PAGE_SIZE;
  function reset() {
    saved = undefined;
    metadata = undefined;
    revision = undefined;
    limit = PAGE_SIZE;
  }
  function header(taskId, incremental) {
    const p = saved?.taskId === taskId && saved.page;
    if (!p || !incremental) return String(limit);
    return [
      limit,
      p.limit,
      p.stamp || "-",
      p.messageCount,
      p.eventCount,
      p.digest,
      Math.max(0, Math.floor(p.oldestTime || 0)),
      /^[a-zA-Z0-9._-]{1,256}$/.test(p.oldestRun ?? "") ? p.oldestRun : "-"
    ].join(";");
  }
  function adopt(taskId, detail) {
    const patch = detail.metadataPatch;
    if (patch) {
      const {
        messages,
        runtimeEvents,
        contextWindows,
        events,
        historyPage,
        metadataPatch: _patch,
        ...changes
      } = detail;
      metadata = patch.base ? { ...metadata, ...changes } : changes;
      for (const key of patch.removed) delete metadata[key];
      revision = patch.revision;
      detail = { ...metadata, messages, runtimeEvents, contextWindows, events, historyPage };
    }
    const p = detail.historyPage;
    if (!p) {
      reset();
      return detail;
    }
    const previous = saved;
    if (p.mode === "unchanged") {
      detail.historyPage = previous.page;
      detail.messages = previous.messages;
      detail.runtimeEvents = previous.records;
      detail.contextWindows = previous.windows;
      detail.events = previous.events;
    } else {
      if (p.mode === "prepend" || p.mode === "append") {
        const prepend = p.mode === "prepend";
        detail.messages = prepend
          ? [...detail.messages, ...previous.messages]
          : [...previous.messages, ...detail.messages];
        detail.runtimeEvents = prepend
          ? [...detail.runtimeEvents, ...previous.records]
          : [...previous.records, ...detail.runtimeEvents];
      }
      saved = {
        taskId,
        page: p,
        messages: detail.messages,
        records: detail.runtimeEvents,
        events: detail.events,
        windows: detail.contextWindows
      };
    }
    return detail;
  }
  return {
    reset,
    headers(taskId, incremental) {
      return {
        "x-formicand-history": header(taskId, incremental),
        ...(incremental && saved?.taskId === taskId && revision
          ? { "x-formicand-detail-revision": revision }
          : {})
      };
    },
    adopt,
    expand() {
      limit = saved.page.limit + PAGE_SIZE;
    },
    get savedCount() {
      return saved?.records.length ?? 0;
    }
  };
}

export function bindConversationScrollback(scroll, button, state, loadEarlier) {
  let last = scroll.scrollTop,
    loading = false;
  const update = () => {
    button.hidden = !(
      state.selected &&
      state.detail?.task?.taskId === state.selected &&
      state.detail.historyPage?.hasMore &&
      scroll.scrollTop <= 96
    );
  };
  async function load() {
    if (loading || button.hidden) return;
    loading = true;
    button.disabled = true;
    try {
      await loadEarlier();
    } finally {
      loading = false;
      button.disabled = false;
      update();
    }
  }
  scroll.addEventListener(
    "scroll",
    () => {
      const up = scroll.scrollTop < last;
      last = scroll.scrollTop;
      update();
      if (up && !button.hidden) void load();
    },
    { passive: true }
  );
  button.addEventListener("click", () => void load());
  return update;
}

/** Capture immediately before painting, so scrolling during the network request is respected. */
export function historyScrollAnchor(scroll) {
  const top = scroll.getBoundingClientRect().top;
  const marker = Array.from(scroll.children).find(
    (el) => el.dataset.historyMessage && el.getBoundingClientRect().bottom > top
  );
  const height = scroll.scrollHeight,
    position = scroll.scrollTop;
  const key = marker?.dataset.historyMessage,
    offset = marker?.getBoundingClientRect().top;
  return () => {
    const node = key && Array.from(scroll.children).find((el) => el.dataset.historyMessage === key);
    if (node) scroll.scrollTop += node.getBoundingClientRect().top - offset;
    else scroll.scrollTop = position + scroll.scrollHeight - height;
  };
}

export function latestSavedUser(messages) {
  const u = messages?.findLast((m) => m.role === "user");
  return u ? JSON.stringify(u.id ?? u.timestamp ?? u.content) : "";
}
