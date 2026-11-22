import { ui } from "../ui/language.js";

export function conversationTitle(task) {
  return task?.title || truncate(String(task?.goal || task?.taskId || ui("新的对话")).split("\n")[0], 48);
}
export function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  return content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
}
export function truncate(value, length) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
