import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const dataFile = () => process.env.TODO_FILE ?? "todo.json";

/** Fill in what an older or hand-edited record may lack, so every reader sees one shape. */
export function normalize(raw, index) {
  return {
    id: Number.isInteger(raw.id) ? raw.id : index + 1,
    itemTitle: String(raw.itemTitle ?? "").trim(),
    done: raw.done === true,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : []
  };
}

export function load() {
  if (!existsSync(dataFile())) return [];
  return JSON.parse(readFileSync(dataFile(), "utf8")).map(normalize);
}

export function save(items) {
  writeFileSync(dataFile(), JSON.stringify(items, null, 2) + "\n");
}

export function add(items, itemTitle, tags = []) {
  const id = Math.max(0, ...items.map((item) => item.id)) + 1;
  return [...items, { id, itemTitle, done: false, tags }];
}

export function complete(items, id) {
  if (!items.some((item) => item.id === id)) throw new Error(`no item ${id}`);
  return items.map((item) => (item.id === id ? { ...item, done: true } : item));
}
