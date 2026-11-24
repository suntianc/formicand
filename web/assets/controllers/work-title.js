import { ui } from "../ui/language.js";
import { splitReferences } from "../references.js";

export function taskGoalText(goal) {
  return splitReferences(goal || "").text.trim();
}
export function conversationTitle(task) {
  const fallback = taskGoalText(task?.goal);
  return task?.title || truncate(String(fallback || task?.taskId || ui("新的对话")).split("\n")[0], 48);
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
