#!/usr/bin/env node
import { add, complete, load, save } from "./store.js";
import { formatList } from "./format.js";
import { search } from "./search.js";
import { sortItems } from "./sort.js";
import { paginate, pageCount } from "./paginate.js";
import { toCsv } from "./export.js";

function options(args) {
  const values = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) values[args[i].slice(2)] = args[++i];
    else rest.push(args[i]);
  }
  return { values, rest };
}

function run([command, ...args]) {
  const { values, rest } = options(args);
  const items = load();
  switch (command) {
    case "add": {
      const itemTitle = rest.join(" ").trim();
      if (!itemTitle) throw new Error("a title is required");
      save(add(items, itemTitle, values.tag ? [values.tag] : []));
      return `added: ${itemTitle}`;
    }
    case "list": {
      const size = Number(values.size ?? 10);
      const page = Number(values.page ?? 1);
      const sorted = sortItems(items, values.sort ?? "id");
      return `${formatList(paginate(sorted, page, size))}\npage ${page}/${pageCount(sorted, size)}`;
    }
    case "done":
      save(complete(items, Number(rest[0])));
      return `done: ${rest[0]}`;
    case "search":
      return formatList(search(items, rest.join(" ")));
    case "export":
      return toCsv(items);
    default:
      throw new Error("usage: todo add|list|done|search|export");
  }
}

try {
  console.log(run(process.argv.slice(2)));
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
