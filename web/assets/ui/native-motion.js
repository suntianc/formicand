// Only independently drawable content can sit above a WebContents. Text,
// interactive surfaces and layout-dependent transitions stay in their DOM stack.
const drawings = {
  "ant-frames": "ant",
  "runs-head-pulse": "head",
  pulse: "halo",
  "ui-spin": "ring"
};

function colorReader() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const pen = canvas.getContext("2d", { willReadFrequently: true });
  const cache = new Map();
  return (value) => {
    if (cache.has(value)) return cache.get(value);
    pen.clearRect(0, 0, 1, 1);
    pen.fillStyle = value;
    pen.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = pen.getImageData(0, 0, 1, 1).data;
    const packed = ((r * 256 + g) * 256 + b) * 256 + a;
    if (cache.size > 64) cache.clear();
    cache.set(value, packed);
    return packed;
  };
}

function uncovered(host, rect, radius) {
  // The indent slot can also contain a transparent hit target for the chevron.
  const row = host.closest(".conversation-row");
  const cx = rect.x + rect.width / 2,
    cy = rect.y + rect.height / 2;
  const through = getComputedStyle(host).pointerEvents === "none";
  for (const [dx, dy] of [
    [0, 0],
    [-radius, 0],
    [radius, 0],
    [0, -radius],
    [0, radius]
  ]) {
    const hit = document.elementFromPoint(cx + dx, cy + dy);
    const indent =
      row &&
      (hit === row || hit?.closest(".conversation-toggle, .conversation-indent")?.parentElement === row);
    if (!hit || !(host.contains(hit) || indent || (through && hit === host.parentElement))) return false;
  }
  return true;
}

// Observe all painted pixels, including the halo, pulse overshoot and the wide
// axis of a turning ellipse. A shadow slot keeps the measuring box out of the
// conversation reconciler's children. It has no paint or pointer target.
const measuringRoots = new WeakMap();
function drawingArea(host, kind) {
  const inset = kind === "halo" ? "-6px" : kind === "head" ? "-6%" : null;
  const saving = host.matches(".ui-status > .action-spinner");
  if (!inset && !saving) return host;
  if (host.localName !== "span" && host.localName !== "formicand-spinner") return;
  let root = measuringRoots.get(host);
  if (!root) {
    root = host.attachShadow({ mode: "closed" });
    root.append(document.createElement("slot"));
    measuringRoots.set(host, root);
  }
  const area = document.createElement("span");
  area.setAttribute("aria-hidden", "true");
  area.style.cssText =
    "position:absolute;display:block;pointer-events:none;" +
    (saving
      ? "left:50%;top:50%;transform:translate(-50%,-50%);width:calc(var(--action-spinner-size) + 2 * var(--action-spinner-stroke));aspect-ratio:1"
      : "inset:" + inset);
  root.append(area);
  return area;
}

export function installNativeMotion(bridge, reducedMotion, onPreference) {
  if (!bridge) return;
  const color = colorReader();
  const candidates = new Map();
  const owners = new WeakMap();
  let nextId = 1;
  let active = new Set();
  let previous = "";
  let frame = 0;
  let scrolling = false;
  let timer;
  const schedule = () => {
    if (!frame && candidates.size) frame = requestAnimationFrame(refresh);
  };
  const resize = new ResizeObserver(schedule);
  const clips = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const item = candidates.get(owners.get(entry.target));
        if (item) {
          item.visible = entry.intersectionRatio > 0;
          item.unclipped = entry.intersectionRatio >= 0.999;
        }
      }
      schedule();
    },
    { threshold: [0, 0.999, 1] }
  );
  // Chromium's visual-occlusion check also sees drawings that ignore pointer events.
  const visibility = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const item = candidates.get(owners.get(entry.target));
        if (item) item.uncovered = entry.isVisible;
      }
      schedule();
    },
    { trackVisibility: true, delay: 100, threshold: [0, 1] }
  );
  const overlay = "dialog, [popover], [role=dialog], [role=menu], [role=tooltip], .modal-backdrop";
  const mutations = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "childList" && candidates.has(record.target)) return schedule();
      if (
        record.target.matches?.(overlay) ||
        (record.type === "attributes" && [...candidates.keys()].some((host) => record.target.contains(host)))
      )
        return schedule();
      if (
        record.type === "childList" &&
        [...record.addedNodes, ...record.removedNodes].some((node) => node.matches?.(overlay))
      )
        return schedule();
    }
  });
  const shift = new PerformanceObserver(schedule);

  function release(host) {
    const candidate = candidates.get(host);
    if (!candidate) return;
    clips.unobserve(candidate.area);
    resize.unobserve(host);
    visibility.unobserve(candidate.area);
    owners.delete(candidate.area);
    if (candidate.area !== host) candidate.area.remove();
    candidates.delete(host);
  }
  function exposeBusyIndicator(element, animation) {
    if (
      animation.effect.pseudoElement !== "::before" ||
      element.querySelector(":scope > .action-spinner") ||
      !element.matches(
        '.ui-status[data-state="saving"], .provider-dialog .app-button[aria-busy="true"], .app-dialog .dialog-actions button[aria-busy="true"]'
      )
    )
      return;
    // A real box lets the compositor measure the flex item without guessing the
    // position of a generated ::before relative to the button text.
    const indicator = document.createElement("formicand-spinner");
    indicator.className = "action-spinner";
    indicator.setAttribute("aria-hidden", "true");
    element.prepend(indicator);
  }
  function collect(animation, symbol) {
    const kind = symbol || drawings[animation.animationName];
    if (!kind || (!symbol && animation.effect.getTiming().iterations !== Infinity)) return;
    const element = animation.effect.target;
    if (!element) return;
    const host =
      symbol || kind === "ant" || element.matches(".project-progress-icon > .ui-icon")
        ? element.parentElement
        : element;
    const loader = element.matches(".project-progress-icon > .ui-icon");
    if (kind === "ring" && !loader && element.localName !== "formicand-spinner") {
      exposeBusyIndicator(element, animation);
      return;
    }
    const existing = candidates.get(host);
    if (existing?.animation === animation) return;
    if (existing) {
      if (existing.symbol && !existing.animation.effect.target)
        existing.animation.effect.target = existing.target;
      release(host);
      refresh();
    }
    const area = drawingArea(host, kind);
    if (!area) return;
    if (!candidates.size) {
      mutations.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
          "class",
          "style",
          "hidden",
          "open",
          "inert",
          "popover",
          "aria-expanded",
          "aria-hidden",
          "data-theme",
          "data-layout-animating"
        ]
      });
      shift.observe({ type: "layout-shift" });
    }
    owners.set(area, host);
    candidates.set(host, {
      area,
      kind: loader ? "loader" : kind,
      animation,
      target: element,
      symbol,

      id: nextId++,
      visible: false
    });
    clips.observe(area);
    resize.observe(host);
    visibility.observe(area);
    const done = () => {
      if (candidates.get(host)?.animation === animation) {
        release(host);
        refresh();
      }
    };
    animation.finished.then(done, done);
    schedule();
  }

  function describe(host, item, ancestors) {
    const { kind, animation, id } = item;
    if (
      !item.unclipped ||
      !item.uncovered ||
      !host.isConnected ||
      host.closest("[inert]") ||
      document.body.dataset.layoutAnimating
    )
      return;
    const rect = host.getBoundingClientRect();
    if (!item.symbol && kind === "ring" && item.area === host && Math.abs(rect.width - rect.height) > 0.1)
      return;
    const style = getComputedStyle(host);
    const size = kind === "loader" ? parseFloat(style.width) : rect.width;
    if (size < 1 || size > 96 || !Number.isFinite(size) || style.visibility !== "visible") return;
    for (let node = host.parentElement; node; node = node.parentElement) {
      let stable = ancestors.get(node);
      if (stable === undefined) {
        const ancestor = getComputedStyle(node);
        stable =
          ancestor.opacity === "1" &&
          (ancestor.transform === "none" || ancestor.transform.startsWith("matrix(1, 0, 0, 1,")) &&
          !node.getAnimations().some((a) => a.playState === "running" && a.effect.target === node);
        ancestors.set(node, stable);
      }
      if (!stable) return;
    }
    if (!uncovered(host, rect, Math.max(0, Math.min(rect.width, rect.height) / 2 - 0.6))) return;
    const timing = animation.effect.getComputedTiming();
    const paint = host.localName === "formicand-spinner" ? getComputedStyle(host, "::before") : style;
    const top = paint.borderTopColor !== paint.borderLeftColor;
    const stroke =
      item.symbol || kind === "loader"
        ? (size * parseFloat(getComputedStyle(item.target).strokeWidth)) / 24
        : kind === "ring"
          ? parseFloat(paint.borderLeftWidth)
          : 0;
    const localTime = (animation.currentTime || 0) - timing.delay;
    if (item.symbol && (localTime < 0 || localTime >= timing.activeDuration)) return;
    return {
      id,
      kind,
      x: rect.x + (rect.width - size) / 2,
      y: kind === "ring" ? rect.y : rect.y + (rect.height - size) / 2,
      size,
      ...(kind === "ring" ? { height: rect.height } : {}),
      stroke,
      duration: timing.duration / 1000,
      phase: item.symbol
        ? localTime / timing.duration
        : item.started !== undefined
          ? ((performance.now() - item.started) % timing.duration) / timing.duration
          : timing.progress || 0,
      color: color(
        kind === "ring"
          ? paint.borderLeftColor
          : kind === "head"
            ? getComputedStyle(host, "::before").backgroundColor
            : kind === "loader"
              ? getComputedStyle(item.target).color
              : style.color
      ),
      accent: color(top ? paint.borderTopColor : paint.borderRightColor),
      top
    };
  }

  function refresh() {
    cancelAnimationFrame(frame);
    frame = 0;
    const scene = [];
    const next = new Set();
    const ancestors = new Map();
    if (!document.hidden && !reducedMotion() && !scrolling) {
      for (const [host, item] of candidates) {
        if (scene.length === 64) break;
        const drawing = describe(host, item, ancestors);
        if (drawing) {
          next.add(host);
          scene.push(drawing);
        }
      }
    }
    // Phase matters when starting a layer, never as a reason to send another IPC.
    const stamp = devicePixelRatio + JSON.stringify(scene.map(({ phase: _phase, ...drawing }) => drawing));
    if (stamp !== previous && (scene.length || active.size)) {
      const ok = bridge.update(scene);
      previous = ok ? stamp : "";
      if (!ok) {
        if (active.size) bridge.update([]);
        next.clear();
      }
    }
    for (const host of active) {
      if (next.has(host)) continue;
      host.removeAttribute("data-native-motion");
      const item = candidates.get(host);
      if (item?.symbol) {
        item.animation.effect.target = item.target;
        continue;
      }
      if (item?.started !== undefined) {
        item.animation.currentTime = performance.now() - item.started;
        delete item.started;
      }
      if (item?.visible && !document.hidden && !reducedMotion()) item.animation.play();
    }
    for (const host of next) {
      if (active.has(host)) continue;
      const item = candidates.get(host);
      host.dataset.nativeMotion = item.kind;
      if (item.symbol) {
        // Keep the Web timing/finished/cancel contract without animating a DOM layer.
        item.animation.effect.target = null;
      } else {
        item.started = performance.now() - (item.animation.currentTime || 0);
        item.animation.pause();
      }
    }
    active = next;
    if (!candidates.size) {
      mutations.disconnect();
      shift.disconnect();
    }
  }

  document.addEventListener(
    "animationstart",
    ({ target, animationName, pseudoElement }) => {
      if (drawings[animationName]) {
        for (const animation of target.getAnimations({ subtree: Boolean(pseudoElement) })) collect(animation);
      }
      schedule();
    },
    true
  );
  for (const animation of document.getAnimations()) collect(animation);
  for (const name of [
    "animationend",
    "animationcancel",
    "transitionrun",
    "transitionend",
    "transitioncancel",
    "focusin",
    "focusout",
    "pointerover",
    "pointerout",
    "toggle"
  ]) {
    document.addEventListener(name, schedule, true);
  }
  document.addEventListener(
    "scroll",
    () => {
      if (!candidates.size) return;
      if (!scrolling) {
        scrolling = true;
        refresh();
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        scrolling = false;
        schedule();
      }, 100);
    },
    { capture: true, passive: true }
  );
  window.addEventListener("resize", schedule);
  document.addEventListener("visibilitychange", refresh);
  onPreference(refresh);
  bridge.onRefresh(() => {
    previous = "";
    schedule();
  });
  return (animation, symbol) => collect(animation, symbol);
}
