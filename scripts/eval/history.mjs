/**
 * The ledger of an older project, written before a retrieval task starts.
 *
 * Each requirement is a long-lived feature whose summary states how it
 * behaves now, the way a project keeps its ledger once a requirement carries
 * many developments. The rules a task depends on sit in the summaries of a
 * few features, and the date rule in the repository's architecture decisions
 * (`repoFiles`); nothing in a task's prompt names a rule.
 */

/** @typedef {{ title: string, summary: string, history: string[], status?: "active" | "retired" }} Feature */

/** @type {Feature[]} */
export const history = [
  {
    title: "列表显示",
    summary: [
      "list 每行是 [x]/[ ] 编号. 标题 #标签。",
      "行末的附加信息统一写成方括号 [<字段名> <值>]，比如 [due 2026-01-02]；多个时用一个空格隔开。",
      "输出不加颜色和装饰字符，有人用脚本处理 list 的结果。"
    ].join(""),
    history: [
      "2025-09-02 首次交付 list",
      "2025-11-20 定下行末附加信息的方括号写法",
      "2026-01-15 撤掉灰色显示已完成条目"
    ]
  },
  {
    title: "分页与排序",
    summary:
      "list 支持 --page 和 --size，默认每页 10 条，--size 最大 100，超过按 100 算，末尾显示 page N/M。--sort id|title，标题用普通字符串比较，不做拼音排序。",
    history: ["2025-09-10 加分页", "2025-10-03 加按标题排序"]
  },
  {
    title: "搜索",
    summary: "search 只匹配标题，不区分大小写，不匹配标签。",
    history: ["2025-09-18 首次交付", "2025-12-01 改为不区分大小写"]
  },
  {
    title: "导出给财务的 CSV",
    summary: [
      "export 按 CSV 输出全部条目，现在的列是 id,title,done,tags。",
      "财务每周用脚本按列的位置把导出结果读进他们的表格：以后加列只能追加在最后一列后面，不能插到中间，已有列名也不能改。",
      "旧条目缺某个字段时，那一列留空。"
    ].join(""),
    history: [
      "2025-10-12 首次交付 export",
      "2026-02-10 财务换了新系统，日期改用 YYYY-MM-DD，见 docs/adr/0002-dates.md"
    ]
  },
  {
    title: "数据文件",
    summary: [
      "数据默认存在当前目录的 todo.json；环境变量 TODO_FILE 指定路径，组里大家在共享盘上指向同一个文件。",
      "JSON 用两个空格缩进，末尾留一个换行。",
      "新字段都用一个英文小写单词命名，比如创建日期叫 created，截止日期叫 due。",
      "旧数据文件不能要求迁移：旧条目缺新字段时照常读，list 不显示那一项。"
    ].join(""),
    history: ["2025-09-02 首次交付", "2025-10-20 加 TODO_FILE", "2026-01-08 定下新字段命名和旧文件兼容的规矩"]
  },
  {
    title: "错误输出",
    summary: "命令出错时错误写到 stderr，格式 error: <说明>，退出码 1。",
    history: ["2025-09-25 统一错误输出"]
  },
  {
    title: "条目标题",
    summary: "标题必填，最长 200 个字符，超过时报错，不截断。",
    history: ["2025-11-02 加长度限制"]
  },
  {
    title: "标签",
    summary: "add --tag 给条目加标签；标签只允许字母、数字和中划线。",
    history: ["2025-09-05 首次交付", "2025-12-12 限定标签字符"]
  },
  {
    title: "完成条目",
    summary: "done <编号> 把条目标为完成。计划让 done 一次接受多个编号（done 1 3 5），还没做。",
    history: ["2025-09-02 首次交付"]
  },
  {
    title: "优先级",
    summary: "条目分高、中、低三档，还没开始做。",
    history: ["2026-02-20 用户提出"]
  },
  {
    title: "归档已完成条目",
    summary: "archive 把已完成的条目移到另一个文件，还没开始做。",
    history: ["2026-02-25 用户提出"]
  },
  {
    title: "从 CSV 导入",
    summary: "不做：大家直接共用一个数据文件，不需要导入。",
    history: ["2025-11-15 讨论后停用"],
    status: "retired"
  },
  {
    title: "到期提醒",
    summary: "不做系统通知。",
    history: ["2026-01-20 讨论后停用"],
    status: "retired"
  }
];

/** Files of the project that came with its history: its instructions and its architecture decisions. */
export const repoFiles = {
  "AGENTS.md": [
    "# 开发约定",
    "",
    "- 测试只用 node --test，不引入第三方测试库。",
    "- 不加任何 npm 依赖，只用 Node 自带的模块。",
    "- 开工前读 docs/adr/ 里与要改区域相关的架构决定；被取代的旧决定只在 docs/adr-history.md 里留一行，不再约束实现。",
    ""
  ].join("\n"),
  "docs/adr/0002-dates.md": [
    "# 0002 日期格式",
    "",
    "状态：生效（2026-02-10），取代 0001。",
    "",
    "财务换了新系统。所有日期一律写成 YYYY-MM-DD，存储、list 和 export 都一样。",
    "需要“今天”的地方读环境变量 TODO_TODAY（YYYY-MM-DD），没设时用系统当天日期，方便测试。",
    ""
  ].join("\n"),
  "docs/adr-history.md": [
    "# 被取代的架构决定",
    "",
    "| 决定 | 内容 | 被谁取代 |",
    "| --- | --- | --- |",
    "| 0001 日期显示 | 日期一律显示成 MM/DD/YYYY，跟财务旧表格一致 | 0002（2026-02-10，财务换了新系统） |",
    ""
  ].join("\n")
};

/**
 * The feature the creation date became, for the task that builds on it. Its
 * summary holds the one rule the follow-up request depends on.
 */
export const createdFeature = {
  title: "创建日期",
  summary: [
    "add 时记下创建日期，字段 created，格式 YYYY-MM-DD，取 TODO_TODAY 或系统当天；list 行末显示 [created <日期>]，export 在最后一列加 created。",
    "共享盘上的老条目没有创建日期：按日期筛选时这些老条目一律保留，不能被筛掉，大家还要看到它们。"
  ].join(""),
  history: ["2026-03-04 首次交付"]
};

/**
 * A feature recorded twice: an earlier Main took a request on export's
 * columns for a new feature. A ledger tidy should fold it into the export
 * feature, keeping both rules.
 */
export const duplicateFeature = {
  title: "CSV 列",
  summary: "export 输出的 CSV 列：id,title,done,tags；表头行固定在第一行，不能省略。",
  history: ["2026-02-28 把表头行固定下来"]
};

/** The old ledger keeps no history or summary of its own: both go into the requirement's content. */
function oldContent(feature) {
  return `${feature.summary}\n\n历史：\n${feature.history.map((line) => `- ${line}`).join("\n")}`;
}

/** Write the history into a project's ledger through the product API. */
export async function seedLedger(post, entries = history) {
  for (const entry of entries) {
    const { requirement } = await post({ action: "create", title: entry.title, content: oldContent(entry) });
    await post({
      action: "update",
      requirementId: requirement.requirementId,
      expectedRevision: requirement.revision,
      status: entry.status === "retired" ? "withdrawn" : "delivered"
    });
  }
}

/** The ledger's titles, to tell what a run created or merged. */
export async function ledgerTitles(post) {
  const { requirements } = await post({ action: "query", limit: 200 });
  return requirements.map((requirement) => requirement.title);
}
