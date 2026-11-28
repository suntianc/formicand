const { randomUUID } = require("node:crypto");
const { appendFile } = require("node:fs/promises");
const { join } = require("node:path");
const { performance } = require("node:perf_hooks");

const copy = {
  en: {
    loading: "Connecting to the local service…",
    log: "Show startup log",
    failed: "Unable to connect to the local service",
    retry: "Retry",
    quit: "Quit"
  },
  "zh-CN": {
    loading: "正在连接本地服务…",
    log: "查看启动日志",
    failed: "无法连接本地服务",
    retry: "重试",
    quit: "退出"
  }
};
// Fixed diagnostic text only: a backend error can contain paths, session data or a log tail.
const reasons = {
  access_denied: [
    "检查当前用户对应用数据目录的读写权限。",
    "Check access to the application data directory."
  ],
  storage_full: ["释放数据目录所在磁盘的空间。", "Free space on the disk containing the application data."],
  missing_file: [
    "检查安装文件及数据目录是否完整。",
    "Check the installation files and application data directory."
  ],
  backend_conflict: [
    "检查同一数据目录是否已有服务正在启动或退出。",
    "Check for another service starting or stopping in this data directory."
  ],
  lock_timeout: [
    "数据目录的服务锁仍被占用。请检查正在启动或退出的实例。",
    "The lifecycle lock is busy. Check for another instance starting or stopping."
  ],
  startup_timeout: [
    "后端未及时就绪。查看同目录 backend.log 的末尾。",
    "The service timed out. Check the end of backend.log in the same directory."
  ],
  backend_exited: [
    "后端进程启动失败。查看同目录 backend.log 的末尾。",
    "The service exited during startup. Check the end of backend.log in the same directory."
  ],
  credential_store: [
    "检查系统密钥存储及其访问权限。",
    "Check the system credential store and its permissions."
  ],
  instance_record: [
    "检查数据目录中的后端实例记录与服务状态。",
    "Check the backend instance record and service status in the data directory."
  ],
  navigation: [
    "服务已就绪。检查随包页面资源并重试连接。",
    "The service is ready. Check the bundled web assets and retry."
  ],
  connecting: [
    "按启动日志中的最后阶段检查本地服务连接。",
    "Check the last connection stage in the startup log."
  ]
};
function startupFailureReason(error, stage) {
  switch (error?.code ?? error?.cause?.code) {
    case "EACCES":
    case "EPERM":
      return "access_denied";
    case "ENOSPC":
      return "storage_full";
    case "ERR_MODULE_NOT_FOUND":
    case "MODULE_NOT_FOUND":
    case "ENOENT":
      return "missing_file";
    case "EADDRINUSE":
      return "backend_conflict";
    case "client_credential_unreadable":
      return "credential_store";
  }
  if (error?.name === "BackendInstanceConflict") return "backend_conflict";
  const message = String(error?.message ?? "");
  if (message.startsWith("timed out acquiring file lock:")) return "lock_timeout";
  if (message.startsWith("后端启动超时")) return "startup_timeout";
  if (/^后端(?:启动失败|进程未能启动)/u.test(message)) return "backend_exited";
  if (/^(?:系统密钥存储|客户端凭据|保存的客户端凭据)/u.test(message)) return "credential_store";
  if (/^(?:本地服务的实例记录|后端身份|后端地址)/u.test(message)) return "instance_record";
  return stage === "renderer_connect" ? "navigation" : "connecting";
}

const logLink = "https://startup.invalid/log";

/** A separate sandboxed view leaves dashboard navigation and its trusted preload untouched. */
function showStartupView({ window, WebContentsView, labels, openLog }) {
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false }
  });
  const contents = view.webContents;
  const resize = () => {
    const [width, height] = window.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  const close = () => {
    window.removeListener("resize", resize);
    window.removeListener("closed", close);
    if (!window.isDestroyed()) window.contentView.removeChildView(view);
    if (!contents.isDestroyed()) contents.close();
  };
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => {
    event.preventDefault();
    if (event.url === logLink) openLog();
  });
  window.contentView.addChildView(view);
  resize();
  window.on("resize", resize);
  window.once("closed", close);
  const html = `<!doctype html><html lang="${labels === copy.en ? "en" : "zh-CN"}"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"><style>:root{color-scheme:light dark;font:menu}body{min-height:100vh;margin:0;display:grid;place-content:center;text-align:center}a{color:LinkText}</style><p role="status">${labels.loading}</p><a href="${logLink}">${labels.log}</a></html>`;
  void contents.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html)).catch((error) => {
    if (!contents.isDestroyed() && error.code !== "ERR_ABORTED")
      console.warn("Could not show startup status", error.code);
  });
  return close;
}

/** One attempt, including a reuse of a running backend, has its own timeline. */
function createStartupTrace(file) {
  const id = randomUUID();
  const start = performance.now();
  let previous = start;
  let writes = Promise.resolve();
  let lastStage;
  function mark(stage, reason) {
    if (stage !== "slow_start") lastStage = stage;
    const now = performance.now();
    const record = {
      at: new Date().toISOString(),
      attempt: id,
      stage,
      ...(reason ? { reason } : {}),
      elapsedMs: Math.round(now - start),
      stageMs: Math.round(now - previous),
      ...(stage === "window_ready" ? { processUptimeMs: Math.round(process.uptime() * 1000) } : {})
    };
    previous = now;
    writes = writes
      .then(() => appendFile(file, JSON.stringify(record) + "\n", { mode: 0o600 }))
      .catch((error) => {
        console.warn("Could not write startup timing", error.code);
      });
  }
  return { id, mark, lastStage: () => lastStage, flush: () => writes };
}

async function launchWithFeedback({
  launch,
  window,
  logs,
  language,
  openLog,
  showFailure,
  showLoading,
  cancelled,
  delayMs = 1500
}) {
  const file = join(logs, "desktop-startup.jsonl");
  const labels = copy[language] ?? copy["zh-CN"];
  while (!cancelled() && !window.isDestroyed()) {
    const trace = createStartupTrace(file);
    trace.mark("window_ready");
    let dismiss;
    const timer = setTimeout(() => {
      if (window.isDestroyed() || cancelled()) return;
      trace.mark("slow_start");
      dismiss = showLoading({ window, labels, openLog: () => openLog(file) });
    }, delayMs);
    let failureReason;
    try {
      await launch(trace);
    } catch (error) {
      failureReason = startupFailureReason(error, trace.lastStage());
      trace.mark("startup_failed", failureReason);
      console.error("Local backend connection failed", failureReason);
    } finally {
      clearTimeout(timer);
      dismiss?.();
      await trace.flush();
    }
    if (!failureReason || cancelled() || window.isDestroyed()) return;
    for (;;) {
      const choice = await showFailure(window, {
        type: "error",
        message: labels.failed,
        detail: reasons[failureReason][labels === copy.en ? 1 : 0] + " (" + failureReason + ")",
        buttons: [labels.retry, labels.log, labels.quit],
        defaultId: 0,
        cancelId: 2
      });
      if (choice.response === 0) break;
      if (choice.response === 2) return "quit";
      openLog(file);
    }
  }
}

module.exports = { launchWithFeedback, showStartupView };
