const cell = (value) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

export function toCsv(items) {
  const rows = items.map((item) =>
    [item.id, cell(item.itemTitle), item.done, cell(item.tags.join(" "))].join(",")
  );
  return ["id,title,done,tags", ...rows].join("\n");
}
