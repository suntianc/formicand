import type { GuiAction } from "./contracts.js";

export class ComputerUseError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errorCode = status === 400
      ? "invalid_argument"
      : status === 403
        ? "access_denied"
        : status === 409
          ? "target_changed"
          : status === 502
            ? "invalid_driver_response"
            : "driver_failed",
    readonly dispatchStatus: "not_sent" | "sent" | "unknown" = "not_sent",
    readonly requiresObservation = dispatchStatus !== "not_sent"
  ) {
    super(message);
  }
}
export const COMPUTER_KEYS = [
  "Meta",
  "Control",
  "Alt",
  "Shift",
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split("")
];
export function computerAction(value: unknown): GuiAction {
  if (!value || typeof value !== "object") throw new ComputerUseError(400, "操作必须是对象");
  const action = value as Record<string, unknown>;
  switch (action.type) {
    case "activate":
      return { type: "activate" };
    case "click":
      if (
        typeof action.x !== "number" ||
        typeof action.y !== "number" ||
        !Number.isFinite(action.x) ||
        !Number.isFinite(action.y) ||
        action.x < 0 ||
        action.y < 0 ||
        !["left", "right"].includes(String(action.button))
      )
        break;
      return { type: "click", x: action.x, y: action.y, button: action.button as "left" | "right" };
    case "type":
      if (
        typeof action.text !== "string" ||
        !action.text ||
        action.text.includes("\0") ||
        Buffer.byteLength(action.text) > 16_384
      )
        break;
      return { type: "type", text: action.text };
    case "key": {
      const keys = action.keys;
      if (
        !Array.isArray(keys) ||
        keys.length < 1 ||
        keys.length > 5 ||
        keys.some((key) => typeof key !== "string" || !COMPUTER_KEYS.includes(key)) ||
        new Set(keys).size !== keys.length ||
        keys.filter((key) => !["Meta", "Control", "Alt", "Shift"].includes(key)).length !== 1
      )
        break;
      return { type: "key", keys };
    }
    case "press":
    case "set_value": {
      if (
        typeof action.elementId !== "string" ||
        !action.elementId ||
        action.elementId.length > 256 ||
        action.elementId.includes("\0")
      )
        break;
      if (action.type === "press") return { type: "press", elementId: action.elementId };
      if (
        typeof action.value !== "string" ||
        action.value.includes("\0") ||
        Buffer.byteLength(action.value) > 16_384
      )
        break;
      return { type: "set_value", elementId: action.elementId, value: action.value };
    }
  }
  throw new ComputerUseError(400, "不支持的操作或参数；使用 activate/click/type/key/press/set_value");
}
