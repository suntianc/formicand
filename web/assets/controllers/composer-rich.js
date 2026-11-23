import { escapeHtml as esc } from "../ui/html.js";
import { findReferenceSpans, renderReferenceChip } from "../references.js";
import { clipboardHtmlText } from "./composer-clipboard.js";

const NBSP = /\u00a0/g;
const ZWS = /\u200b/g;
const BLOCK_TAGS = new Set(["DIV", "P"]);

function cleanText(value) {
  return String(value || "")
    .replace(NBSP, " ")
    .replace(ZWS, "");
}

/** Canonical text serialized from the rich editor (chips return their `/skill` or `@path` token). */
export function serializeRichNode(root) {
  let out = "";
  const visit = (node) => {
    if (node.nodeType === 3) {
      out += cleanText(node.nodeValue);
      return;
    }
    if (node.nodeType !== 1) return;
    const token = node.dataset?.refToken;
    if (token) {
      out += token;
      return;
    }
    if (node.tagName === "BR") {
      if (node.dataset?.sentinel !== "true") out += "\n";
      return;
    }
    const isBlock = node !== root && BLOCK_TAGS.has(node.tagName);
    if (isBlock && out && !out.endsWith("\n")) out += "\n";
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return out;
}

/** Logical character offset corresponding to a DOM `(container, offset)` point inside `root`. */
function logicalOffsetAt(root, targetNode, targetOffset) {
  let count = 0;
  let found = false;
  const walk = (node) => {
    if (found) return;
    if (node === targetNode) {
      if (node.nodeType === 3) {
        count += cleanText(node.nodeValue.slice(0, targetOffset)).length;
        found = true;
        return;
      }
      if (node.nodeType === 1 && node.dataset?.refToken) {
        count += targetOffset > 0 ? node.dataset.refToken.length : 0;
        found = true;
        return;
      }
      const limit = Math.min(targetOffset, node.childNodes.length);
      for (let i = 0; i < limit; i += 1) walk(node.childNodes[i]);
      found = true;
      return;
    }
    if (node.nodeType === 3) {
      count += cleanText(node.nodeValue).length;
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.dataset?.refToken) {
      if (node.contains(targetNode)) {
        count += node.dataset.refToken.length;
        found = true;
        return;
      }
      count += node.dataset.refToken.length;
      return;
    }
    if (node.tagName === "BR") {
      if (node.dataset?.sentinel !== "true") count += 1;
      return;
    }
    const isBlock = node !== root && BLOCK_TAGS.has(node.tagName);
    if (isBlock && count > 0) count += 1;
    for (const child of node.childNodes) {
      walk(child);
      if (found) return;
    }
  };
  walk(root);
  return count;
}

/** Resolve a logical character offset into a safe DOM `(node, offset)` outside atomic chips. */
function domPointForOffset(root, target) {
  let remaining = Math.max(0, target);
  const children = Array.from(root.childNodes);
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child.nodeType === 3) {
      const len = cleanText(child.nodeValue).length;
      if (remaining <= len) return { node: child, offset: Math.min(remaining, child.nodeValue.length) };
      remaining -= len;
    } else if (child.nodeType === 1 && child.dataset?.refToken) {
      const len = child.dataset.refToken.length;
      if (remaining === 0) return { node: root, offset: i };
      if (remaining <= len) {
        const next = children[i + 1];
        if (next && next.nodeType === 3) return { node: next, offset: 0 };
        return { node: root, offset: i + 1 };
      }
      remaining -= len;
    } else if (child.nodeType === 1 && child.tagName === "BR") {
      if (child.dataset?.sentinel === "true") return { node: root, offset: i };
      if (remaining === 0) return { node: root, offset: i };
      remaining -= 1;
    }
  }
  const last = children[children.length - 1];
  if (last && last.nodeType === 1 && last.dataset?.sentinel === "true") {
    return { node: root, offset: children.length - 1 };
  }
  return { node: root, offset: children.length };
}

/**
 * Dual-mode composer surface.
 *
 * Plain drafts keep the native `<textarea id="composer-input">` untouched so
 * layout recovery, placeholder rules, IME and every existing textarea consumer
 * keep working natively. Once a draft contains resolved `/` or `@` references,
 * a sibling `contenteditable` editor renders each reference as an atomic inline
 * icon + name chip while keeping `input.value` canonically synchronized.
 */
export function createComposerRichEditor({
  input,
  references,
  resourceNames,
  onTriggerUpdate,
  onKeydown,
  onBlur
}) {
  const doc = input.ownerDocument;
  const field = doc.createElement("div");
  field.className = "composer-field";
  input.before(field);

  const rich = doc.createElement("div");
  rich.className = "composer-rich";
  rich.setAttribute("role", "textbox");
  rich.setAttribute("aria-multiline", "true");
  rich.setAttribute("aria-label", input.getAttribute("aria-label") || "");
  rich.setAttribute("spellcheck", "true");
  rich.contentEditable = input.readOnly ? "false" : "true";
  rich.hidden = true;
  field.append(rich, input);

  const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  const readOnlyDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "readOnly");

  let active = false;
  let composing = false;
  let syncingFromRich = false;
  let lastRenderedSignature = "";
  let lastCaret;
  let frame = 0;

  const rawGet = () => valueDescriptor.get.call(input);
  const rawSet = (next) => valueDescriptor.set.call(input, next);

  function syncEditableState() {
    const ro = Boolean(readOnlyDescriptor.get.call(input));
    rich.contentEditable = ro ? "false" : "true";
    const label = input.getAttribute("aria-label");
    if (label) rich.setAttribute("aria-label", label);
  }

  function activeSelection() {
    if (!active) {
      return { start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 };
    }
    const sel = doc.defaultView?.getSelection?.();
    if (!sel || !sel.rangeCount || !rich.contains(sel.anchorNode)) {
      const len = rawGet().length;
      return { start: len, end: len };
    }
    const range = sel.getRangeAt(0);
    return {
      start: logicalOffsetAt(rich, range.startContainer, range.startOffset),
      end: logicalOffsetAt(rich, range.endContainer, range.endOffset)
    };
  }

  function applySelection(start, end = start) {
    lastCaret = end;
    if (!active) {
      input.setSelectionRange(start, end);
      return;
    }
    const sel = doc.defaultView?.getSelection?.();
    if (!sel) return;
    const a = domPointForOffset(rich, start);
    const b = start === end ? a : domPointForOffset(rich, end);
    const range = doc.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function buildRichHtml(text, spans) {
    const parts = [];
    const appendPlain = (slice) => {
      if (!slice) return;
      const lines = slice.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (i > 0) parts.push("<br>");
        if (lines[i]) parts.push(esc(lines[i]));
      }
    };
    let at = 0;
    for (const span of spans) {
      appendPlain(text.slice(at, span.start));
      parts.push(renderReferenceChip(span.reference, esc, { editable: true, resourceNames }));
      at = span.end;
    }
    appendPlain(text.slice(at));
    if (text.endsWith("\n")) parts.push('<br data-sentinel="true">');
    return parts.join("");
  }

  function reconcile({ preserveCaret = false, activeTokenAt, focus = false, forceCaret } = {}) {
    frame = 0;
    if (composing) return;
    syncEditableState();
    const text = rawGet();
    const found = text ? references(text) : [];
    let spans = found.length ? findReferenceSpans(text, found) : [];
    if (activeTokenAt !== undefined && spans.length) {
      // Never freeze a token into an atomic chip while the caret is still editing inside it.
      spans = spans.filter((span) => activeTokenAt < span.start || activeTokenAt > span.end);
    }

    const shouldBeActive = spans.length > 0;
    const wasFocused = doc.activeElement === input || doc.activeElement === rich;
    const caret =
      forceCaret !== undefined ? forceCaret : preserveCaret || wasFocused ? activeSelection().end : undefined;

    if (!shouldBeActive) {
      if (active) {
        active = false;
        lastRenderedSignature = "";
        rich.hidden = true;
        rich.innerHTML = "";
        input.classList.remove("has-references");
        input.removeAttribute("tabindex");
        if (focus || wasFocused) {
          input.focus({ preventScroll: true });
          const pos = caret ?? text.length;
          input.setSelectionRange(pos, pos);
        }
      }
      return;
    }

    const signature = `${text}\u0000${spans.map((s) => `${s.start}:${s.end}:${s.reference.kind}`).join(",")}`;
    const switchingOn = !active;
    active = true;
    input.classList.add("has-references");
    input.setAttribute("tabindex", "-1");
    rich.hidden = false;

    if (switchingOn || signature !== lastRenderedSignature) {
      rich.innerHTML = buildRichHtml(text, spans);
      lastRenderedSignature = signature;
      if (focus || wasFocused || preserveCaret) {
        if (doc.activeElement !== rich) rich.focus({ preventScroll: true });
        const pos = caret ?? text.length;
        applySelection(pos, pos);
      }
    } else if (focus) {
      if (doc.activeElement !== rich) rich.focus({ preventScroll: true });
      if (forceCaret !== undefined) applySelection(forceCaret, forceCaret);
    }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(() => reconcile({ preserveCaret: true }));
  }

  function syncFromRichInput({ allowUpgrade = true } = {}) {
    if (composing || !active) return;
    const sel = activeSelection();
    lastCaret = sel.end;
    const text = serializeRichNode(rich);
    syncingFromRich = true;
    rawSet(text);
    syncingFromRich = false;

    const found = text ? references(text) : [];
    const spans = found.length ? findReferenceSpans(text, found) : [];
    const committed = allowUpgrade
      ? spans.filter((span) => sel.end < span.start || sel.end > span.end)
      : spans;
    const domTokens = Array.from(rich.querySelectorAll("[data-ref-token]")).map((el) => el.dataset.refToken);
    const desiredTokens = committed.map((span) => span.token);
    const tokensChanged =
      domTokens.length !== desiredTokens.length || domTokens.some((tok, idx) => tok !== desiredTokens[idx]);

    if (!committed.length) {
      reconcile({ focus: true, forceCaret: sel.end });
    } else if (tokensChanged) {
      reconcile({ preserveCaret: true, activeTokenAt: sel.end, forceCaret: sel.end });
    } else {
      lastRenderedSignature = `${text}\u0000${committed.map((s) => `${s.start}:${s.end}:${s.reference.kind}`).join(",")}`;
    }

    input.dispatchEvent(new Event("input", { bubbles: true }));
    onTriggerUpdate?.();
  }

  function replaceRange(start, end, insertText, { focus = true, commitAll = true } = {}) {
    const current = rawGet();
    const next = current.slice(0, start) + insertText + current.slice(end);
    const caret = start + insertText.length;
    syncingFromRich = true;
    rawSet(next);
    syncingFromRich = false;
    reconcile({ focus, forceCaret: caret, activeTokenAt: commitAll ? undefined : caret });
    if (!active) {
      if (focus) input.focus({ preventScroll: true });
      input.setSelectionRange(caret, caret);
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    onTriggerUpdate?.();
  }

  function deleteAdjacentChip(direction) {
    const sel = activeSelection();
    if (sel.start !== sel.end) return false;
    const text = rawGet();
    const spans = findReferenceSpans(text, references(text));
    if (!spans.length) return false;

    if (direction === "backward") {
      // One Backspace right after a chip (or its single trailing space) removes the whole chip.
      for (const span of spans) {
        if (sel.start === span.end || (sel.start === span.end + 1 && text[span.end] === " ")) {
          replaceRange(span.start, sel.start, "", { focus: true, commitAll: false });
          return true;
        }
      }
      return false;
    }

    for (const span of spans) {
      if (sel.start === span.start) {
        const end = text[span.end] === " " ? span.end + 1 : span.end;
        replaceRange(span.start, end, "", { focus: true, commitAll: false });
        return true;
      }
    }
    return false;
  }

  function stepAcrossChip(direction) {
    const sel = activeSelection();
    if (sel.start !== sel.end) return false;
    const text = rawGet();
    const spans = findReferenceSpans(text, references(text));
    for (const span of spans) {
      if (direction === "left" && sel.start === span.end) {
        applySelection(span.start, span.start);
        return true;
      }
      if (direction === "right" && sel.start === span.start) {
        applySelection(span.end, span.end);
        return true;
      }
    }
    return false;
  }

  function selectedCanonicalText() {
    const sel = activeSelection();
    return rawGet().slice(Math.min(sel.start, sel.end), Math.max(sel.start, sel.end));
  }

  // Intercept programmatic `input.value = ...` writes (draft restore, clear, edit).
  Object.defineProperty(input, "value", {
    configurable: true,
    get() {
      return rawGet();
    },
    set(next) {
      rawSet(next);
      if (!syncingFromRich) {
        lastCaret = String(next ?? "").length;
        reconcile({ preserveCaret: doc.activeElement === rich, forceCaret: lastCaret });
      }
    }
  });

  Object.defineProperty(input, "readOnly", {
    configurable: true,
    get() {
      return readOnlyDescriptor.get.call(input);
    },
    set(next) {
      readOnlyDescriptor.set.call(input, next);
      syncEditableState();
    }
  });

  input.addEventListener("input", () => {
    if (syncingFromRich) return;
    const pos = input.selectionEnd ?? rawGet().length;
    lastCaret = pos;
    reconcile({ preserveCaret: true, activeTokenAt: pos, forceCaret: pos });
  });

  // Programmatic `$("#composer-input").focus()` redirects to the visible rich surface when active.
  input.addEventListener("focus", () => {
    if (!active) return;
    const target = Math.min(lastCaret ?? rawGet().length, rawGet().length);
    rich.focus({ preventScroll: true });
    applySelection(target, target);
  });

  doc.addEventListener("selectionchange", () => {
    if (!active || doc.activeElement !== rich) return;
    lastCaret = activeSelection().end;
  });

  rich.addEventListener("compositionstart", () => {
    composing = true;
  });
  rich.addEventListener("compositionend", () => {
    composing = false;
    syncFromRichInput({ allowUpgrade: true });
  });

  rich.addEventListener("beforeinput", () => {
    if (input.classList.contains("is-sent")) {
      input.value = "";
    }
  });

  rich.addEventListener("input", () => {
    syncFromRichInput({ allowUpgrade: true });
  });

  rich.addEventListener("keydown", (event) => {
    if (onKeydown?.(event)) return;
    if (event.isComposing || composing) return;

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          bubbles: true,
          cancelable: true
        })
      );
      return;
    }

    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      const sel = activeSelection();
      replaceRange(sel.start, sel.end, "\n", { focus: true, commitAll: false });
      return;
    }

    if (event.key === "Backspace" && !event.altKey && !event.metaKey && !event.ctrlKey) {
      if (deleteAdjacentChip("backward")) event.preventDefault();
      return;
    }

    if (event.key === "Delete" && !event.altKey && !event.metaKey && !event.ctrlKey) {
      if (deleteAdjacentChip("forward")) event.preventDefault();
      return;
    }

    if (event.key === "ArrowLeft" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      if (stepAcrossChip("left")) {
        event.preventDefault();
        onTriggerUpdate?.();
      }
      return;
    }

    if (event.key === "ArrowRight" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      if (stepAcrossChip("right")) {
        event.preventDefault();
        onTriggerUpdate?.();
      }
    }
  });

  // Clicking on a chip places the caret cleanly before or after it instead of trapping selection.
  rich.addEventListener("mousedown", (event) => {
    const chip = event.target.closest?.("[data-ref-token]");
    if (!chip || !rich.contains(chip)) return;
    event.preventDefault();
    const rect = chip.getBoundingClientRect();
    const after = event.clientX >= rect.left + rect.width / 2;
    const text = rawGet();
    const beforeOffset = logicalOffsetAt(rich, chip, 0);
    const tokenLen = chip.dataset.refToken.length;
    const target = after ? Math.min(beforeOffset + tokenLen, text.length) : beforeOffset;
    rich.focus({ preventScroll: true });
    applySelection(target, target);
    onTriggerUpdate?.();
  });

  rich.addEventListener("click", () => {
    onTriggerUpdate?.();
  });

  rich.addEventListener("blur", () => {
    onBlur?.();
  });

  rich.addEventListener("paste", (event) => {
    if (event.defaultPrevented) return;
    const plain = event.clipboardData?.getData("text/plain");
    const text = plain || clipboardHtmlText(event.clipboardData?.getData("text/html"), doc);
    if (text) {
      event.preventDefault();
      const sel = activeSelection();
      replaceRange(sel.start, sel.end, text, { focus: true, commitAll: false });
    }
    // Image-only pastes intentionally stay unprevented so composer-clipboard can attach them.
  });

  rich.addEventListener("copy", (event) => {
    const text = selectedCanonicalText();
    if (!text) return;
    event.preventDefault();
    event.clipboardData?.setData("text/plain", text);
  });

  rich.addEventListener("cut", (event) => {
    const sel = activeSelection();
    if (sel.start === sel.end) return;
    const text = selectedCanonicalText();
    event.preventDefault();
    event.clipboardData?.setData("text/plain", text);
    replaceRange(Math.min(sel.start, sel.end), Math.max(sel.start, sel.end), "", {
      focus: true,
      commitAll: false
    });
  });

  return {
    element: rich,
    get active() {
      return active;
    },
    getValue: () => rawGet(),
    getSelection: activeSelection,
    setSelection: applySelection,
    replaceRange,
    refresh: schedule,
    syncNow: () => reconcile({ preserveCaret: true })
  };
}
