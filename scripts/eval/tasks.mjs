/**
 * The prompt eval task set. Each task runs against a fresh copy of `repo/`.
 *
 * `setup` changes the copy before it is committed; `hidden` names the check in
 * `hidden/` run after Main settles; `expect` lists the behavior a good run
 * shows, which the report compares with what happened.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const tasks = [
  {
    id: "fix",
    kind: "能力",
    title: "小修复",
    prompt: "npm test 有个测试挂了，帮我修一下。",
    async setup(repo) {
      const file = join(repo, "src/paginate.js");
      const source = await readFile(file, "utf8");
      await writeFile(file, source.replace("const start = (page - 1) * size;", "const start = page * size;"));
    },
    hidden: "fix-paginate.test.js",
    expect: { delegations: 0, maxChangedFiles: 1 }
  },
  {
    id: "filter",
    kind: "能力",
    title: "跨文件功能",
    prompt:
      "给 list 命令加两个选项：--done 只列已完成的，--todo 只列未完成的；两个同时给时报错退出（退出码非 0）。补上测试，README 也写一下。",
    hidden: "list-filter.test.js",
    expect: { delegations: 0 }
  },
  {
    id: "due",
    kind: "能力",
    title: "完整需求",
    prompt: [
      "给 todo 工具加截止日期功能：",
      "- add 支持 --due YYYY-MM-DD；日期格式不对或日期不存在时报错退出（退出码非 0），不写入；",
      "- list 输出里，有截止日期的条目在行末显示 (due YYYY-MM-DD)，已过期且未完成的再加 overdue；",
      "- 新增 list --sort due：按截止日期从早到晚，没有截止日期的排最后；",
      "- 判断过期用环境变量 TODO_TODAY（YYYY-MM-DD），没设时用当天日期；",
      "- 补上测试，README 写明用法。"
    ].join("\n"),
    hidden: "due.test.js",
    expect: { development: true }
  },
  {
    id: "ask",
    kind: "行为",
    title: "简单提问",
    prompt: "src/store.js 里的 normalize 是干什么的？load 为什么要调用它？",
    expect: { delegations: 0, maxChangedFiles: 0 }
  },
  {
    id: "rename",
    kind: "行为",
    title: "多步杂活",
    prompt: "把代码和测试里的 itemTitle 全部改名为 title。用户手上旧的数据文件里是 itemTitle，也要还能读。",
    hidden: "rename.test.js",
    expect: { delegations: 0, noLeftover: "itemTitle" }
  }
];
