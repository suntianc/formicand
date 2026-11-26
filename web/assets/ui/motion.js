/** Shared playback for the browser and Electron renderer. */
const activeTransitions = new Set();
const STILL = Object.freeze({ finished: Promise.resolve(), cancel() {} });

export function reducedMotion() {
  const choice = globalThis.document?.documentElement.dataset.reducedMotion;
  if (choice === "reduce") return true;
  if (choice === "off") return false;
  return Boolean(globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

export function onMotionPreferenceChange(callback) {
  const media = globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)");
  let previous = reducedMotion();
  const update = () => {
    const next = reducedMotion();
    if (next === previous) return;
    previous = next;
    callback(next);
  };
  media?.addEventListener?.("change", update);
  const unsubscribe = globalThis.window?.formicandPreferences?.onChange?.(update);
  return () => {
    media?.removeEventListener?.("change", update);
    unsubscribe?.();
  };
}

/** Repeating CSS animations register on start, including pseudo-elements.
 * Watch their actual clipping ancestor when the drawing is a wide frame strip.
 * Animation.finished also settles on removal, even after the target detached. */
export function installMotion() {
  const loops = new Map();
  function syncLoop(animation, visible) {
    if (animation.playState === "idle" || animation.playState === "finished") return;
    if (visible && !document.hidden) animation.play();
    else animation.pause();
  }
  const viewport = new IntersectionObserver(
    (entries) => {
      for (const { target, intersectionRatio } of entries) {
        const visible = intersectionRatio > 0;
        if (target.localName === "formicand-spinner") {
          if (target.isConnected) target.toggleAttribute("data-in-viewport", visible);
        } else {
          const group = loops.get(target);
          if (!group) continue;
          group.visible = visible;
          for (const animation of group.animations) syncLoop(animation, visible);
        }
      }
    },
    { threshold: [0, 0.001] }
  );
  customElements.define(
    "formicand-spinner",
    class extends HTMLElement {
      connectedCallback() {
        viewport.observe(this);
      }
      disconnectedCallback() {
        viewport.unobserve(this);
        this.removeAttribute("data-in-viewport");
      }
    }
  );

  const watch = (animation) => {
    if (!animation.animationName || animation.effect.getTiming().iterations <= 1) return;
    const element = animation.effect.target;
    if (!element || element.localName === "formicand-spinner") return;
    const host = element.closest(".ant-mark") || element;
    let group = loops.get(host);
    if (!group) {
      group = { visible: false, animations: new Set() };
      loops.set(host, group);
      viewport.observe(host);
    }
    if (group.animations.has(animation)) return;
    group.animations.add(animation);
    syncLoop(animation, group.visible);
    const release = () => {
      group.animations.delete(animation);
      if (!group.animations.size) {
        viewport.unobserve(host);
        loops.delete(host);
      }
    };
    animation.finished.then(release, release);
  };
  document.addEventListener("animationstart", (event) => {
    const element = event.target;
    if (element.localName === "formicand-spinner") return;
    for (const animation of element.getAnimations({ subtree: Boolean(event.pseudoElement) })) {
      if (animation.animationName === event.animationName) watch(animation);
    }
  });
  for (const animation of document.getAnimations()) watch(animation);
  const settle = () => {
    for (const animation of activeTransitions) {
      if (animation.playState !== "idle") animation.finish();
    }
  };
  const syncPage = () => {
    document.documentElement.classList.toggle("is-page-hidden", document.hidden);
    if (document.hidden) settle();
    for (const group of loops.values()) {
      for (const animation of group.animations) syncLoop(animation, group.visible);
    }
  };
  syncPage();
  document.addEventListener("visibilitychange", syncPage);
  onMotionPreferenceChange((reduce) => {
    if (reduce) settle();
  });
}

const entrance = (transform) => [
  { opacity: 0, transform },
  { opacity: 1, transform: "none" }
];
const check = (start, opacity, peak) => [
  { transform: `scale(${start})`, opacity },
  { transform: `scale(${peak})`, opacity: 1, offset: 0.6 },
  { transform: "scale(1)" }
];
const effects = {
  fade: { duration: "fade", easing: "out", frames: [{ opacity: 0 }, { opacity: 1 }] },
  message: { duration: "arrival", frames: entrance("translateY(6px)") },
  dialog: { duration: "base", frames: entrance("translateY(6px) scale(0.97)") },
  usage: { duration: "base", frames: entrance("translateY(6px) scale(0.98)") },
  copied: { duration: "copy", easing: "out", frames: check(0.6, 0.4, 1.12) },
  checked: { duration: "check", easing: "out", frames: check(0.5, 0.3, 1.15), fill: "backwards" },
  fold: { duration: "base" },
  move: { duration: "layout" },
  selection: { duration: "glide", easing: "glide", fill: "both" },
  scrollShow: { duration: "fast", easing: "out" },
  scrollHide: { duration: "scroll-hide", easing: "out" }
};

/** Components supply measured geometry and logical order. Timing, curves and
 * reduced-motion completion are shared with the declarative CSS effects. */
export function playMotion(node, name, { frames, fill, order = 0, distance = 1 } = {}) {
  if (typeof node.animate !== "function" || document.hidden || reducedMotion()) return STILL;
  const effect = effects[name];
  const style = getComputedStyle(document.documentElement);
  const animation = node.animate(frames ?? effect.frames, {
    duration: motionDuration("--motion-" + effect.duration, 0, style) * distance,
    delay: order && motionDuration("--motion-stagger", 0, style) * order,
    easing: style.getPropertyValue("--ease-" + (effect.easing ?? "standard")).trim(),
    fill: fill ?? effect.fill ?? "none"
  });
  activeTransitions.add(animation);
  const release = () => activeTransitions.delete(animation);
  animation.finished.then(release, release);
  return animation;
}

/** Keep a keyed indicator's phase when a rendering replaces its DOM node.
 * Stable nodes keep advancing (or stay paused) on the browser timeline. */
export function rememberMotionPhase() {
  const entries = new Map();
  return {
    restore(nodes, keyOf) {
      const now = performance.now();
      for (const node of nodes) {
        const key = keyOf(node);
        const previous = entries.get(key);
        if (previous?.node === node) continue;
        const start = previous?.start ?? now;
        entries.set(key, { node, start });
        if (previous) {
          for (const animation of node.getAnimations?.({ subtree: true }) ?? [])
            animation.currentTime = now - start;
        }
      }
      for (const [key, entry] of entries) if (!entry.node.isConnected) entries.delete(key);
    },
    clear() {
      entries.clear();
    }
  };
}

/** A token's duration in milliseconds, so scripted motion keeps the CSS timing. */
function motionDuration(name, fallback, style = getComputedStyle(document.documentElement)) {
  const value = style.getPropertyValue(name).trim();
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return fallback;
  return value.endsWith("ms") ? number : number * 1000;
}

/**
 * Where a selection glides. `host` scopes the options and stays in the page
 * while its rows re-render; `item` is the selected option's visible surface;
 * `key` tells options apart across re-renders; `layer` is the stable ancestor
 * the moving surface is drawn in (the host unless its children are replaced
 * wholesale); `clip` skips the glide when either end is scrolled out of the
 * host.
 */
export const SELECTION_GROUPS = [
  {
    name: "segmented",
    host: ".ui-segmented, .settings-segmented",
    item: ':is(.ui-segmented, .settings-segmented) > :is([aria-selected="true"], [aria-checked="true"], [aria-pressed="true"])'
  },
  { name: "settings-nav", host: ".settings-nav-items", item: '.settings-nav-item[aria-current="page"]' },
  { name: "observe-views", host: ".observe-views", item: '.nav-item[aria-current="page"]' },
  {
    name: "observe-filter",
    host: ".observe-group",
    item: '.observe-item[aria-pressed="true"]',
    key: (node) => node.dataset.observeNode || node.dataset.observeProject || node.textContent
  },
  {
    name: "requirement-tabs",
    host: ".observe-tabs",
    item: '.or-tab[aria-selected="true"]',
    layer: (host) => host.parentElement,
    key: (node) => node.dataset.observeTab
  },
  {
    name: "conversations",
    host: "#project-list",
    item: ".conversation-row:has(> .conversation-item.active)",
    layer: (host) => host.parentElement,
    key: (node) => node.querySelector(".conversation-item")?.dataset.task,
    clip: true
  }
];

const TRIGGER_KEYS = new Set([
  "Enter",
  " ",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End"
]);
// A selection that follows a click may wait on a request before the row
// re-renders; past this the change is not the click's and appears in place.
const WATCH_MS = 900;
const COPIED = [
  "backgroundColor",
  "backgroundImage",
  "boxShadow",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomLeftRadius",
  "borderBottomRightRadius",
  "borderStyle",
  "borderWidth",
  "borderColor",
  "outlineStyle",
  "outlineWidth",
  "outlineColor",
  "outlineOffset"
];

const lerp = (from, to, share) => from + (to - from) * share;

/** The surface at a moment between two rects, its leading edge ahead of its trailing one. */
function stretched(from, to) {
  const axis = (start, end, size) => {
    const forward = to[start] + to[size] / 2 >= from[start] + from[size] / 2;
    const near = lerp(from[start], to[start], forward ? 0.3 : 0.8);
    const far = lerp(from[start] + from[size], to[start] + to[size], forward ? 0.8 : 0.3);
    return [near, Math.max(far - near, Math.min(from[size], to[size]))];
  };
  const [x, width] = axis("x", "x", "width");
  const [y, height] = axis("y", "y", "height");
  return { x, y, width, height };
}

const frame = ({ x, y, width, height }, origin) => ({
  transform: `translate(${x - origin.x}px, ${y - origin.y}px)`,
  width: `${width}px`,
  height: `${height}px`
});

const inside = (rect, bounds) =>
  rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1 && rect.height > 0;

/**
 * Moves the selected option's background to the next option instead of
 * letting it jump. Only a user's click or key starts a glide; selections the
 * page makes itself, and any selection under reduced motion, appear in place.
 * The real option keeps its own selected style; it is hidden only while the
 * moving copy is in flight, so a re-render in the middle never loses it.
 */
export function installSelectionGlide({ root = document, groups = SELECTION_GROUPS } = {}) {
  const style = document.createElement("style");
  style.dataset.selectionGlide = "";
  style.textContent = groups
    .map(
      (group) =>
        `[data-gliding~="${group.name}"] :is(${group.item}) { background: transparent !important; box-shadow: none !important; border-color: transparent !important; outline-color: transparent !important; transition: none !important; }`
    )
    .join("\n");
  document.head.append(style);
  const flights = new Map();
  const pending = new Map();
  const keyOf = (group, node) => (group.key ? group.key(node) : node);
  const selected = (group, host) =>
    [...host.querySelectorAll(group.item)].find((node) => node.closest(group.host) === host);

  function settle(host, group) {
    const flight = flights.get(host);
    if (!flight) return;
    flights.delete(host);
    flight.ghost.remove();
    const names = (host.dataset.gliding || "").split(" ").filter((name) => name && name !== group.name);
    if (names.length) host.dataset.gliding = names.join(" ");
    else delete host.dataset.gliding;
  }

  function glide(group, host, from, target) {
    const layer = group.layer?.(host) || host;
    const to = target.getBoundingClientRect();
    if (group.clip) {
      const bounds = host.getBoundingClientRect();
      if (!inside(from, bounds) || !inside(to, bounds)) return;
    }
    if (!to.width || !to.height || (from.x === to.x && from.y === to.y)) return;
    const look = getComputedStyle(target);
    const ghost = document.createElement("div");
    ghost.className = "selection-glide";
    ghost.setAttribute("aria-hidden", "true");
    for (const property of COPIED) ghost.style[property] = look[property];
    layer.prepend(ghost);
    const origin = ghost.getBoundingClientRect();
    host.dataset.gliding = [host.dataset.gliding, group.name].filter(Boolean).join(" ");
    const animation = playMotion(ghost, "selection", {
      frames: [frame(from, origin), frame(stretched(from, to), origin), frame(to, origin)]
    });
    flights.set(host, { ghost, animation, group });
    const done = () => {
      if (flights.get(host)?.animation === animation) settle(host, group);
    };
    animation.finished.then(done, done);
  }

  function watch(group, host) {
    pending.get(host)?.();
    const flight = flights.get(host);
    const current = selected(group, host);
    // A second choice mid-flight starts where the moving surface is now.
    const from = flight ? flight.ghost.getBoundingClientRect() : current?.getBoundingClientRect();
    if (!from || !current) return;
    const before = keyOf(group, current);
    // Watch only the active group while waiting for its selection to change.
    const observer = new MutationObserver(() => {
      if (!host.isConnected || document.hidden || reducedMotion()) return stop();
      const next = selected(group, host);
      if (!next || keyOf(group, next) === before) return;
      stop();
      if (flights.has(host)) {
        flights.get(host).animation.cancel();
        settle(host, group);
      }
      glide(group, host, from, next);
    });
    const stop = () => {
      observer.disconnect();
      clearTimeout(timeout);
      pending.delete(host);
    };
    const timeout = setTimeout(stop, WATCH_MS);
    pending.set(host, stop);
    observer.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "aria-selected", "aria-checked", "aria-pressed", "aria-current"]
    });
  }

  const start = (event) => {
    if (event.type === "keydown" && !TRIGGER_KEYS.has(event.key)) return;
    if (event.type === "pointerdown" && event.button !== 0) return;
    if (reducedMotion() || !event.target?.closest) return;
    for (const group of groups) {
      const host = event.target.closest(group.host);
      if (host) watch(group, host);
    }
  };
  root.addEventListener("pointerdown", start, true);
  root.addEventListener("keydown", start, true);
  return {
    destroy() {
      root.removeEventListener("pointerdown", start, true);
      root.removeEventListener("keydown", start, true);
      for (const stop of pending.values()) stop();
      for (const [host, { animation, group }] of flights) {
        animation.cancel();
        settle(host, group);
      }
      style.remove();
    }
  };
}

let layoutTimer;
/**
 * Runs a change that opens or closes the sidebar or the side panel (`part`)
 * with the grid easing between its columns. The columns only animate inside
 * this window, so a divider being dragged or a window being resized still
 * follows at once.
 */
export function animateLayout(change, { part, body = document.body } = {}) {
  if (reducedMotion()) {
    change();
    window.dispatchEvent(new Event("resize"));
    return;
  }
  clearTimeout(layoutTimer);
  body.dataset.layoutAnimating = part;
  change();
  layoutTimer = setTimeout(
    () => {
      delete body.dataset.layoutAnimating;
      window.dispatchEvent(new Event("resize"));
    },
    motionDuration("--motion-layout", 240) + 40
  );
}
