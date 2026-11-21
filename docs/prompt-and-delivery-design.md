# 提示词与开发流程设计

状态：2026-11-20 草案，待确认。对应阶段 [P4.8](development-phases.md#p48提示词与开发流程)。

## 目标

1. Main、Executor、Reviewer 的提示词只写模型自己推断不出的内容，并有体积上限。
2. 把 Workloop 的开发流程做成产品自身的能力：状态和规则由程序保存和执行，Main 只做判断；用户和 Main 看到的是同一份进度。
3. 开发流程的骨架不绑定编码，后续的其他工作模式可以复用。

依据：Anthropic 与 OpenAI 的提示词指南、Pi、Claude Code 团队、Armin Ronacher、12-Factor Agents 的公开经验。共同结论是：提示词越短越好，只写模型推断不出的；规则要说明原因和适用范围，少用绝对禁止；会变化的信息放到消息里；工具的结果告诉模型下一步做什么；改动提示词要靠实测任务来比较。

## 一、提示词分层

| 层       | 内容                                                     | 什么时候发          | 上限              |
| -------- | -------------------------------------------------------- | ------------------- | ----------------- |
| 基础层   | 身份、做事方式、协作者、文件位置、何时询问用户、如何汇报 | 会话开始时写一次    | 4 KB              |
| 状态层   | 当前工作区路径、项目与需求、开发记录摘要                 | 内容变化时才发送    | 1.5 KB            |
| 流程层   | `requirement-delivery` 等内置技能                        | Main 判断需要时加载 | 单个技能 4 KB     |
| 工具层   | 工具说明；结果中给出下一步                               | 随工具一起发送      | 单个工具说明 1 KB |
| 消息层   | 附件清单、`/` `@` 引用、回调、协作者提问                 | 出现时随消息附带    | —                 |
| 程序保证 | 权限、路径保护、票冻结、改动范围检查、合入规则           | 不写进提示词        | —                 |

- 提示词统一用英文写；面向用户的界面文字和项目文档仍用中文。
- 规则先说明适用范围和原因，再给做法。"不要……"类写法只用于程序无法保证的真实边界。
- 体积由测试检查：每层超过上限即测试失败，提示词变长需要先删掉别的内容。工具层按每个工具的说明、工具清单里的一行和它带来的规则合计。
- 先只用一份通用的基础层。实测发现某类模型做不好时，再给那类模型补一段说明，不预先分档。

基础层草案见[附录](#附录基础层草案)。与现行 `cowork-main.md`（13.7 KB）相比，原有内容按下表转移：

| 原内容                                                           | 去向                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------- |
| 需求现场、审查、冻结候选、合入流程                               | `requirement-delivery` 技能，加上开发记录工具结果里的下一步 |
| `dependsOn`、协作者提问的回答方式、等待结果的方式、Reviewer 用法 | `call_subagent`、`send_subagent_message` 的工具说明         |
| 后台作业                                                         | `start_job` 的工具说明                                      |
| `read`/`edit`/`write`/`bash` 的选用                              | 各工具说明                                                  |
| 附件与引用的读取方式                                             | 消息层，出现时随消息附带                                    |
| 压缩与 `clear_context`                                           | 工具说明，以及压缩后的摘要消息                              |
| `memory.md` 进度笔记                                             | 删除，会话本身保留上下文，需求进度由开发记录和票提供        |
| Coordinator 的职责、CLI 与 App 共用核心等介绍                    | 删除                                                        |

Executor 与 Reviewer 的提示词按同样原则重写。协作者交回结果时统一包含三部分：结果、证据、试过但没走通的办法。

## 二、开发流程

### 现状与缺口

已有的部分：

- 开发记录：目标、完成标准、路线（`quick`/`direct`/`full`）、基线；
- 隔离现场；
- 固定候选审查；
- 续接原 Executor 返修；
- 项目共同合入入口；
- 交付记录。

缺少的部分：

- **票。** 拆分只存在于 Main 一次次的派单中，程序不知道一个需求有几张票、各自的范围与验收标准、做到了哪一张。
- **用户确认并冻结验收标准。** 完成标准由 Main 写入，用户没有确认环节，之后也可以被改写。
- **验收标准的检查方式。** 完成标准是纯文本，没有对应的检查命令。合入前程序无法自动重跑。
- **改动范围检查。** 候选改动是否越出约定的文件范围，程序不检查。
- **下一步提示。** 流程靠提示词里的长段说明来教，工具结果只返回数据，不说下一步做什么。
- **整体终审。** `full` 路线完成后，没有对整个需求的独立终审。

### 设计

**三个入口，由 Main 判断走哪个。** 骨架共用，三个入口经过的环节不同：

- `quick`：小而清楚的改动。Main 直接在现场完成并自检，不建票，自检通过后合入。
- `direct`：一张票，交给 Executor 执行，再由独立 Reviewer 审查。
- `full`：先写方案，再拆成多张票，按依赖关系调度；全部合入后做一次整体终审。

**票属于开发记录。** 每张票包含以下字段：

| 字段       | 说明                                                                |
| ---------- | ------------------------------------------------------------------- |
| 编号与标题 | —                                                                   |
| 改动范围   | 路径列表；`direct` 路线必填                                         |
| 验收标准   | 每条有编号，并写明检查方式：一条检查命令，或无法用命令检查的原因    |
| 保留不变   | 附近已有、必须继续可用的行为                                        |
| 本次不做   | 用户没有要求的相关改动                                              |
| 依赖       | 必须先完成的票                                                      |
| 状态       | 草稿 → 已确认 → 执行中 → 审查中 → 已通过 → 已合入；有缺陷时进入返修 |

**用户确认后冻结。** Main 提交票时，会话里显示票卡片，做法与 `manage_agent` 的定义卡片相同。用户确认后，验收标准冻结。之后要修改，必须记录用户的决定和理由。审查中的裁定只写在审查记录里，不回写到票上。

**派单可以绑定票，但不强制。** 探索、调研、核对资料等不属于某张票的工作照常派单，不传票。传入 `ticketId` 时，程序把票的目标、范围、验收标准、保留不变和本次不做写进任务说明，Main 只需补充背景。返修沿用原 Executor 的会话；合入后才发现的缺陷开一张新的修复票。

**程序替 Main 执行的检查：**

- 冻结候选时，检查改动的文件是否都在票的范围内；
- 合入集成现场时，先跑项目检查，再跑本票的验收命令；
- 合入前，检查集成现场是否包含当前目标分支的最新提交。

**每次结果都给出下一步。** `project_development` 的每次返回都带一个"下一步"字段，由当前状态算出。例如："票 02 已通过，依赖它的票 03 可以开始"，或"全部票已合入，请发起整体终审"。

**用户和 Main 看同一份进度。** 票和状态显示在看板与交付视图中。

**`memory.md` 直接删除，不需要替代。** Main 暂停后醒来、后端重启后，都用 `--continue` 接着原来的 Pi 会话，上下文还在；压缩时摘要取自完整历史。`sleep_until` 说明里"醒来后上下文可能是新的，先更新 memory"已与实现不符，一并删除。电脑操作的防重复改为：重启后若最后一次操作没有结果，先查看实际状态再决定是否重做，写进 CUA 技能。

### `requirement-delivery` 技能

技能只写程序替代不了的判断：

- 怎么选路线；
- 怎么拆票：按能独立验收的纵向切片拆，写清依赖；
- 验收标准怎么写：写清观察什么、在什么条件下、哪个平台；不用"所有""永不"这类无边界的词；
- 审查发现怎么裁定。

操作顺序由工具结果中的下一步给出，技能里不重复。

### 给其他工作模式预留

骨架是通用的：三个入口共用"需求 → 票（含验收标准）→ 执行 → 独立审查 → 交付"，`quick` 跳过票和独立审查。编码模式为它提供 Git 隔离现场、检查命令和合入。文档或调研模式以后提供各自的工作区、检查方式（命令或人工确认）和交付方式，骨架不变。

## 三、改为由程序保证

- 同步派出的协作者不注册向 Main 提问的工具。
- 技能统一通过一种方式加载。
- Reviewer 的能力说明只注入一次。目前在 `.pi/runtime/subagent-agent.ts` 中加了两次（第 469 行与第 496 行）。
- 票的冻结、改动范围检查和合入前的检查，见第二节。

## 四、实测

先准备 5～8 个真实任务作为对比基线，分两类：

- **能力类**：能不能做对。例如小修复、跨文件功能、需要拆票的需求、需要审查返修的需求。
- **行为类**：有没有让人厌烦的表现。例如做一半停下来问"要继续吗"、在不需要时询问用户、把简单任务派给协作者、汇报读不懂。

每次更换提示词或流程，用同一组任务和同一模型配置对比。主模型使用用户实际在用的配置。任务、运行方法和检查方式见 [scripts/eval](../scripts/eval/README.md)。

### 基线（现行提示词，2026-11-20）

模型 DeepSeek-V4.1-Flash，每个任务跑 2 次。

| 任务       | 检查 | 用时（分钟） | tokens（万） | 派协作者 | 问用户 | 备注                                 |
| ---------- | ---- | ------------ | ------------ | -------- | ------ | ------------------------------------ |
| 小修复     | 2/2  | 0.5、0.5     | 16、19       | 0        | 0      | 只改了出错的文件                     |
| 跨文件功能 | 2/2  | 0.8、1.0     | 25、41       | 0        | 0      | 一次在用户仓库里直接用了 `git stash` |
| 完整需求   | 2/2  | 1.3、4.1     | 45、119      | 0、1     | 0      | 两次都没建开发记录，直接在项目里改   |
| 简单提问   | 2/2  | 0.3、0.3     | 7、5         | 0        | 0      | 直接作答                             |
| 多步杂活   | 2/2  | 0.7、0.7     | 24、22       | 0        | 0      | 没有中途停下                         |

结论：能力类全部做对，没有出现中途停下或多余提问。需要改进的是流程：多部分需求没有走开发记录，第二次派了一个只读审查者，tokens 是第一次的 2.6 倍。汇报都能看懂，但偏长，多数以“需要的话我可以……”结尾。

### 第 3 步后（英文基础层，2026-11-20）

同一模型，5 个任务各跑 2 次，全部通过检查；小修复、简单提问和多步杂活的 tokens 与基线相当或更少，没有再用 `git stash`。第一轮有 2 次用英文回复中文提问，基础层加了“用用户的语言回复”，补跑跨文件功能和完整需求各 2 次后都改用中文。

补跑中 Main 开始按 `requirement-delivery` 走开发记录：

| 任务       | 路线         | 用时（分钟） | tokens（万） | 结果                                 |
| ---------- | ------------ | ------------ | ------------ | ------------------------------------ |
| 跨文件功能 | quick ×2     | 1.5、1.8     | 59、68       | 在隔离现场完成并合入，约为基线 2 倍  |
| 完整需求   | 未建、direct | 1.6、11.3    | 48、517      | direct 那次派 4 个协作者、审查后合入 |

流程能走通，但小需求也走流程、完整流程开销很大。何时走哪条路线、怎样减少开销，留给第 4～6 步（票、判断型技能、协作者交回格式）。

### 第 6 步后（票、判断型技能、协作者交回格式，2026-11-20）

同一模型，5 个任务各跑 2 次，全部通过检查，都用中文回复，没有中途停下、没有问用户、没有用 `git stash`。

| 任务       | 路线     | 用时（分钟） | tokens（万） | 派协作者 | 与基线比                         |
| ---------- | -------- | ------------ | ------------ | -------- | -------------------------------- |
| 小修复     | 未建     | 0.7、0.6     | 17、17       | 0        | 相当；只改了出错的文件           |
| 跨文件功能 | 未建     | 0.8、0.8     | 26、24       | 0        | 相当；第 3 步后的 59、68 降回来  |
| 完整需求   | quick ×2 | 2.3、2.3     | 88、81       | 0        | 两次都建记录、在隔离现场做完合入 |
| 简单提问   | 未建     | 0.4、0.4     | 7、8         | 0        | 相当；直接作答，没改文件         |
| 多步杂活   | 未建     | 0.7、0.8     | 19、24       | 0        | 相当                             |

结论：

- 路线判断变准了：单文件和跨文件的小改动直接做，不再走流程；多部分需求两次都建了开发记录并合入，验收标准写成了可观察的命令和输出。
- 完整需求的开销稳定了：两次都在 81～88 万，没有再出现 517 万那样的情况；比基线（45、119）平均略高，多出的是建记录、隔离现场和合入。
- 这组任务都没有派协作者，所以 Executor、Reviewer 的新提示词和 `full` 路线终审没有被实测覆盖，只有自动测试。要实测它们，需要再加一个明确需要拆票或独立审查的任务。
- 汇报仍偏长，10 次里有 6 次以"需要的话……""告诉我"之类结尾，提的多是确实没做的相关点（如 CSV 没加列），不算多余提问。

### 补测：多人在用的需求（2026-11-20）

新任务 `team`：好几个人共用数据文件，导出的 CSV 被财务脚本按列位置读取，要加优先级、导入、导出优先级列三样。提示里不提票和审查。同一模型跑 2 次，隐藏检查都 7/7 通过。

| 次  | 路线   | 票  | 审查                | 用时（分钟） | tokens（万） | 不含缓存（万） | 派协作者 |
| --- | ------ | --- | ------------------- | ------------ | ------------ | -------------- | -------- |
| 1   | direct | 1   | 审 2 次：先未过再过 | 14           | 780          | 35             | 5        |
| 2   | 未建   | 0   | 无                  | 1.8          | 34           | 3              | 0        |

- 第 1 次走得完整：建了记录，一张票交给 Executor；Main 自己核对时发现回车符导出和导入不对称，退回修改；Reviewer 逐条复跑验收标准，还用改坏代码的方法查出列数检查没被测试钉住；Main 把 5 条发现中的 2 条判为修复，交回同一个 Executor 改，复审通过后合入。导出列的位置两次都保持不变。
- 但两次判断不一致：第 2 次直接在项目里改完，没建记录，也没提交，留给用户自己看。
- 两次都没拆票：三样东西改的是同一批文件（`cli.js`、`store.js`、`export.js`），Main 把它们当作一个整体。`full` 路线和整体终审仍没有被真实任务触发。
- 开销：总 tokens 的 95% 是每次回复重读的缓存；不含缓存约 35 万，比第 3 步那次 direct（56 万）少。用时主要花在 Main 自己 61 次回复和 Reviewer 的变异测试上。
- 脚本修正：确认卡片按用户同意处理，不算提问；派单记录没有角色，是否审查改看审查记录；结果加记不含缓存的 tokens。

## 实施顺序

每一步单独开分支、单独合入。

1. 修复第三节的三处代码矛盾。
2. 建立实测任务集，并在现行提示词上记录基线。
3. 英文基础层，并精简工具说明；加入体积测试。原提示词里的开发流程先原样译成英文放进 `requirement-delivery` 技能，CUA 技能压到上限以内。
4. 实现票，分三个分支：
   - 4a：票的数据与修订、确认卡片、下一步字段；
   - 4b：派单绑定票；每张票在自己的现场上冻结和审查，冻结时检查改动范围；审查通过后由程序并进集成现场，先跑项目检查，再跑本票的验收命令；
   - 4c：看板与交付视图显示票。

   "合入前检查集成现场是否包含目标分支最新提交"不另做：现有合入先把候选与目标分支最新版本组合，再在组合版本上跑检查。

5. 把 `requirement-delivery` 技能改写成只讲判断；删除 `memory.md` 及相关说明，修正 `sleep_until` 与 CUA 技能中的对应内容。
6. 重写 Executor 与 Reviewer 的提示词，统一交回格式；实现 `full` 路线的整体终审。
7. 用实测任务集对比，记录结果。

## 待定

- **对外 Main 的票由谁确认。** 对外需求由 Router 转达，客户不直接看到票。初步考虑由项目负责人确认，随 P5 一起定。
- **长期记忆。** 不在本阶段，放到 [P4.9](development-phases.md#p49记忆与上下文压缩) 与上下文压缩一起重新设计。

## 附录：基础层草案

```markdown
# CoworkOS Main Agent

You are the Main Agent of CoworkOS. The user hands you a task; you see it through to delivery. If asked which model you are, answer from the model actually connected.

## Doing the work

- When the user asks for something, do it rather than only suggesting it. Before acting, open or look up the relevant code, files and sources, and base your answer on what you saw.
- The project belongs to the user. Follow its existing structure and style, change what the task needs, and mention other problems you notice instead of fixing them unasked.
- Errors, timeouts and empty results are ordinary obstacles: find the cause and try another way. Limits someone set on purpose — files marked off-limits, access that was not granted, safety rules — stay in place; say what you found and look for another safe way.
- Check results in proportion to the change: reread a small edit, run the relevant tests for code, preview pages and images.
- The context is compacted automatically when it fills up, so keep going. End the turn when the task is done and checked and no collaborator result is still pending.

## Requirements and other tasks

- A requirement is a feature, fix or change of behaviour the user wants in a Git project. Load the `requirement-delivery` skill and work through a development record, even for a small change: its `quick` route is you editing and checking alone, and the program records and merges. Never change the user's working tree for a requirement.
- Everything else, such as questions, investigations, documents, one-off scripts and file handling, needs no record: just do it.

## Collaborators

- Each collaborator costs extra time and money. Do simple tasks, single-file edits and work that needs continuity yourself instead of delegating them; delegate independent work that can run in parallel, or work that needs a clean context or an independent judgment.
- Brief a collaborator as a colleague who has not seen this conversation: the goal, the scope, where the inputs are, what to hand back, and how to tell it is right.
- A collaborator's "succeeded" means it finished running. Confirm the work from the files, command output or tests it hands back.

## Files

`<current_workspace>` gives the real paths of the project directory, your scratch directory and the delivery directory. "This project" means the project directory, and relative paths start there; the CoworkOS installation directory is not the user's project. Outside a requirement, edit project files in place; put standalone reports, images and tables in `artifacts/`, and drafts and intermediate files in `work/`.

## When to ask the user

- When missing information would change the approach, ask with `askhuman` and keep working on whatever does not depend on the answer. Otherwise proceed on the most reasonable reading.
- Local, reversible actions need no approval: reading and writing project files, running commands and tests, delegating to collaborators.
- These are hard to undo or affect other people, so explain the impact and wait for the user's approval: deleting the user's files or data, or overwriting content you were not asked to change; publishing or sending anything outside, pushing code, changing shared systems; noticeable spending or tying up the machine for a long time; shortcuts such as skipping checks.

## Talking to the user

- Before longer work, say in one sentence what you are about to do; then give a one-line update every few steps.
- Write the final reply for someone who has not seen the work: the conclusion first, then what you did, where the files are and how you checked, and finally what remains unchecked. If only part is done, say where you stopped; report anything that did not succeed as not done.
- Reply in the language the user writes in. Use plain words and names the user knows, and talk about results and trade-offs.
```
