/**
 * The ledger of an older project, written before the `history` task starts.
 *
 * Six requirements hold the rules the new request depends on; one of their
 * decisions was later retracted by another. The rest is ordinary history of
 * the same tool, so a search has to tell the relevant rules from the noise.
 * Nothing in the task's prompt names a rule; it only says to follow them.
 */
export const history = [
  {
    title: "分页",
    content: "list 支持 --page 和 --size 分页，末尾显示 page N/M。",
    status: "delivered",
    decisions: ["默认每页 10 条，--size 最大 100，超过按 100 算。"]
  },
  {
    title: "搜索忽略大小写",
    content: "search 匹配标题时不区分大小写。",
    status: "delivered",
    decisions: ["只匹配标题，不匹配标签。"]
  },
  {
    title: "导出给财务用的 CSV",
    content: "新增 export 命令，按 CSV 输出全部条目。财务每周用脚本把导出结果读进他们的表格。",
    status: "delivered",
    decisions: [
      "导出的列顺序固定，财务的脚本按列的位置读：以后加列只能追加在最后一列后面，不能插到中间，已有列名也不能改。"
    ]
  },
  {
    title: "按标题排序",
    content: "list --sort title 按标题排序。",
    status: "delivered",
    decisions: ["用普通字符串比较，不做拼音排序。"]
  },
  {
    title: "日期显示",
    content: "条目里出现日期时怎么显示。",
    status: "delivered",
    decisions: [{ text: "日期一律显示成 MM/DD/YYYY，跟财务的表格一致。", retracted: true }]
  },
  {
    title: "错误输出",
    content: "命令出错时的输出方式。",
    status: "delivered",
    decisions: ["错误统一写到 stderr，格式 error: <说明>，退出码 1。"]
  },
  {
    title: "数据文件位置",
    content: "数据文件默认是当前目录的 todo.json。",
    status: "delivered",
    decisions: ["用环境变量 TODO_FILE 指定数据文件路径，大家在共享盘上指向同一个文件。"]
  },
  {
    title: "截止日期",
    content: "add 支持截止日期，list 显示，过期标出来。",
    status: "withdrawn",
    decisions: ["先不做，等财务确认要不要。"]
  },
  {
    title: "字段命名",
    content: "数据文件和导出里新字段怎么起名。",
    status: "delivered",
    decisions: ["新字段都用一个英文小写单词命名，比如创建日期叫 created，截止日期叫 due。"]
  },
  {
    title: "完成多个条目",
    content: "done 一次接受多个编号，比如 done 1 3 5。",
    status: "open",
    decisions: []
  },
  {
    title: "从 CSV 导入",
    content: "import 命令读入 export 导出的文件。",
    status: "withdrawn",
    decisions: ["大家直接共用一个数据文件，不需要导入。"]
  },
  {
    title: "彩色输出",
    content: "list 里已完成的条目显示成灰色。",
    status: "withdrawn",
    decisions: ["不做彩色输出，list 的结果有人用脚本处理。"]
  },
  {
    title: "测试方式",
    content: "项目的测试怎么写。",
    status: "delivered",
    decisions: ["测试只用 node --test，不引入第三方测试库。"]
  },
  {
    title: "list 行末附加信息",
    content: "list 每行除了编号、标题和标签以外的信息怎么显示。",
    status: "delivered",
    decisions: [
      "list 每行末尾的附加信息统一写成方括号，格式 [<字段名> <值>]，比如 [due 2026-01-02]；多个时用一个空格隔开。"
    ]
  },
  {
    title: "优先级",
    content: "条目分高、中、低三档优先级。",
    status: "open",
    decisions: []
  },
  {
    title: "不加依赖",
    content: "项目依赖的约定。",
    status: "delivered",
    decisions: ["不加任何 npm 依赖，只用 Node 自带的模块。"]
  },
  {
    title: "日期格式统一（财务换了新系统）",
    content: "财务换了新系统，日期格式跟着改。",
    status: "delivered",
    decisions: [
      "推翻之前的 MM/DD/YYYY：所有日期一律用 YYYY-MM-DD。需要“今天”的地方读环境变量 TODO_TODAY（YYYY-MM-DD），没设时用系统当天日期，方便测试。"
    ]
  },
  {
    title: "归档已完成条目",
    content: "archive 命令把已完成的条目移到另一个文件。",
    status: "open",
    decisions: []
  },
  {
    title: "标签字符",
    content: "标签能用哪些字符。",
    status: "delivered",
    decisions: ["标签只允许字母、数字和中划线。"]
  },
  {
    title: "旧数据文件兼容",
    content: "共享盘上有大家用了很久的旧数据文件。",
    status: "delivered",
    decisions: ["旧数据文件不能要求迁移：旧条目缺新字段时照常读，list 不显示那一项，export 里那一列留空。"]
  },
  {
    title: "提醒通知",
    content: "到期前发系统通知。",
    status: "withdrawn",
    decisions: []
  },
  {
    title: "标题长度",
    content: "条目标题的长度限制。",
    status: "delivered",
    decisions: ["标题最长 200 个字符，超过时报错，不截断。"]
  },
  {
    title: "按标签搜索",
    content: "search 支持 #标签 的写法只找带这个标签的条目。",
    status: "open",
    decisions: []
  },
  {
    title: "README 语言",
    content: "README 要不要改成中文。",
    status: "withdrawn",
    decisions: ["README 保持英文。"]
  },
  {
    title: "数据文件格式",
    content: "todo.json 的写法。",
    status: "delivered",
    decisions: ["JSON 用两个空格缩进，末尾留一个换行。"]
  }
];

/** Write the history into a project's ledger through the product API. */
export async function seedLedger(post) {
  for (const entry of history) {
    let { requirement } = await post({ action: "create", title: entry.title, content: entry.content });
    for (const decision of entry.decisions) {
      const { text, retracted } = typeof decision === "string" ? { text: decision } : decision;
      ({ requirement } = await post({
        action: "decide",
        requirementId: requirement.requirementId,
        expectedRevision: requirement.revision,
        text
      }));
      if (retracted)
        ({ requirement } = await post({
          action: "set_decision_effective",
          requirementId: requirement.requirementId,
          decisionId: requirement.decisions.at(-1).decisionId,
          expectedRevision: requirement.revision,
          effective: false
        }));
    }
    if (entry.status !== "open")
      await post({
        action: "update",
        requirementId: requirement.requirementId,
        expectedRevision: requirement.revision,
        status: entry.status
      });
  }
}
