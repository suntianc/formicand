import { formatRunDuration, runElapsed } from "../run-overview.js";
import { requestErrorMessage } from "../request-error.js";
import { runPhase } from "../run-phase.js";
import { ui } from "../ui/language.js";

/**
 * The status line above the composer.
 *
 * It names only the round's coarse state and how long it has run: Main 工作中,
 * Main 在等子助手 · N 个在工作, Main 在问你, 模型重连中, 已暂停. What exactly
 * is happening is the transcript's to say. It disappears when nothing runs.
 * With a question or queued messages it is the first row of the tray they
 * share on the composer's top edge.
 *
 * While Main works its one action is stop (Esc); while it waits for its
 * Subagents the composer stays a send box, so pause and stop sit here. Pause
 * asks the backend to stop at the next step boundary; the button stays
 * disabled until that boundary is recorded. A paused round offers 继续.
 * Stop acts at once: finished steps and results stay, so there is nothing to
 * confirm.
 */
export function createRunControl({
  state,
  $,
  api,
  showToast,
  onChanged,
  interruptRun,
  continueRun,
  isContinuing
}) {
  const root = $("#run-control");
  const pauseButton = root?.querySelector("[data-run-pause]");
  const stopButton = root?.querySelector("[data-run-stop]");
  const continueButton = root?.querySelector("[data-run-continue]");
  const label = root?.querySelector("[data-run-label]");
  const detail = root?.querySelector("[data-run-detail]");
  const time = root?.querySelector("[data-run-time]");
  let ticker;
  let busy = false;

  const selectedTask = () =>
    state.detail?.task?.taskId === state.selected
      ? state.detail.task
      : state.tasks.find((task) => task.taskId === state.selected);
  /** The selected conversation's coarse state; Subagent progress is part of the catalog row. */
  const phase = () =>
    runPhase({
      task: selectedTask(),
      detail: state.detail,
      agents: state.tasks.find((task) => task.taskId === state.selected)?.activity?.agents || []
    });

  const stopTicker = () => {
    if (ticker === undefined) return;
    clearInterval(ticker);
    ticker = undefined;
  };
  const startTicker = () => {
    if (ticker !== undefined) return;
    ticker = setInterval(renderTime, 1000);
  };
  function renderTime() {
    if (!root || root.hidden) return;
    const elapsed = runElapsed(state.detail?.statistics);
    time.textContent = Number.isFinite(elapsed) ? `· ${formatRunDuration(elapsed)}` : "";
  }

  async function pause() {
    const task = selectedTask();
    if (busy || !task || task.taskId !== state.selected || task.pause) return;
    busy = true;
    pauseButton.disabled = true;
    pauseButton.setAttribute("aria-busy", "true");
    try {
      await api(`/api/tasks/${encodeURIComponent(task.taskId)}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pause" })
      });
      await onChanged?.(task.taskId);
    } catch (error) {
      showToast(requestErrorMessage(error));
    } finally {
      busy = false;
      pauseButton.removeAttribute("aria-busy");
      render();
    }
  }

  async function interrupt() {
    const task = selectedTask();
    if (!task || task.taskId !== state.selected) return;
    await interruptRun?.(task.taskId);
  }

  const LABELS = {
    working: () => ui("Main 工作中"),
    pausing: () => ui("正在暂停"),
    waiting: (current) =>
      current.agents
        ? ui`Main 在等子助手 · ${current.agents} 个在工作`
        : current.parked
          ? ui("等待唤醒")
          : ui("Main 在等子助手"),
    asking: () => ui("Main 在问你"),
    retrying: () => ui("模型重连中"),
    // Main paused its Subagents before itself; the line says so by name.
    paused: (current) =>
      current.names?.length ? ui`已暂停 · ${current.names.join(ui("、"))} 也已暂停` : ui("已暂停")
  };

  function render() {
    if (!root) return;
    const task = selectedTask();
    const current = phase();
    if (!current) {
      root.hidden = true;
      delete root.dataset.state;
      root.removeAttribute("data-run-paused");
      stopTicker();
      return;
    }
    const paused = current.kind === "paused";
    root.hidden = false;
    root.dataset.state = current.kind;
    root.toggleAttribute("data-run-paused", paused);
    const name = LABELS[current.kind](current);
    label.textContent = name;
    detail.hidden = true;
    root.setAttribute("aria-label", name);
    renderTime();
    if (paused) stopTicker();
    else startTicker();
    continueButton.hidden = !paused;
    if (paused) {
      pauseButton.hidden = true;
      stopButton.hidden = true;
      continueButton.disabled = Boolean(isContinuing?.(task.taskId));
      return;
    }
    // Waiting for Subagents leaves the composer a send box, so stop is a
    // button here; while Main works the composer's own key stops it (Esc).
    const waiting = current.kind === "waiting";
    const resting = current.parked && !state.detail.runtime.active && !current.agents;
    stopButton.hidden = current.kind === "asking" || resting;
    stopButton.classList.toggle("is-hint", !waiting);
    stopButton.querySelector("[data-run-stop-key]").hidden = waiting;
    pauseButton.hidden = current.kind === "asking" || (resting && !state.detail.runtime.mainRunning);
    const pausing = current.kind === "pausing";
    pauseButton.disabled = busy || pausing;
    pauseButton.title = pausing ? ui("当前步骤结束后暂停") : ui("暂停，当前步骤结束后生效");
    pauseButton.setAttribute("aria-label", pausing ? ui("暂停中") : ui("暂停"));
  }

  pauseButton?.addEventListener("click", () => void pause());
  stopButton?.addEventListener("click", () => void interrupt());
  continueButton?.addEventListener("click", async () => {
    const task = selectedTask();
    if (!task) return;
    continueButton.disabled = true;
    await continueRun?.(task.taskId);
    render();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // Esc stops a working Main from the composer or the page itself, never
    // from inside a menu, dialog or field that has its own Escape.
    const focus = document.activeElement;
    const fromComposer =
      !focus ||
      focus === document.body ||
      focus.id === "composer-input" ||
      focus.classList?.contains("composer-rich");
    const kind = phase()?.kind;
    if (
      !fromComposer ||
      !root ||
      root.hidden ||
      stopButton.hidden ||
      !["working", "retrying", "waiting"].includes(kind)
    )
      return;
    if (document.querySelector('[role="dialog"]:not([hidden]), [role="menu"]:not([hidden])')) return;
    event.preventDefault();
    void interrupt();
  });

  return {
    render,
    interrupt,
    /** Whether Main is waiting on its Subagents rather than working itself. */
    waiting: () => phase()?.kind === "waiting",
    reset() {
      stopTicker();
    }
  };
}
