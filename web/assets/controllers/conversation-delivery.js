import { latestSavedUser } from "./conversation-pages.js";
import { ui } from "../ui/language.js";
import { composePrompt } from "../attachments.js";
import { requestErrorMessage } from "../request-error.js";
import { renderMessageQueue } from "../message-queue.js";
import { uploadedFileIds } from "./file-upload.js";

export function createConversationDelivery({
  $,
  state,
  api,
  composerSession,
  composerModel,
  composerMenu,
  attachments,
  messageEdit,
  firstUse,
  createTask,
  connectEventStream,
  renderAll,
  refresh,
  loadDetail,
  isBackendReady,
  waiting,
  openModelSettings,
  showToast
}) {
  const sending = new Map();
  const stoppingTasks = new Set();
  const continuingTasks = new Set();
  const stopEpochs = new Map();
  const promotingMessages = new Set();

  /**
   * Interrupt the turn Main is producing.
   *
   * The session, its Subagents and everything already done stay; the process
   * waits for the next message.
   */
  /** Stop the round: Main's turn and its working Subagents, all at once; the session stays. */
  async function stopRound(taskId = state.selected) {
    if (!taskId || isTaskStopping(taskId)) return;
    stopEpochs.set(taskId, (stopEpochs.get(taskId) || 0) + 1);
    stoppingTasks.add(taskId);
    updateSendButton();
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "stop" })
      });
      await refresh();
      showToast(ui("已停止，做完的步骤和结果保留"));
    } catch (error) {
      showToast(requestErrorMessage(error));
    } finally {
      stoppingTasks.delete(taskId);
      updateSendButton();
    }
  }
  /** Close the session: it stops the running turn and the Subagents it started. */
  async function stopTask(taskId = state.selected) {
    if (!taskId || isTaskStopping(taskId)) return;
    stopEpochs.set(taskId, (stopEpochs.get(taskId) || 0) + 1);
    stoppingTasks.add(taskId);
    updateSendButton();
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel" })
      });
      await refresh();
      showToast(ui("会话已关闭，已保存的内容保留"));
    } catch (error) {
      showToast(requestErrorMessage(error));
    } finally {
      stoppingTasks.delete(taskId);
      updateSendButton();
    }
  }
  $("#send-button").addEventListener("click", () => void sendMessage());
  $("#composer-input").addEventListener("input", updateSendButton);
  $("#composer-input").addEventListener("keydown", (event) => {
    // Enter sends like a desktop chat client; Shift+Enter keeps the textarea multiline.
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      // While Main runs, Enter inserts the message into its next step and ⌥Enter
      // queues it until the current round ends.
      void sendMessage({ queue: event.altKey });
    }
  });
  /** Send to the running task's steering or follow-up queue, preserving draft ownership. */
  async function interject(taskId, text, delivery = "followUp", references = []) {
    const draft = submissionDraft();
    const stopEpoch = stopEpochs.get(taskId) || 0;
    const model = composerModel.model || composerModel.defaultModel || undefined;
    const savedUsers = (state.detail?.messages || []).filter((message) => message.role === "user").length;
    const submission = beginSubmission(taskId);
    submission.draft = draft;
    updateSendButton();
    try {
      let result;
      try {
        result = await api(`/api/tasks/${encodeURIComponent(taskId)}/interject`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: text,
            delivery,
            attachmentIds: uploadedFileIds(JSON.parse(draft.attachments)),
            ...(references.length ? { references } : {})
          })
        });
      } catch (error) {
        // A finished turn accepts the original complete message as a new run.
        // Neither navigation nor further typing may change its destination/input.
        if (error.status !== 409 || !/没有正在运行/.test(error.message)) throw error;
        // An explicit stop supersedes this request, even after cancellation settles.
        if (isTaskStopping(taskId) || (stopEpochs.get(taskId) || 0) !== stopEpoch) {
          showToast(ui("补充内容未发送，草稿已保留"));
          return;
        }
        await launchPrompt(taskId, text, {
          submission,
          model,
          profileId: composerModel.profileId || undefined,
          thinkingLevel: composerModel.sentThinkingLevel(),
          resume: false,
          savedUsers,
          attachmentIds: uploadedFileIds(JSON.parse(draft.attachments)),
          references
        });
        clearSubmittedDraft(taskId, draft);
        await refresh();
        return;
      }
      clearSubmittedDraft(taskId, draft);
      if (state.selected === taskId) {
        state.localMessages = [
          ...state.localMessages,
          {
            role: "user",
            content: text,
            taskId,
            interjected: true,
            delivery,
            pending: delivery === "followUp",
            id: result.messageId,
            timestamp: Date.now()
          }
        ];
        renderAll();
      }
    } catch (error) {
      showToast(ui`补充失败：${requestErrorMessage(error)}`);
    } finally {
      finishSubmission(submission);
      updateSendButton();
    }
  }

  function currentSubmission() {
    return (
      (state.selected && sending.get(`task:${state.selected}`)) ||
      sending.get(`draft:${composerSession.shownDraftIdentity}`)
    );
  }

  function beginSubmission(taskId = state.selected) {
    const submission = { keys: new Set(), launching: false };
    const draftKey = `draft:${composerSession.shownDraftIdentity}`;
    submission.keys.add(draftKey);
    sending.set(draftKey, submission);
    if (taskId) associateSubmission(submission, taskId);
    return submission;
  }

  function associateSubmission(submission, taskId) {
    const key = `task:${taskId}`;
    submission.keys.add(key);
    sending.set(key, submission);
  }

  function finishSubmission(submission) {
    for (const key of submission.keys) if (sending.get(key) === submission) sending.delete(key);
  }

  function submissionDraft() {
    return {
      input: $("#composer-input").value,
      attachments: JSON.stringify(state.attachments),
      token: composerSession.currentToken,
      focusedSend: document.activeElement === $("#send-button")
    };
  }

  /**
   * While a message is on its way, the composer that still holds it looks empty:
   * starting Main can take seconds and the message already shows above. The
   * value stays, so navigation keeps the draft and a failure shows it again.
   */
  function showSentDraft(draft) {
    const input = $("#composer-input");
    const sent = Boolean(
      draft &&
      composerSession.currentToken === draft.token &&
      input.value === draft.input &&
      JSON.stringify(state.attachments) === draft.attachments
    );
    if (input.classList.contains("is-sent") === sent) return;
    input.classList.toggle("is-sent", sent);
    $("#attachment-strip").classList.toggle("is-sent", sent);
  }

  // Typing while a message is on its way starts the next one in an empty box
  // instead of editing the hidden text that is being sent.
  $("#composer-input").addEventListener("beforeinput", (event) => {
    if (event.target.classList.contains("is-sent")) event.target.value = "";
  });

  function clearSubmittedDraft(taskId, draft) {
    const input = $("#composer-input");
    if (
      state.selected === taskId &&
      composerSession.currentToken === draft.token &&
      input.value === draft.input &&
      JSON.stringify(state.attachments) === draft.attachments
    ) {
      input.value = "";
      attachments.clear();
      composerSession.save();
      if (
        draft.focusedSend &&
        document.activeElement === document.body &&
        input.getClientRects().length &&
        $("#human-questions").hidden
      )
        input.focus({ preventScroll: true });
    }
  }

  async function launchPrompt(
    taskId,
    prompt,
    {
      model,
      profileId,
      thinkingLevel,
      resume,
      retryRequestId,
      savedUsers,
      attachmentIds = [],
      references = [],
      submission,
      body
    }
  ) {
    if (submission) submission.launching = true;
    let optimisticMessage;
    if (state.selected === taskId && prompt) {
      optimisticMessage = {
        role: "user",
        content: prompt,
        taskId,
        savedUsers,
        savedUserTail:
          state.detail?.historyPage && savedUsers >= state.detail.historyPage.limit
            ? latestSavedUser(state.detail.messages)
            : undefined
      };
      state.localMessages = [...state.localMessages, optimisticMessage];
      state.submittingTaskId = taskId;
      renderAll();
    }
    try {
      const run = await api(`/api/tasks/${encodeURIComponent(taskId)}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          body,
          resume,
          model,
          ...(profileId ? { profileId } : {}),
          thinkingLevel,
          attachmentIds,
          ...(references.length ? { references } : {}),
          retryRequestId
        })
      });
      // A queued demand is accepted but not running: keeping the optimistic
      // running state would route the next message into interject instead of
      // letting the server refuse a different input.
      if (run.status === "queued") {
        showToast(ui`已排队第 ${run.queuePosition ?? 1} 位`);
        return run;
      }
      composerModel.acceptRun(taskId, run.model);
      if (state.selected === taskId) {
        const detail = state.detail?.task?.taskId === taskId ? state.detail : {};
        const failed = run.status === "failed";
        state.detail = {
          ...detail,
          task: {
            ...detail.task,
            taskId,
            activeRunId: run.runId,
            status: failed ? "failed" : "running",
            ...(failed ? { lastError: run.error } : {})
          },
          runtime: { ...detail.runtime, active: !failed }
        };
        renderAll();
        if (!failed) connectEventStream(taskId);
      }
      return run;
    } catch (error) {
      state.localMessages = state.localMessages.filter((message) => message !== optimisticMessage);
      throw error;
    }
  }

  function isTaskStopping(taskId = state.selected) {
    return Boolean(
      stoppingTasks.has(taskId) || (state.detail?.task?.taskId === taskId && state.detail?.runtime?.stopping)
    );
  }

  /**
   * What a catalog restore must not replace: text or attachments the person put
   * in the composer, including an attachment whose upload is still running.
   */
  function composerHasUnsentContent() {
    return Boolean($("#composer-input").value.trim() || state.attachments.length || attachments.busy);
  }

  function updateSendButton() {
    messageEdit.sync();
    const pendingSubmission = currentSubmission();
    const isSending = Boolean(pendingSubmission);
    showSentDraft(pendingSubmission?.draft);
    state.submittingTaskId = pendingSubmission?.launching ? state.selected : null;
    // While working, new messages wait in the queue and can be promoted explicitly.
    const running = Boolean(state.detail?.task?.taskId === state.selected && state.detail?.runtime?.active);
    const stopping = isTaskStopping();
    const hasDraft = Boolean($("#composer-input").value.trim() || state.attachments.length);
    // Main waiting on its Subagents is not Main working: the composer stays a
    // send box and the status line carries pause and stop.
    const showStop = stopping || (running && !hasDraft && !waiting());
    renderMessageQueue($("#queued-messages"), {
      taskId: state.selected,
      messages:
        state.detail?.task?.taskId === state.selected
          ? [...(state.detail.messages || []), ...state.localMessages]
          : [],
      running,
      promoting: promotingMessages,
      disabled: !state.online || stopping,
      cancel: (taskId, messageId) => promoteQueuedMessage(taskId, messageId, "cancel"),
      promote: promoteQueuedMessage
    });
    const backendReady = isBackendReady();
    const awaitingSetup = firstUse.blocksSending();
    $("#send-button").hidden = showStop;
    $("#send-button").disabled =
      awaitingSetup || isSending || attachments.busy || stopping || !state.online || !backendReady;
    $("#stop-button").hidden = !showStop;
    $("#stop-button").disabled = stopping;
    $("#stop-button").setAttribute("aria-busy", String(stopping));
    $("#stop-button").setAttribute("aria-label", stopping ? ui("正在停止") : ui("停止"));
    $("#stop-button").title = stopping ? ui("正在停止…") : ui("停止（Esc）");
    $("#model-setup-button").hidden = composerModel.configured !== false;
    $("#send-button").title = awaitingSetup
      ? firstUse.lockReason()
      : !backendReady
        ? ui("后端连接不可用")
        : isSending
          ? ui("正在发送…")
          : attachments.busy
            ? ui("正在读取附件…")
            : running
              ? ui("插入下一步（Enter）· 本轮结束后发送（⌥Enter）")
              : ui("发送（Enter）");
    $("#send-button").setAttribute("aria-label", running ? ui("插入下一步") : ui("发送"));
    if (composerSession.editing) {
      $("#send-button").title = ui("请先保存或取消正在编辑的消息");
      $("#send-button").disabled = true;
    }
  }

  async function promoteQueuedMessage(taskId, messageId, action = "steer") {
    const key = `${taskId}:${messageId}`;
    if (promotingMessages.has(key)) return;
    promotingMessages.add(key);
    updateSendButton();
    try {
      const result = await api(
        `/api/tasks/${encodeURIComponent(taskId)}/interject/${encodeURIComponent(messageId)}/${action}`,
        {
          method: "POST"
        }
      );
      if (state.selected === taskId) {
        if (action === "cancel") {
          state.localMessages = state.localMessages.filter((message) => message.id !== messageId);
          if (state.detail?.messages)
            state.detail.messages = state.detail.messages.filter((message) => message.id !== messageId);
        } else {
          for (const message of [...(state.detail?.messages || []), ...state.localMessages])
            if (message.id === messageId) Object.assign(message, { delivery: "steer", pending: false });
        }
        if (result.status === "running") connectEventStream(taskId);
        renderAll();
      }
    } catch (error) {
      showToast(requestErrorMessage(error));
    } finally {
      promotingMessages.delete(key);
      if (state.selected === taskId) await loadDetail(taskId);
      updateSendButton();
    }
  }

  async function submitMessageEdit() {
    if (
      !composerSession.editing ||
      currentSubmission() ||
      attachments.busy ||
      !state.online ||
      isTaskStopping()
    )
      return;
    const submission = beginSubmission();
    updateSendButton();
    try {
      await messageEdit.submit();
    } finally {
      finishSubmission(submission);
      renderAll();
      updateSendButton();
    }
  }

  /** What a message's `/` and `@` words reference; the menus' lists are read first when it has any. */
  function hasReferenceWords(text) {
    return /(^|\s)[/@]\S/.test(text);
  }
  async function draftReferences(text) {
    if (!hasReferenceWords(text)) return [];
    // eslint-disable-next-line no-restricted-syntax -- 列表读不到时按已知内容识别，消息照常发送
    await composerMenu.prepare().catch(() => {});
    return composerMenu.references(text);
  }

  let resolvingReferences = false;
  async function compactConversation() {
    const taskId = state.selected;
    if (!taskId) return showToast(ui("发送第一条消息后可换窗口。"));
    if (currentSubmission() || !state.online || isTaskStopping()) return;
    const draft = submissionDraft();
    const submission = beginSubmission();
    updateSendButton();
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "compact" })
      });
      const input = $("#composer-input");
      if (
        state.selected === taskId &&
        composerSession.currentToken === draft.token &&
        input.value === draft.input &&
        draft.input.trim() === "/compact"
      ) {
        input.value = "";
        composerSession.save();
      }
      await loadDetail(taskId);
    } catch (error) {
      showToast(requestErrorMessage(error));
    } finally {
      finishSubmission(submission);
      updateSendButton();
    }
  }

  async function sendMessage({ queue = false } = {}) {
    if (!$("#human-questions").hidden) return;
    if (firstUse.blocksSending()) return;
    const input = $("#composer-input");
    // Attachments alone are a message: nothing is typed on the person's behalf.
    const text = input.value.trim();
    if (!text && !state.attachments.length) return;
    if (currentSubmission() || attachments.busy || !state.online) return;
    if (isTaskStopping()) return;
    if (composerSession.editing) {
      return showToast(ui("请先保存或取消正在编辑的消息，底部草稿会保留。"));
    }
    if (text === "/compact") {
      composerMenu.close();
      return compactConversation();
    }
    if (composerModel.configured === false) return void openModelSettings();
    composerMenu.close();
    // Reading the menus' lists is a pause in which a second Enter must not send again;
    // a message without `/` or `@` words sends without it.
    if (resolvingReferences) return;
    let references = [];
    if (hasReferenceWords(text)) {
      resolvingReferences = true;
      try {
        references = await draftReferences(text);
      } finally {
        resolvingReferences = false;
      }
    }
    // Running input joins Main's next step; a queued message waits for the round to end.
    if (state.detail?.task?.taskId === state.selected && state.detail?.runtime?.active && state.selected) {
      try {
        return interject(
          state.selected,
          composePrompt(text, state.attachments),
          queue ? "followUp" : "steer",
          references
        );
      } catch (error) {
        showToast(error.message);
        return;
      }
    }
    const draft = submissionDraft();
    const submission = beginSubmission();
    submission.draft = draft;
    updateSendButton();
    const selectedTask = state.selected;
    const detail = state.detail?.task?.taskId === selectedTask ? state.detail : null;
    const runOptions = {
      submission,
      body: draft.input,
      attachmentIds: uploadedFileIds(JSON.parse(draft.attachments)),
      references,
      resume: detail?.task?.status === "waiting",
      model: composerModel.model || composerModel.defaultModel || undefined,
      profileId: composerModel.profileId || undefined,
      thinkingLevel: composerModel.sentThinkingLevel(),
      savedUsers: (detail?.messages || []).filter((message) => message.role === "user").length
    };
    let prompt;
    try {
      prompt = composePrompt(text, state.attachments);
    } catch (error) {
      finishSubmission(submission);
      updateSendButton();
      showToast(error.message);
      return;
    }
    try {
      // A new session is named by its words, or by its files when there are none.
      const title = text || state.attachments.map((file) => file.name).join("、");
      const taskId =
        selectedTask || (await createTask(title, (taskId) => associateSubmission(submission, taskId)));
      associateSubmission(submission, taskId);
      await launchPrompt(taskId, prompt, runOptions);
      clearSubmittedDraft(taskId, draft);
      await refresh();
    } catch (error) {
      showToast(ui`发送失败：${requestErrorMessage(error)}`);
    } finally {
      finishSubmission(submission);
      renderAll();
      updateSendButton();
    }
  }

  async function continuePausedRun(taskId = state.selected) {
    const detail = state.detail?.task?.taskId === taskId ? state.detail : null;
    if (
      !taskId ||
      state.selected !== taskId ||
      !detail ||
      detail.runtime?.active ||
      detail.task.status !== "paused" ||
      continuingTasks.has(taskId)
    )
      return;
    continuingTasks.add(taskId);
    try {
      await launchPrompt(taskId, undefined, { resume: true });
      await refresh();
    } catch (error) {
      showToast(ui`继续失败：${requestErrorMessage(error)}`);
      await refresh();
    } finally {
      continuingTasks.delete(taskId);
      renderAll();
    }
  }

  async function retryFailedRequest(taskId) {
    const detail = state.detail?.task?.taskId === taskId ? state.detail : null;
    if (
      !taskId ||
      state.selected !== taskId ||
      !detail ||
      detail.runtime?.active ||
      ["completed", "cancelled"].includes(detail.task.status) ||
      !$("#human-questions").hidden ||
      currentSubmission() ||
      attachments.busy ||
      !state.online
    )
      return;
    if (composerModel.configured === false) return void openModelSettings();
    if (detail.retryRequestUnavailable) {
      showToast(ui("原始模型请求的重试记录不可用，已有历史和草稿已保留。请恢复工作区备份或主动发送新消息。"));
      return;
    }
    // The exact request identity is independent of the next unsent message.
    const runOptions = {
      resume: true,
      retryRequestId: detail.retryRequest?.requestId,
      savedUsers: (detail.messages || []).filter((message) => message.role === "user").length
    };
    const recoveryFocus = document.activeElement?.hasAttribute?.("data-retry-request");
    const navigation = composerSession.currentToken;
    let rejected = false;
    composerSession.save();
    const submission = beginSubmission(taskId);
    runOptions.submission = submission;
    updateSendButton();
    try {
      await launchPrompt(taskId, undefined, runOptions);
      await refresh();
    } catch (error) {
      rejected = true;
      const classified = requestErrorMessage(error);
      showToast(
        ui`重试未能启动：${error.code === "main_retry_context_changed" || error.code === "main_retry_snapshot_invalid" ? error.message : classified !== error.message ? classified : ui("已有内容和草稿已保留，请检查连接后重试。")}`
      );
    } finally {
      finishSubmission(submission);
      renderAll();
      updateSendButton();
      if (
        rejected &&
        recoveryFocus &&
        state.selected === taskId &&
        composerSession.currentToken === navigation &&
        document.activeElement === document.body
      )
        $("#conversation [data-retry-request]")?.focus({ preventScroll: true });
    }
  }

  return {
    currentSubmission,
    composerHasUnsentContent,
    draftReferences,
    updateSendButton,
    isTaskStopping,
    stopRound,
    stopTask,
    continuePausedRun,
    isContinuing: (taskId) => continuingTasks.has(taskId),
    retryFailedRequest,
    compactConversation,
    submitMessageEdit
  };
}
