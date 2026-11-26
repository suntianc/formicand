const path = require("node:path");
const { existsSync } = require("node:fs");
const binary = path.join(__dirname, "../dist/desktop/motion.node");
const sprite = path.join(__dirname, "../web/assets/brand/working-ant-20fps.png");
const finite = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const kinds = new Set(["ring", "ant", "head", "halo", "loader", "checked", "copied"]);
const color = (value) => Number.isInteger(value) && finite(value, 0, 0xffffffff);

function validMotionScene(scene) {
  if (!Array.isArray(scene) || scene.length > 64) return false;
  const ids = new Set();
  for (const item of scene) {
    if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || ids.has(item.id)) return false;
    ids.add(item.id);
    if (item.kind === "ring" && item.height !== undefined && !finite(item.height, 1, 96)) return false;
    if (!(
      kinds.has(item.kind) &&
      finite(item.x, -128, 32000) &&
      finite(item.y, -128, 32000) &&
      finite(item.size, 1, 96) &&
      finite(
        item.stroke,
        0,
        Math.min(item.size, item.kind === "ring" ? (item.height ?? item.size) : item.size) / 2
      ) &&
      finite(item.duration, 0.05, 30) &&
      finite(item.phase, 0, 1) &&
      color(item.color) &&
      color(item.accent) &&
      typeof item.top === "boolean"
    ))
      return false;
  }
  return true;
}

function loadMotion() {
  if (process.platform !== "darwin" || !existsSync(binary)) return;
  try {
    return require(binary);
  } catch (error) {
    console.warn("Desktop motion unavailable:", error.message);
  }
}

function installDesktopMotion(ipc, getWindow, trust) {
  const native = loadMotion();
  ipc.on("formicand:motion", (event, scene) => {
    let accepted = false;
    try {
      trust(event);
      const win = getWindow();
      if (!native || !validMotionScene(scene) || !win.isVisible() || win.isMinimized()) return;
      const zoom = win.webContents.getZoomFactor();
      const items = scene.map(
        ({ id, kind, x, y, size, stroke, duration, phase, color, accent, top, height }) => ({
          id,
          kind,
          ...(kind === "halo" ? { spread: 3 * zoom } : {}),
          ...(kind === "ring" && height !== undefined ? { height: height * zoom } : {}),
          x: x * zoom,
          y: y * zoom,
          size: size * zoom,
          stroke: stroke * zoom,
          duration,
          phase,
          color,
          accent,
          top
        })
      );
      accepted = native.update(win.getNativeWindowHandle(), JSON.stringify(items), sprite);
    } catch (error) {
      console.warn("Desktop motion rejected:", error.message);
    } finally {
      event.returnValue = accepted;
    }
  });
  return {
    supported: Boolean(native),
    follow(win) {
      if (!native) return;
      const clear = () => {
        if (!win.isDestroyed()) native.update(win.getNativeWindowHandle(), "[]", sprite);
      };
      win.on("hide", clear);
      win.on("minimize", clear);
      win.webContents.on("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument) clear();
      });
      win.webContents.on("render-process-gone", clear);
      for (const event of ["show", "restore"]) {
        win.on(event, () => win.webContents.send("formicand:motion-refresh"));
      }
    }
  };
}
module.exports = { installDesktopMotion, validMotionScene };
