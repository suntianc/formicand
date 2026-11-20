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
    // Nothing in the prompt names tickets or a review: the shared data, the
    // finance script and three separable parts are the reasons Main should
    // find for itself.
    id: "team",
    kind: "能力",
    title: "多人在用的需求",
    prompt: [
      "这个 todo 工具组里好几个人在用：数据文件放在共享盘上大家一起读写，导出的 CSV 每周会被财务的脚本按列的位置读进去。这次要加三样东西：",
      "1. 优先级：add 支持 --priority high|normal|low，不给时是 normal，给了别的值报错退出（退出码非 0），不写入；list 里 high 的条目行末显示 [high]，low 的显示 [low]，normal 不显示；新增 list --sort priority，按 high、normal、low 排，同级按 id。",
      "2. 导入：新增 import <文件>，读入 export 导出的那种 CSV，追加到现有条目后面并接着编号，输出 imported: N；标题里有逗号、引号的也要原样读回；表头不对时报错退出，一条也不写入。",
      "3. 导出：export 加上 priority 列。",
      "大家手上的旧数据文件要照常能用，财务的脚本也不能因为这次改动读错。补上测试，README 写明用法。"
    ].join("\n"),
    hidden: "team.test.js",
    expect: { development: true, tickets: true, review: true }
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
