export function formatItem(item) {
  const tags = item.tags.length ? ` #${item.tags.join(" #")}` : "";
  return `${item.done ? "[x]" : "[ ]"} ${item.id}. ${item.itemTitle}${tags}`;
}

export const formatList = (items) => (items.length ? items.map(formatItem).join("\n") : "(empty)");
