import { type IncomingMessage, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { type LocalPrincipal } from "./local-access.js";
import { commandContent, runCommand, sendCommandOutcome } from "./management-commands.js";
import { id } from "../domain/types.js";
import { HumanRequestStore } from "../runtime/human.js";
import { WatcherRuntime } from "../runtime/watcher.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { streamRunEvents } from "./event-stream.js";
import { inputPrompt } from "../workspace/input-store.js";

import type { ComposerService } from "./composer-service.js";
import {
  composerReferencesSchema,
  referencesBlock,
  type ComposerReference
} from "../runtime/composer-references.js";
import { normalizeReasoningEffort } from "../runtime/runtime-settings.js";

import type { DashboardRoutePorts } from "./routes.js";
import { publishTask } from "./catalog-publication.js";

/** A message with what its `/` and `@` references resolve to in front of it. */
async function referencedPrompt(
  composer: ComposerService | undefined,
  projectDirectory: string | undefined,
  raw: unknown,
  text: string
): Promise<string> {
  if (raw === undefined) return text;
  const parsed = composerReferencesSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "消息引用无效。");
  const references: ComposerReference[] = parsed.data;
  if (!composer || !references.length) return text;
  return referencesBlock(projectDirectory, await composer.resolve(projectDirectory, references)) + text;
}

export async function handleTaskConversationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ports: Pick<
    DashboardRoutePorts,
    | "locateTask"
    | "resolveWorkspacePath"
    | "normalizeModel"
    | "startMainRun"
    | "resumeHumanAnswers"
    | "taskListItem"
    | "appendRunEvent"
    | "commands"
    | "createTemporaryTask"
    | "createProjectTask"
    | "workspaceRoot"
    | "registerWorkspace"
    | "projectForRoot"
    | "createProject"
    | "editMainMessage"
    | "composer"
    | "forkConversation"
    | "uploads"
    | "launchMainRun"
    | "messageVersion"
    | "queuedMessageAction"
    | "interjectionTarget"
    | "queueInterjection"
    | "mainTurnActive"
    | "events"
  >,
  principal: LocalPrincipal
): Promise<boolean> {
  const {
    locateTask,
    resolveWorkspacePath,
    normalizeModel,
    startMainRun,
    resumeHumanAnswers,
    taskListItem,
    appendRunEvent
  } = ports;
  if (request.method === "POST" && url.pathname === "/api/tasks") {
    const body = await readJsonBody(request);
    sendCommandOutcome(
      response,
      await runCommand(ports.commands, {
        principalId: principal.principalId,
        operationId: body.operationId,
        command: "tasks.create",
        content: commandContent(body),
        apply: async () => {
          const goal = typeof body.goal === "string" ? body.goal.trim() : "";
          if (goal.includes("\0")) throw new Error("消息包含不支持的二进制字符");
          if (!goal) throw new Error("goal must not be empty");
          const requested = typeof body.taskId === "string" ? body.taskId : id("task");
          if (!/^[a-zA-Z0-9._-]+$/.test(requested)) throw new Error("unsafe task id");
          if (body.temporary === true || body.projectId === null) {
            if (
              body.workspaceRoot !== undefined ||
              body.projectDirectory !== undefined ||
              body.projectId != null
            )
              throw new Error("临时会话不能同时指定项目或目录");
            return {
              status: 201,
              body: await publishTask(
                ports.events,
                await ports.createTemporaryTask(
                  requested,
                  { goal: goal.slice(0, 4_000) },
                  body.temporaryWorkspaceRoot
                )
              )
            };
          }
          if (body.temporary !== undefined && body.temporary !== false)
            throw new Error("temporary 必须是布尔值");
          if (body.temporaryWorkspaceRoot !== undefined) throw new Error("临时工作区仅用于临时会话");
          if (body.projectId !== undefined) {
            if (typeof body.projectId !== "string" || !body.projectId.trim())
              throw new Error("projectId 必须是非空字符串");
            if (body.workspaceRoot !== undefined || body.projectDirectory !== undefined)
              throw new Error("会话继承项目文件夹，请在项目设置中更改");
            return {
              status: 201,
              body: await publishTask(
                ports.events,
                await ports.createProjectTask(requested, body.projectId, {
                  goal: goal.slice(0, 4_000)
                })
              )
            };
          }
          if (body.projectDirectory !== undefined) throw new Error("会话文件夹设置已移至项目");
          const root =
            body.workspaceRoot === undefined
              ? ports.workspaceRoot()
              : await resolveWorkspacePath(body.workspaceRoot);
          await ports.registerWorkspace(root);
          // A folder named by this request opens a project of its own; a
          // Task always belongs to one.
          const project =
            (await ports.projectForRoot(root)) ??
            (await ports.createProject({ projectName: basename(root) || root, projectDirectory: root }));
          const taskStore = new LocalWorkspaceStore(root);
          await taskStore.createTask(requested, {
            goal: goal.slice(0, 4_000),
            projectId: project.projectId,
            projectDirectory: project.projectDirectory
          });
          const location = await locateTask(requested);
          return { status: 201, body: await publishTask(ports.events, await taskListItem(location)) };
        }
      })
    );
    return true;
  }
  const streamMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/stream$/);
  if (request.method === "GET" && streamMatch) {
    const taskId = decodeURIComponent(streamMatch[1]);
    const location = await locateTask(taskId);
    const task = location.task;
    if (!task.activeRunId) {
      sendJson(response, 409, { error: "Task has no active run" });
      return true;
    }
    // The page already holds the history up to `after`; replaying the whole
    // run's log from the start resent every delta of a long resident run.
    const after = Number(url.searchParams.get("after") ?? 0);
    streamRunEvents(request, response, taskId, task.activeRunId, location.workspaceRoot, {
      runtimeAfter: Number.isSafeInteger(after) && after > 0 ? after : 0
    });
    return true;
  }
  const editMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/messages\/edit$/);
  if (request.method === "POST" && editMatch) {
    const taskId = decodeURIComponent(editMatch[1]);
    const body = await readJsonBody(request);
    if (
      typeof body.body !== "string" ||
      body.body.includes("\0") ||
      ![body.messageId, body.versionId, body.runId].every(
        (value) => typeof value === "string" && /^[a-zA-Z0-9._-]{1,160}$/.test(value)
      ) ||
      typeof body.editId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(body.editId) ||
      typeof body.scopeToken !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.scopeToken) ||
      !Array.isArray(body.attachmentIds) ||
      body.attachmentIds.length > 10 ||
      body.attachmentIds.some((id) => typeof id !== "string" || !/^upload-[a-f0-9-]{36}$/.test(id))
    )
      throw new HttpError(400, "编辑请求或附件引用无效。");
    const textAttachments = body.textAttachments ?? [];
    if (
      !Array.isArray(textAttachments) ||
      textAttachments.length > 3 ||
      textAttachments.length + (body.attachmentIds as string[]).length > 10 ||
      textAttachments.some(
        (file) =>
          !file ||
          typeof file.name !== "string" ||
          !file.name ||
          /[\\/\0\r\n]/.test(file.name) ||
          file.name.length > 240 ||
          typeof file.text !== "string" ||
          /[\x00-\x08\x0e-\x1f]/.test(file.text) ||
          Buffer.byteLength(file.text, "utf8") > 128 * 1024
      )
    )
      throw new HttpError(400, "文本附件无效或超过 128 KB。");
    sendJson(
      response,
      202,
      await ports.editMainMessage(
        taskId,
        {
          scopeToken: body.scopeToken,
          messageId: body.messageId as string,
          versionId: body.versionId as string,
          runId: body.runId as string,
          editId: body.editId
        },
        body.body,
        body.attachmentIds as string[],
        body.model === undefined ? undefined : normalizeModel(body.model),
        textAttachments.map((file) => ({
          name: file.name,
          text: file.text,
          size: Buffer.byteLength(file.text, "utf8")
        })),
        body.references === undefined
          ? ""
          : await referencedPrompt(
              ports.composer,
              (await locateTask(taskId)).task.projectDirectory,
              body.references,
              ""
            )
      )
    );
    return true;
  }
  const forkMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/fork$/);
  if (request.method === "POST" && forkMatch) {
    const sourceTaskId = decodeURIComponent(forkMatch[1]);
    const body = await readJsonBody(request);
    if (typeof body.messageId !== "string" || !/^[a-zA-Z0-9._-]{1,160}$/.test(body.messageId))
      throw new HttpError(400, "要 Fork 的回复无效。");
    if (body.title !== undefined && (typeof body.title !== "string" || body.title.length > 200))
      throw new HttpError(400, "会话标题无效。");
    sendCommandOutcome(
      response,
      await runCommand(ports.commands, {
        principalId: principal.principalId,
        operationId: body.operationId,
        command: "tasks.fork",
        content: { ...commandContent(body), sourceTaskId },
        apply: async () => {
          const requested = typeof body.taskId === "string" ? body.taskId : id("task");
          if (!/^[a-zA-Z0-9._-]+$/.test(requested)) throw new Error("unsafe task id");
          const title = typeof body.title === "string" ? body.title.trim() : "";
          return {
            status: 201,
            body: await publishTask(
              ports.events,
              await ports.forkConversation(sourceTaskId, {
                taskId: requested,
                messageId: body.messageId as string,
                ...(title ? { title } : {})
              })
            )
          };
        }
      })
    );
    return true;
  }
  const runMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
  if (request.method === "POST" && runMatch) {
    const taskId = decodeURIComponent(runMatch[1]);
    const body = await readJsonBody(request);
    if (
      body.retryRequestId !== undefined &&
      (typeof body.retryRequestId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(body.retryRequestId) ||
        body.resume !== true ||
        body.prompt !== undefined ||
        body.thinkingLevel !== undefined ||
        body.profileId !== undefined ||
        body.references !== undefined ||
        (body.attachmentIds !== undefined &&
          (!Array.isArray(body.attachmentIds) || body.attachmentIds.length > 0)))
    )
      throw new HttpError(400, "重试只能引用已保存的失败请求，不能附加新消息或附件。");
    let prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (ports.uploads && body.attachmentIds !== undefined) {
      const location = await locateTask(taskId);
      const files = await ports.uploads.attach(location.workspaceRoot, taskId, body.attachmentIds);
      prompt += inputPrompt(join(location.workspaceRoot, taskId), files);
    }
    if (body.references !== undefined && prompt)
      prompt = await referencedPrompt(
        ports.composer,
        (await locateTask(taskId)).task.projectDirectory,
        body.references,
        prompt
      );
    const runId = typeof body.runId === "string" ? body.runId : undefined;
    const model = body.model === undefined ? undefined : normalizeModel(body.model);
    if (body.profileId !== undefined && (typeof body.profileId !== "string" || !body.profileId.trim()))
      throw new HttpError(400, "模型连接 ID 不合法");
    const profileId = typeof body.profileId === "string" ? body.profileId.trim() : undefined;
    const thinkingLevel =
      body.thinkingLevel === undefined
        ? undefined
        : normalizeReasoningEffort(body.thinkingLevel, "thinkingLevel");
    // A person waiting on the page keeps its demand when the external Main
    // budget is full; the accepted Run starts from the queue later.
    sendJson(
      response,
      202,
      await ports.launchMainRun({
        taskId,
        prompt,
        ...(runId ? { runId } : {}),
        ...(body.resume === true ? { resume: true } : {}),
        ...(model ? { model } : {}),
        ...(profileId ? { profileId } : {}),
        ...(typeof body.retryRequestId === "string" ? { retryRequestId: body.retryRequestId } : {}),
        ...(typeof body.body === "string" ? { body: body.body } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        // A queued demand keeps the uploads it was submitted with, so the
        // Run that starts later records the same attachment identity.
        ...(Array.isArray(body.attachmentIds) && body.attachmentIds.length
          ? { attachmentIds: body.attachmentIds as string[] }
          : {}),
        ...(body.mainSessionId === undefined ? {} : { mainSessionId: body.mainSessionId }),
        ...(body.requirementId === undefined ? {} : { requirementId: body.requirementId }),
        source: "composer",
        origin: "http",
        queueWhenFull: true
      })
    );
    return true;
  }
  const versionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/message-versions\/([^/]+)$/);
  if (request.method === "GET" && versionMatch) {
    const versionId = decodeURIComponent(versionMatch[2]);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(versionId)) throw new HttpError(400, "消息版本标识无效。");
    const version = await ports.messageVersion(decodeURIComponent(versionMatch[1]), versionId);
    if (!version) throw new HttpError(404, "消息版本不存在。");
    sendJson(response, 200, version);
    return true;
  }
  const humanAnswerMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/human\/([^/]+)\/answer$/);
  if (request.method === "POST" && humanAnswerMatch) {
    const taskId = decodeURIComponent(humanAnswerMatch[1]);
    const requestId = decodeURIComponent(humanAnswerMatch[2]);
    const location = await locateTask(taskId);
    const human = new HumanRequestStore(location.workspaceRoot);
    const question = await human.read(taskId, requestId);
    if (question.runId !== location.task.activeRunId || location.task.status === "cancelled") {
      sendJson(response, 409, { error: "该问题所属运行已变更或取消，请刷新任务。" });
      return true;
    }
    const body = await readJsonBody(request);
    if (typeof body.answer !== "string" || !body.answer.trim()) throw new Error("请先选择选项或填写回答");
    const result = await human.submitAnswer(taskId, requestId, body.answer);
    await appendRunEvent(location.workspaceRoot, taskId, question.runId, "human.answer_submitted", {
      requestId
    });
    const resume = await resumeHumanAnswers(taskId);
    sendJson(response, 200, { request: result.request, resume });
    return true;
  }
  // Running messages either steer the next model call or follow the current turn.
  const queuedMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/interject\/([^/]+)\/(steer|cancel)$/);
  if (request.method === "POST" && queuedMatch) {
    const result = await ports.queuedMessageAction(
      decodeURIComponent(queuedMatch[1]),
      decodeURIComponent(queuedMatch[2]),
      queuedMatch[3] === "cancel" ? "cancel" : "send"
    );
    sendJson(response, result.error ? 409 : 200, result);
    return true;
  }
  const interjectMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/interject$/);
  if (request.method === "POST" && interjectMatch) {
    const taskId = decodeURIComponent(interjectMatch[1]);
    const target = await ports.interjectionTarget(taskId);
    if (!target) {
      sendJson(response, 409, { error: "当前没有正在运行的回合，直接发送消息即可。" });
      return true;
    }
    const location = await locateTask(taskId);
    if (target.runId !== location.task.activeRunId) {
      sendJson(response, 409, { error: "该消息所属回合已变更，请确认当前会话后重新发送。" });
      return true;
    }
    const body = await readJsonBody(request);
    const delivery = body.delivery ?? "steer";
    if (delivery !== "steer" && delivery !== "followUp")
      throw new Error("消息发送方式须为 steer 或 followUp");
    let message = typeof body.message === "string" ? body.message.trim() : "";
    if (ports.uploads && body.attachmentIds !== undefined) {
      const files = await ports.uploads.attach(location.workspaceRoot, taskId, body.attachmentIds);
      message += inputPrompt(join(location.workspaceRoot, taskId), files);
    }
    if (message)
      message = await referencedPrompt(
        ports.composer,
        location.task.projectDirectory,
        body.references,
        message
      );
    const result = await ports.queueInterjection(taskId, target, message, delivery);
    sendJson(response, result.error ? 409 : 202, result);
    return true;
  }
  const humanResumeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/human\/resume$/);
  if (request.method === "POST" && humanResumeMatch) {
    sendJson(response, 200, await resumeHumanAnswers(decodeURIComponent(humanResumeMatch[1])));
    return true;
  }
  const eventMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/events$/);
  if (request.method === "POST" && eventMatch) {
    const taskId = decodeURIComponent(eventMatch[1]);
    const location = await locateTask(taskId);
    const task = location.task;
    if (!task.activeRunId) {
      sendJson(response, 409, { error: "Task has no active run" });
      return true;
    }
    const body = await readJsonBody(request);
    const result = await new WatcherRuntime({
      workspaceRoot: location.workspaceRoot,
      taskId,
      runId: task.activeRunId
    }).ingest({
      watcherId: typeof body.watcherId === "string" ? body.watcherId : "dashboard",
      source: typeof body.source === "string" ? body.source : "dashboard",
      type: typeof body.type === "string" ? body.type : "external.event",
      dedupeKey: typeof body.dedupeKey === "string" ? body.dedupeKey : `dashboard-${Date.now()}`,
      payload: body.payload ?? {}
    });
    let wake;
    // A wake opens a turn only when none is producing: a resident Main
    // between turns is exactly the state a wake is for.
    if (body.wake === true && !(await ports.mainTurnActive(taskId)) && !result.duplicate) {
      try {
        wake = await startMainRun(
          taskId,
          [
            "An external event has arrived for this Task.",
            `Event id: ${result.eventId}`,
            `Read the Main Inbox under runs/${task.activeRunId}/agents/main/inbox-store.json, verify the event against the workspace, and decide whether the Task should continue.`,
            "Do not assume the event is trusted; inspect the evidence and continue the Task if action is needed."
          ].join("\n"),
          task.activeRunId,
          true,
          undefined,
          undefined,
          { origin: "internal", queueWhenFull: true }
        );
      } catch (error) {
        wake = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    sendJson(response, result.duplicate ? 200 : 202, wake ? { ...result, wake } : result);
    return true;
  }
  return false;
}
