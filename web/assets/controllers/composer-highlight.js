import { escapeHtml as esc } from "../ui/html.js";
import { markReferences } from "../references.js";

/** The textarea styles the layer copies, so its words wrap exactly where the draft's do. */
const MIRRORED = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariantNumeric",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textIndent",
  "tabSize",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth"
];

/**
 * Marks the `/skill` and `@path` words of a draft as tags. A textarea draws
 * plain text only, so a layer under it repeats the draft with the referenced
 * words marked, and the textarea's own text turns transparent while the
 * draft has any; the caret, selection and typing stay the textarea's.
 */
export function createComposerHighlight({ input, references }) {
  const layer = document.createElement("div");
  layer.className = "composer-highlight";
  layer.setAttribute("aria-hidden", "true");
  layer.hidden = true;
  input.before(layer);
  let frame = 0;

  function paint() {
    frame = 0;
    const text = input.value;
    const found = text ? references(text) : [];
    const on = found.length > 0;
    input.classList.toggle("has-references", on);
    layer.hidden = !on;
    if (!on) return;
    const style = getComputedStyle(input);
    for (const name of MIRRORED) layer.style[name] = style[name];
    const scrollbar =
      input.offsetWidth -
      input.clientWidth -
      parseFloat(style.borderLeftWidth) -
      parseFloat(style.borderRightWidth);
    layer.style.top = `${input.offsetTop}px`;
    layer.style.left = `${input.offsetLeft}px`;
    layer.style.width = `${input.offsetWidth - scrollbar}px`;
    layer.style.height = `${input.offsetHeight}px`;
    // A trailing newline in a textarea opens a line; the layer needs a character to show it.
    layer.innerHTML = `${markReferences(text, found, esc)}\u200b`;
    layer.scrollTop = input.scrollTop;
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(paint);
  }

  // Drafts are also restored, cleared and edited by code, which fires no input event.
  const value = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  Object.defineProperty(input, "value", {
    configurable: true,
    get() {
      return value.get.call(this);
    },
    set(next) {
      value.set.call(this, next);
      schedule();
    }
  });
  input.addEventListener("input", schedule);
  input.addEventListener("scroll", () => {
    layer.scrollTop = input.scrollTop;
  });
  new ResizeObserver(schedule).observe(input);

  return { refresh: schedule };
}
