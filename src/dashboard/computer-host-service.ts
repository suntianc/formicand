import type { ComputerDriver, ComputerUse } from "../gui/computer-use.js";
import { HttpError } from "./http.js";

export function createComputerHostRequest(computer: ComputerUse, driver: () => ComputerDriver) {
  return async function computerHostRequest(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new HttpError(400, "无效 Computer Use 请求");
    const input = value as Record<string, unknown>;
    const exact = (...keys: string[]) => Object.keys(input).every((key) => keys.includes(key));
    if (input.operation === "policy") {
      if (
        !exact("operation", "enabled", "mode") ||
        typeof input.enabled !== "boolean" ||
        (input.mode !== "observe" && input.mode !== "control")
      )
        throw new HttpError(400, "无效 Computer Use 策略");
      return computer.configurePolicy({ enabled: input.enabled, mode: input.mode });
    }
    if (input.operation === "resume" && exact("operation")) return computer.resume();
    if (input.operation === "pause" && exact("operation")) return computer.takeOver();
    if (input.operation === "release-sessions") {
      if (!exact("operation")) throw new HttpError(400, "无效 Computer Use 请求");
      computer.releaseSessions();
      return null;
    }
    if (input.operation === "end") {
      if (!exact("operation")) throw new HttpError(400, "无效 Computer Use 请求");
      computer.close();
      return null;
    }
    if (input.operation === "access" && exact("operation")) return computer.access();
    if (input.operation === "status" && exact("operation")) return driver().status();
    if (input.operation === "permissions") {
      if (
        !exact("operation", "permission") ||
        (input.permission !== "screenRecording" && input.permission !== "accessibility")
      )
        throw new HttpError(400, "无效系统权限请求");
      return (
        driver().requestPermissions?.(input.permission) ??
        Promise.reject(new HttpError(503, "当前驱动不支持系统权限请求"))
      );
    }
    if (
      input.operation !== "authorize" ||
      !exact("operation", "taskId", "pid", "windowId", "mode", "bundleId", "application", "title") ||
      [input.bundleId, input.application, input.title].some(
        (value) => value !== undefined && (typeof value !== "string" || value.length > 1024)
      ) ||
      typeof input.taskId !== "string" ||
      input.taskId.length === 0 ||
      input.taskId.length > 200 ||
      typeof input.pid !== "number" ||
      !Number.isSafeInteger(input.pid) ||
      input.pid <= 0 ||
      typeof input.windowId !== "number" ||
      !Number.isSafeInteger(input.windowId) ||
      input.windowId <= 0 ||
      (input.mode !== "observe" && input.mode !== "control")
    )
      throw new HttpError(400, "无效 Computer Use 授权");
    return computer.authorize(input.taskId, input.pid, input.windowId, input.mode);
  };
}
