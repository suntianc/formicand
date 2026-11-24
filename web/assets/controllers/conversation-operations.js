import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../ui/html.js";
import { createModal } from "../ui/modal.js";

/** The context menu and row quick actions; each keeps the conversation it was opened for. */
export function createConversationOperations({
  readState,
  onReadChange,
  titleFor,
  api,
  refresh,
  getNavigation,
  openNewConversation,
  stop,
  showToast,
  confirmDelete = (task) => window.confirm(ui`确定删除“${titleFor(task)}”吗？删除后无法恢复。`)
}) {
  async function mutateConversation(taskId, options, leaveConversation = false) {
    const { token } = getNavigation();
    await api(`/api/tasks/${encodeURIComponent(taskId)}`, options);
    if (leaveConversation) {
      const current = getNavigation();
      if (current.taskId === taskId && current.token === token) openNewConversation();
    }
    await refresh({ poll: options.method === "PATCH", afterMutation: true });
  }

  function updateConversation(patch, taskId) {
    return mutateConversation(
      taskId,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      },
      patch.archived
    );
  }

  function renameConversation(task) {
    const panel = document.createElement("div");
    panel.className = "modal-backdrop app-dialog-backdrop";
    panel.hidden = true;
    panel.innerHTML = ui`<section class="modal-card app-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-conversation-title"><h2 id="rename-conversation-title">重命名会话</h2><form novalidate><label class="dialog-field">会话名称<input name="title" maxlength="100" required autocomplete="off" aria-describedby="rename-conversation-error" value="${esc(titleFor(task))}"></label><p class="dialog-error" role="alert" id="rename-conversation-error" hidden></p><div class="dialog-actions"><button class="app-button is-secondary" type="button" data-close>取消</button><button class="app-button is-primary" type="submit">保存</button></div></form></section>`;
    document.body.append(panel);
    const dialog = createModal(panel, panel.querySelector("[data-close]"), { onClose: () => panel.remove() });
    panel.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = panel.querySelector("[type=submit]");
      const input = panel.querySelector("input");
      const errorMessage = panel.querySelector("[role=alert]");
      input.removeAttribute("aria-invalid");
      errorMessage.hidden = true;
      errorMessage.textContent = "";
      if (!input.value.trim()) {
        errorMessage.textContent = ui("请输入会话名称");
        errorMessage.hidden = false;
        input.setAttribute("aria-invalid", "true");
        input.focus();
        return;
      }
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      try {
        await updateConversation({ title: input.value.trim() }, task.taskId);
        dialog.close();
      } catch (error) {
        errorMessage.textContent = error.message;
        errorMessage.hidden = false;
      } finally {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    });
    dialog.open();
    panel.querySelector("input").select();
  }

  return async (action, taskId, task) => {
    if (!task || task.taskId !== taskId) return;
    try {
      if (action === "rename") return renameConversation(task);
      if (action === "stop") return await stop(taskId);
      if (action === "delete") {
        if (!confirmDelete(task)) return;
        await mutateConversation(taskId, { method: "DELETE" }, true);
        showToast(ui("会话已删除"));
        return;
      }
      if (action === "pin" || action === "archive")
        return await updateConversation(
          action === "pin" ? { pinned: !task.pinned } : { archived: !task.archived },
          taskId
        );
      if (action === "unread") {
        const unread = !readState.isUnread(taskId);
        readState.setUnread(taskId, unread);
        onReadChange();
        showToast(unread ? ui("已标记为未读") : ui("已标记为已读"));
        return;
      }
    } catch (error) {
      showToast(error.message || ui("操作未完成，请重试"));
    }
  };
}
