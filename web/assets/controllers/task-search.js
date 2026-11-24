import { ui } from "../ui/language.js";
import { icon } from "../ui/icons.js";
import { createModal } from "../ui/modal.js";
import { formatStamp } from "../ui/time-format.js";
import { escapeHtml as esc } from "../ui/html.js";
import { conversationTitle, taskGoalText } from "./work-title.js";

const statusLabel = {
  created: ui("已创建"),
  idle: ui("空闲中"),
  running: ui("工作中"),
  paused: ui("已暂停"),
  waiting: ui("等待中"),
  completed: ui("已完成"),
  failed: ui("失败"),
  cancelled: ui("已取消"),
  queued: ui("排队中"),
  leased: ui("工作中"),
  succeeded: ui("已完成"),
  timed_out: ui("超时"),
  recorded: ui("已记录"),
  interrupted: ui("已结束")
};
const stateText = (value) => statusLabel[value] || value || ui("未知");

function shortDate(value) {
  return formatStamp(value, window.atriaPreferences?.format() ?? "relative");
}

export function createTaskSearch({ $, tasks, selectConversation }) {
  let taskSearchDialog;
  return function openTaskSearch() {
    let overlay = $("#task-search");
    if (overlay && !overlay.hidden) return taskSearchDialog.close();
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "task-search";
      overlay.className = "search-overlay";
      overlay.hidden = true;
      overlay.innerHTML = ui`<section class="search-dialog" role="dialog" aria-modal="true" aria-label="搜索对话" aria-describedby="task-search-hint"><div class="search-dialog-head">${icon("search")}<input id="task-search-input" aria-label="搜索对话" placeholder="按名称或任务内容搜索…" autocomplete="off"/><button type="button" aria-label="关闭搜索">Esc</button></div><div id="task-search-results" aria-label="匹配的对话"></div><footer class="search-dialog-foot"><span id="task-search-hint">↑ ↓ 选择 · Enter 打开</span><span id="task-search-count" role="status"></span></footer></section>`;
      document.body.appendChild(overlay);
      taskSearchDialog = createModal(overlay, overlay.querySelector("button"));
      const input = overlay.querySelector("input");
      const results = overlay.querySelector("#task-search-results");
      const draw = () => {
        const query = input.value.trim().toLowerCase();
        const matches = tasks().filter((task) =>
          `${task.title || ""} ${taskGoalText(task.goal)} ${task.taskId}`.toLowerCase().includes(query)
        );
        results.innerHTML = matches.length
          ? matches
              .slice(0, 12)
              .map(
                (task) =>
                  `<button type="button" class="search-result" data-task="${esc(task.taskId)}" title="${esc(conversationTitle(task))}"><strong>${esc(conversationTitle(task))}${task.archived ? ui(" · 已归档") : ""}</strong><small>${esc(stateText(task.status))} · ${esc(shortDate(task.updatedAt))}</small></button>`
              )
              .join("")
          : ui('<div class="search-no-results">没有匹配的对话，试试其他关键词</div>');
        overlay.querySelector("#task-search-count").textContent =
          matches.length > 12 ? ui`显示前 12 项，共 ${matches.length} 项` : ui`${matches.length} 个对话`;
        results.querySelectorAll("[data-task]").forEach((node) =>
          node.addEventListener("click", () => {
            document.body.classList.remove("sidebar-mobile-open");
            taskSearchDialog.close();
            selectConversation(node.dataset.task);
          })
        );
      };
      input.addEventListener("input", draw);
      overlay.addEventListener("keydown", (event) => {
        if (event.isComposing) return;
        const choices = [...results.querySelectorAll("[data-task]")];
        const index = choices.indexOf(document.activeElement);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const next =
            event.key === "ArrowDown"
              ? (index + 1) % choices.length
              : index <= 0
                ? choices.length - 1
                : index - 1;
          choices[next]?.focus();
        } else if (event.key === "Home" && index >= 0) {
          event.preventDefault();
          choices[0]?.focus();
        } else if (event.key === "End" && index >= 0) {
          event.preventDefault();
          choices.at(-1)?.focus();
        } else if (event.key === "Enter" && event.target === input) {
          event.preventDefault();
          choices[0]?.click();
        }
      });
      overlay.drawResults = draw;
    }
    overlay.querySelector("input").value = "";
    overlay.drawResults();
    taskSearchDialog.open();
  };
}
