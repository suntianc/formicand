# 开发

先读 [AGENTS](../AGENTS.md)。本页是开发标准和架构说明：环境、代码地图、进程、数据布局、接口、修改流程、检查命令、打包和发布。测试的写法和跑法见 [测试](testing.md)，上手和配置见 [产品说明](../README.zh-CN.md)。

## 环境

- Node.js ≥22.19.0、npm、Git。依赖以锁文件为准，用 `npm ci` 安装。
- Mac App 和窗口操作需要 macOS 14+、Apple Silicon 和 Xcode Command Line Tools。
- 附件解析的测试需要 Python 3.11 和 [scripts/document-requirements.txt](../scripts/document-requirements.txt) 里的库，用 `FORMICAND_PYTHON` 指向这个 Python。

| 要开发的 | 准备                                                          | 启动                                       |
| -------- | ------------------------------------------------------------- | ------------------------------------------ |
| CLI      | `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`、`npm run build:cli` | `npm run cli`、`npm start`                 |
| Web      | `npm ci`、`npm run build`                                     | `npm run ui`，默认 `http://127.0.0.1:3880` |
| Mac App  | `npm ci`                                                      | `npm run desktop`                          |

## 运行和调试

- **用隔离的数据。** 开发和测试不要碰真实的任务、模型设置和文档。设置 `FORMICAND_HOME` 换一整套数据目录，只隔离桌面数据用 `FORMICAND_DESKTOP_DATA`。
- **开发版 App。** `npm run desktop` 构建后启动 `Formicand Dev`。`npm run desktop:install-dev` 把它装成固定的 `~/Applications/Formicand Dev.app`，可以从 Finder 或 Dock 打开，读的是当前仓库的代码；仓库换了位置要重新安装。开发版和正式版共用数据目录和单实例锁，不能同时打开。
- **系统权限。** 验收屏幕录制和辅助功能时，从 Finder 或 `npm run desktop` 打开 App，不要直接执行 `Contents/MacOS/` 里的程序，否则权限会记到终端名下。每次开发运行时的身份不同，需要在系统设置里给对应的 `Formicand Dev` 条目授权。
- **只改页面。** 改了前端模块或样式后运行 `npm run build:web-assets` 再刷新；持续开发时另开终端运行 `npm run watch:web-assets`。改了 TypeScript 或 Swift 要重新构建并重启。
- **独立后端。** `formicand backend start|status|stop` 单独管理后端。实例信息在 `~/.formicand/runtime/backend-instance.json`。同一个数据目录只会有一个后端，再启动会复用已有的那个。
- **更新源码。** `formicand update --check` 和 `formicand update` 按当前分支的 Git 上游更新并重新构建 CLI。有未提交改动、本地独有提交、分叉或处于合并中时会拒绝更新。

## 代码地图

```text
scripts/formicand.mjs   CLI 启动器：init、doctor、start 等
scripts/                构建、打包、开发启动、测试和文档检查
src/cli/                可执行入口
src/dashboard/          后端：HTTP/SSE、服务装配、Main 进程生命周期、派单
src/runtime/            Pi 进程、上下文、恢复、收件箱、模型连接、配置
src/tools/              文件、命令、后台任务、联网等工具的实现
src/workspace/          任务数据、附件、产出物、项目和项目数据服务
src/storage/            事件文件、文件锁、项目数据库适配
src/domain/             领域类型
src/gui/、src/security/ 浏览器、窗口操作和执行权限
src/platform/           平台相关的小工具
.pi/extensions/         Pi 扩展入口
.pi/runtime/            Pi 生命周期装配和按领域分的工具
.pi/skills/             随产品附带的技能
web/                    页面：原生 ES modules
desktop/                Electron 主进程、preload、凭据加密、退出保存
test/                   Node 行为、协议和生命周期测试
e2e/                    浏览器和 Electron 用户流程测试
```

构建产物在 `dist/`、`build/` 和 `.tmp/`，改源码后重新构建，不要直接改产物。

要改某个行为时从这里找起：

| 要改的                     | 先看                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main 的提示词和上下文      | [extension](../.pi/runtime/extension.ts)、`.pi/runtime/` 下的上下文模块                                                                                                                |
| 新增一个 Main 工具         | 按领域放进 [.pi/runtime/tools/](../.pi/runtime/tools/)，再登记到 [capabilities](../.pi/runtime/tools/capabilities.ts) 的核心工具或某个工具组                                           |
| 派单、子代理角色和工具     | [coordination](../.pi/runtime/tools/coordination.ts)、[子代理后端](../src/dashboard/subagent-backend.ts)、[进程结算](../src/runtime/subagent-processes.ts)                             |
| 需求台账、开发、审查、合入 | [project_ledger](../.pi/runtime/tools/project-ledger.ts)、[project_development](../.pi/runtime/tools/project-development.ts)、[项目数据服务](../src/workspace/project-data-service.ts) |
| 模型连接和请求重试         | [model-connection](../src/runtime/model-connection.ts)、[model-profile](../src/runtime/model-profile.ts)、[main-request-retry](../src/runtime/main-request-retry.ts)                   |
| 配置项                     | [config](../src/runtime/config.ts)、[runtime-settings](../src/runtime/runtime-settings.ts)                                                                                             |
| HTTP 接口                  | [routes](../src/dashboard/routes.ts) 和对应的 `*-routes.ts`、`*-service.ts`                                                                                                            |
| 页面                       | [app](../web/app.js)、[controllers](../web/assets/controllers/)、[ui](../web/assets/ui/)                                                                                               |
| 运行指示与动效             | [motion](../web/assets/ui/motion.js)、[CSS 动效](../web/assets/styles/motion.css)、[时长与缓动](../web/assets/ui.css)                                                                  |
| 桌面动效                   | [播放选择](../web/assets/ui/native-motion.js)、[动效桥](../desktop/motion.cjs)、[系统图层](../desktop/motion.mm)                                                                       |
| 桌面窗口、IPC、退出        | [main](../desktop/main.cjs)、[preload](../desktop/preload.cjs)                                                                                                                         |
| CLI 命令                   | [formicand.mjs](../scripts/formicand.mjs)、[src/cli/](../src/cli/)                                                                                                                     |
| 浏览器和窗口操作           | [browser-use](../src/gui/browser-use.ts)、[computer-use](../src/gui/computer-use.ts)、[输入格式](../src/gui/browser-contracts.ts)、[Pi 工具](../.pi/runtime/tools/browser-use.ts)      |
| 看图                       | [read-image](../src/tools/read-image.ts)                                                                                                                                               |
| CUA 脚本                   | [cua-script-guest](../src/tools/cua-script-guest.js)                                                                                                                                   |

改的时候：

- **修一个用户流程**：先找到出问题的那一层和它的消费者，补一个能复现的测试，再改实现，不要在入口文件里加分支绕过去。
- **加一个工具**：按领域放进对应模块，参数用 typebox 定义；改了工具就同步更新 [内置能力](../README.zh-CN.md#内置能力) 和相关测试。
- **拆一个大模块**：先按职责拆出新文件，保持对外接口不变，测试全过后再调整调用方。

## 架构

```text
Mac App (desktop/) ──┐
浏览器页面 (web/) ───┼── HTTP / SSE ──→ 后端 src/dashboard/ ──→ 运行时 src/runtime/
CLI (src/cli/) ──────┘                         │                    │
                                               │                    ├→ Main 进程（Pi，常驻）
                                               │                    └→ 子代理进程（Pi，每个工作项一个）
                                               ├→ 窗口操作 src/gui/、权限 src/security/
                                               └→ 任务数据 src/workspace/、存储 src/storage/、类型 src/domain/
```

Main 和子代理都是独立的 Pi coding agent（`@earendil-works/pi-coding-agent`）进程。Formicand 通过 Pi 扩展 `.pi/extensions/formicand.ts` 给它们装上自己的工具、上下文和提示词，不修改 Pi 本身。

依赖方向：可复用的服务不导入 CLI 入口；`src/runtime/` 不导入后端 HTTP 层；`src/gui/` 不导入 HTTP 或 CLI。ESLint 和 [架构回归](../test/architecture-boundaries.test.js) 检查这些方向。Pi 包的导入边界和允许清单见 [AGENTS 的 Pi 依赖边界](../AGENTS.md#pi-依赖边界)。

### 各层职责

| 层         | 负责                                           | 主要入口                                                                                                                                          |
| ---------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI        | 命令参数、诊断、启动和信号                     | [启动器](../scripts/formicand.mjs)、[CLI](../src/cli/formicand.ts)、[后端入口](../src/cli/dashboard.ts)                                           |
| 页面       | 导航、展示、草稿、SSE 订阅和用户交互           | [app](../web/app.js)、[controllers](../web/assets/controllers/)、[UI](../web/assets/ui/)                                                          |
| 后端       | 服务装配、HTTP/SSE 路由、Main 进程的启动和停止 | [application](../src/dashboard/application.ts)、[routes](../src/dashboard/routes.ts)、[Run 服务](../src/dashboard/run-service.ts)                 |
| 运行时     | Pi 进程、派单、收件箱、恢复、完成判定          | [Coordinator](../src/runtime/coordinator-runtime.ts)、[子代理后端](../src/dashboard/subagent-backend.ts)、[进程](../src/runtime/agent-process.ts) |
| 进程宿主   | 子进程组、防重复启动、限时关闭                 | [ProcessHost](../src/runtime/process-host.ts)                                                                                                     |
| Pi 接入    | Pi hook、工具注册、上下文装配                  | [扩展入口](../.pi/extensions/formicand.ts)、[runtime](../.pi/runtime/extension.ts)、[tools](../.pi/runtime/tools/)                                |
| 窗口与权限 | 窗口授权、观察和动作、串行队列、执行权限       | [ComputerUse](../src/gui/computer-use.ts)、[权限](../src/security/execution-permissions.ts)                                                       |
| 数据       | 任务数据、附件、产出物、事件、文件锁、项目数据 | [工作区](../src/workspace/)、[存储](../src/storage/)、[领域类型](../src/domain/)                                                                  |
| 桌面       | 原生窗口、可信 IPC、加密凭据、退出前保存       | [main](../desktop/main.cjs)、[preload](../desktop/preload.cjs)、[backend](../desktop/backend.cjs)                                                 |

## 进程与生命周期

**后端独立于客户端。** 后端可以单独运行（`formicand backend start|status|stop`）。关掉 App 只关窗口，后端和正在跑的任务继续，下次打开连回同一个后端。

**Main 常驻。** 一次 Run 由同一个 Pi 进程服务，一轮结束后进程不退出，后续消息和回调由它接着处理。Main 在这几种情况下才结束：关闭会话、空闲超时、模型请求无法继续。空闲退出会保留会话，下一条消息重新拉起。后端重启后，会重新接管仍在运行的 Main。

**派单经过后端。** Main 调 `call_subagent` 只是向后端登记一个工作项。后端把它写进这次 Run 的持久队列，按依赖启动一个独立的子代理 Pi 进程，结束后把结论写回队列并回调 Main。派单只有异步一种；本轮必须等结果时用 `wait_for_subagents`。每个数据目录只有一个后端负责启动和结算子代理，后端重启后从持久记录接管。

**收件箱送达消息。** 发给 Main 或子代理的回调、追加消息、提问的回答和同伴消息，都先写进目标进程自己的持久收件箱。进程在每个回合边界重读收件箱；空闲时由写入方发一次通知唤醒。消息进入会话上下文后才记为已读，所以后端重启前后都能送达，而且每条只读一次。

**完成判定由程序做。** 状态和输出落盘后才算完成，不能拿最后一条回复代替。完成判定会检查有没有没结束的派单、后台任务、待回答的提问和未读消息。

**会话与上下文。** Pi 自己保存追加式会话记录。上下文快满时由 Formicand 换窗：模型写总结，程序带上必要的记录，接着在同一会话里继续。总结和新会话的标题由主机设置的辅助模型写（`src/runtime/utility-model.ts`，标题在 `src/dashboard/session-titles.ts`），没设置或请求失败时用会话自己的模型。会话笔记和历史查询按会话隔离。

## 需求交付流程

Main 按 Workloop 式的流程交付需求，代码默认由 Main 自己写，状态和规则由程序保存和执行：

1. **需求台账**（`project_ledger`）：每个项目的长期需求、现状和历史。
2. **需求开发记录**（`project_development`）：为需求建一个独立的 `git worktree` 现场，放在 `~/.formicand/runtime/development-workspaces/` 下，不碰用户自己的工作目录。
3. **票**：范围、带检查方式的验收标准、保留不变的部分、本次不做的事和依赖。用户确认后冻结。
4. **写票**：Main 用 `start_ticket` 开工，程序从需求现场分出这张票自己的 worktree，Main 在里面写、提交后送审。能和 Main 并行、互不干扰的票才派给 Executor，它在自己的 worktree 里工作，交回时用 `submit_report` 逐条报告验收标准。
5. **审查**：Reviewer 审一个冻结的候选提交，用 `submit_review` 交回 `pass` 或 `changes_requested`。拦截的发现必须引用验收标准，或属于回归、数据丢失、安全、项目规则四类底线之一。
6. **返修**：票回到返修状态后先检查剩余轮数。Main 写的票由 Main 在原 worktree 里改好再送审；Executor 写的票用 `continueCallId` 在原 Executor 的会话和工作区继续。用尽轮数时，Main 在最近一次失败的审查上记录下一步做法；若选择更换 Executor，票留在返修状态，供新的 Executor 接手。
7. **并入需求现场**：每张票审查通过后由程序并进需求现场（`integrate_ticket`），先跑项目检查，再跑本票的验收命令；`full` 的整体终审只在全部票并入之后冻结。
8. **终审**：`full` 路线冻结整体终审时必须先写对照表（`mapping`，每行一条要求和证明它的测试、命令或文件），程序编行号，拦截发现可以直接引用行号。冻结前程序还检查项目 `AGENTS.md` 的文档登记表：还没有表就要求建表并登记现有文档，新加或改名的 Markdown 没登记、登记行指向已删文档、同类同领域出现两份时拒绝冻结，用修复票改好。
9. **合入目标分支**：满足这条路线的验收后，才在临时组合现场合并到配置的目标分支并跑项目检查；`full` 路线还要求同一版本通过整体终审。

路线分两种：`quick` 是默认路线，由 Main 自己改、自己检查；改动碰到项目 `AGENTS.md`“独立审查”表里的路径时，程序拒绝只靠自查（`review_plan` 的 `self`），要求独立审查。`full` 按票冻结、审查后再并入；目标分支有新提交时，`sync_target` 把它们干净地合进需求现场，不用另开票。票改到范围以外的文件不拦截，交给 Reviewer 判断。

用户叫停时，Main 按用户的意思暂停（`pause`）或撤回（`withdraw`），都要写原因。暂停的开发仍占着这条需求，保留现场，用 `resume` 继续。撤回会取消需求的看板卡片；如果这个功能从没有开发合入过，台账里的需求随之停用。台账查找仍能找到停用的功能，并带上撤回原因。用户要把它拿回来时，Main 新建开发并用 `continues` 指明接续哪次撤回，停用的需求随之恢复。两种情况都不删除原来的现场和分支。需求面板把暂停的放在「进行中」并整体置灰，撤回的放进「已撤回」。

## 数据布局

```text
~/.formicand/                      可用 FORMICAND_HOME 改位置
├── config.json                    配置（0600）
├── credentials.json               模型和搜索密钥（0600）
├── workspace/<taskId>/            每个任务的数据，见下
├── runtime/
│   ├── projects.json              项目名称、ID 和文件夹
│   ├── workspaces.json            全局任务索引
│   ├── project-data.sqlite        项目数据库（默认引擎）
│   ├── development-workspaces/    需求开发现场
│   └── main-capacity/state.json   外部 Main 名额
├── pi/                            Pi 的状态目录
├── memory/                        Main 的记忆：user/ 和 projects/<projectId>/
├── client-sessions.json           App 连接后端的加密凭据
├── composer-drafts.json           输入框草稿
├── ui-preferences.json            界面上记住的选择
├── computer-policy.json           窗口访问的开关
└── logs/
```

每个任务的目录：

```text
<taskId>/
├── task.json、task_events.jsonl   任务状态和事件
├── inputs/<uploadId>/             用户上传的原始附件
├── artifacts/                     最终交付的文件
├── visual/images/、downloads/     截图和读过的图片、浏览器下载
├── agents/main/work/              Main 的草稿和中间材料
├── agents/subagents/<id>/         子代理的工作目录和待验收文件
├── sessions/main/pi/              Main 的 Pi 会话
├── sessions/<agentId>/pi/<callId> 每个子代理的 Pi 会话
└── runs/<runId>/                  Run 的事件、派单队列、收件箱和结果
```

- 中间材料放 `work/`，子代理的候选文件放 `deliverables/`，Main 验收后用 `publish_artifact` 发布到 `artifacts/`。界面的产出物面板只显示 `artifacts/`。
- `sessions/main/request-retry.json` 保存最近一次 Main 模型请求的原文，用于请求失败后原样重发。它含未脱敏的用户内容，权限 0600。
- App 和 CLI 共用这个目录；开发版和正式版也共用，所以不能同时打开两个默认的桌面实例。测试时用 `FORMICAND_HOME` 或 `FORMICAND_DESKTOP_DATA` 换一个目录。

## 项目数据

项目、需求台账、看板、Main 会话、开发记录、审查和合入记录由 [项目数据服务](../src/workspace/project-data-service.ts) 统一持有。后端启动时按配置打开 SQLite 或 PostgreSQL 并执行版本化迁移，SQL 差异封装在 [存储适配器](../src/storage/project-data/) 里，业务代码不按数据库分叉。其他后端可以经 [远程客户端](../src/workspace/project-data-remote.ts) 共用同一份数据，只登记自己的本机目录。任务、Pi 会话和现场目录始终留在执行它们的后端上。配置方式见 [配置](../README.zh-CN.md#项目数据)。

## 后端接口

所有接口都在 `127.0.0.1` 上，检查 Host 和 Origin，需要客户端会话凭据。路由定义在 [routes.ts](../src/dashboard/routes.ts) 和各个 `*-routes.ts` 里：

| 前缀                                             | 内容                                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/tasks`                                     | 任务、消息、Run、派单、产出物、窗口操作                                                                                                                       |
| `/api/events`                                    | SSE 事件流，断线后按序号补齐                                                                                                                                  |
| `/api/projects`、`/api/tasks`                    | 项目、台账、看板、Main 会话、开发与合入记录；台账动作（`lookup`、`context`、`tidy` 等）是发到 `/api/projects/:id/ledger`（或 `/api/tasks/:id/ledger`）的 POST |
| `/api/project-data`                              | 项目数据服务的描述、项目列表和目录绑定                                                                                                                        |
| `/api/composer`、`/api/uploads`                  | 草稿和附件上传                                                                                                                                                |
| `/api/model-settings`、`/api/models`             | 模型供应商和模型                                                                                                                                              |
| `/api/agents`、`/api/skills`、`/api/mcp`         | 自定义 Agent、技能、MCP 服务                                                                                                                                  |
| `/api/memory`                                    | 记忆；Main 经 `/api/tasks/:id/memory` 读写，经 `/api/tasks/:id/history` 搜、读本项目的其他会话                                                                |
| `/api/computer`                                  | 窗口访问状态                                                                                                                                                  |
| `/api/web-search-settings`、`/api/main-capacity` | 联网搜索、外部 Main 名额                                                                                                                                      |
| `/api/backend`、`/api/host`                      | 后端实例身份、桌面宿主专用接口                                                                                                                                |

项目数据的备份与恢复用 CLI 的 `formicand data backup`、`formicand data restore`，不经 HTTP。

改接口时，同时改生产者、消费者和行为测试。

## 终端界面适配

CLI 的交互界面直接使用原版 Pi 1.5.2，不改依赖文件。启动时只在交互子进程里对一个经过审核的代码块做六处界面文字替换（重启提示、tmux 提示、反馈和崩溃提示等改成 Formicand 的说法），另有三处让命令行工具的身份变成 `AI_AGENT=formicand`、长输出文件名变成 `formicand-bash-*.log`。

替换内容固定在 [cli-ui-policy.json](../scripts/cli-ui-policy.json) 和 [cli-shell-policy.json](../scripts/cli-shell-policy.json)。构建和启动时都会核对 Pi 版本、文件 hash 和替换位置，对不上就报错，不会带着没适配的界面运行。升级 Pi 时要重新生成和核对这两份策略。

## 信任边界

- 后端只监听本机。桌面用随机端口，主窗口经可信 preload 通信，渲染进程没有 Node 权限。
- 密钥不进页面状态、源码、日志和安装包。
- 窗口访问需要用户在 App 里开启并在本机确认身份，Agent 不能自己开启或恢复，见 [内置能力](../README.zh-CN.md#操作本机窗口)。
- 这个授权只管窗口操作，不是整个产品的系统沙箱：Agent 执行的命令不受操作系统隔离。
- App 只支持 Apple Silicon Mac。Windows/Linux 桌面、远程 Worker 和多用户隔离都还没有做。

## 日常修改流程

1. 从 [代码地图](#代码地图) 找到负责这个行为的模块、它的消费者和测试，读目标目录的 `AGENTS.md`，再到 [坑点](pitfalls/README.md) 里找和本次工具、路径或接口相关的条目。
2. 先复现，再跑已有的相关测试。修在负责的模块里，入口文件只做装配。
3. 加一个能覆盖原来失败的测试。异步行为要覆盖归属、取消、迟到的返回、冲突和退出恢复。
4. 按改动范围验证：先跑相关测试，再跑 `npm run verify`。纯文档改动只跑 `npm run check:docs` 和 `npm run format:check`。影响面大的改动跑 `npm run verify:full`。
5. 同一个改动里同步更新相关文档。提交说明写清楚问题和结果、涉及的模块、跑过的检查和没验证到的范围。

派单、返修、独立审查和交接的约定见 [开发交接](development-handoffs.md)。

## 检查命令

| 命令                                         | 检查什么                                                                         | 什么时候跑                |
| -------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------- |
| `npm run test:unit -- --file test/x.test.js` | 指定的 Node 测试，默认先构建                                                     | 每次相关修改              |
| `npm run verify`                             | CLI 和页面资源构建、源码卫生、lint、扩展类型、增量格式、文档链接、发布执行器自测 | 完成一项修改后            |
| `npm run verify:full`                        | 完整构建、静态检查和全部 Node 测试                                               | 发布前、影响面大的改动    |
| `npm run check:ci`                           | GitHub 上跑的轻量检查                                                            | CI 自动跑                 |
| `npm run check:source`                       | 有没有提交私有配置、密钥、个人路径和不该提交的产物                               | 提交前                    |
| `npm run check:docs`                         | 文档里的本地链接和标题锚点                                                       | 改了文档或代码路径        |
| `npm run test:browser`                       | Chromium 和 Electron 用户流程                                                    | 改了页面、HTTP 和页面联动 |
| `npm run test:desktop`                       | 打包后的 App：设置、会话、退出重启、模拟升级。先 `npm run desktop:pack`          | 改了桌面宿主或打包        |
| `npm run test:release`                       | 发版验收的全部环节                                                               | 准备发版                  |

单独跑 lint 前先 `npm run build:cli`，让 `.pi/` 引用的类型和源码一致；`verify` 已经按这个顺序跑。

## Lint 规则

[ESLint 配置](../eslint.config.mjs) 在常规规则之外，还检查吞掉错误的写法（不绑定错误也不抛出的 catch、空 catch、对应的 `.catch()` 回调）、多余的条件判断和多余的类型断言。

[存量基线](../eslint-suppressions.json) 已经清空，保持为空对象。确实需要例外的地方，逐处写 `// eslint-disable-next-line <规则> -- <依据>`，并接受审查。不要用扩充基线或换个写法吞错来绕过。改了相关代码后运行 `npm run lint -- --prune-suppressions`。

`format:check` 只检查改动过的文件；要检查整个仓库，在干净工作树上运行 `npm run format:check:all`。

## 分支和合并

- 只有 `main` 一条长期分支。功能和修复在临时分支上做，合进 `main` 后删掉分支。
- 合并用 `git merge --no-ff`，合完重新构建一次。
- 版本以 tag 和 GitHub Release 为准。

[常规工作流](../.github/workflows/test.yml) 在 PR 和推送到 `main` 时运行 `npm run check:ci`。CI 只做构建和静态检查，完整测试、浏览器、原生能力和真实模型都在本地做，不能把 CI 通过当成测试通过。

## 打包和发布

当前只出 Apple Silicon 的 Mac 安装包，用 ad-hoc 签名，没有 Developer ID 签名、公证和应用内更新。

| 命令                   | 产物                                                                  |
| ---------------------- | --------------------------------------------------------------------- |
| `npm run desktop:pack` | `.tmp/release/mac-arm64/Formicand.app`，用来跑 `npm run test:desktop` |
| `npm run desktop:dist` | `release/Formicand-<版本>-mac-arm64.dmg` 和它的 SHA-256               |
| `npm run cli:pack`     | `release/` 下的 CLI 安装包；用 `FORMICAND_PACKAGE_DIR` 换输出目录     |

发版步骤：

1. 本地完成全部验收，见 [测试](testing.md#发版验收)。
2. 改版本号并提交：`npm version 0.1.4 --no-git-tag-version`，连同本次要发布的源码和文档一起提交。
3. 打 tag 并推送：`git tag v0.1.4`，推送提交和 tag。
4. 在干净的 tag 检出上运行 `npm run release:local -- v0.1.4`。它会校验 tag 和版本，构建 DMG 和 CLI 包，生成校验文件，并上传到 GitHub Release 草稿。
5. 核对草稿里的文件、版本和说明，手动点 Publish。测试版标成 Pre-release，并在说明里写明未签名、未公证。

本地构建机不可用时，可以手动运行 [Release Mac 工作流](../.github/workflows/release-mac.yml) 在云端构建；只要内部测试包时用 [Internal Mac package](../.github/workflows/internal-mac.yml)。已经发布的版本不能替换文件，修复要发新版本，不要移动 tag。

打包关闭了 asar，因为 Pi 扩展和子进程要用真实文件路径。打包用白名单挑文件，但发布前仍要检查最终包里有没有不该带的东西，不能只靠 `.gitignore`。

自有代码使用 [MIT](../LICENSE)，第三方组件保留各自的许可证，见 [第三方声明](../THIRD_PARTY_NOTICES.md)。

## 页面约定

- **少说重复的话。** 用布局区分层级，不堆次级标题和说明文字。界面只展示实际可用的能力和真实状态。
- **颜色和动效用令牌。** 颜色以 [formicand.css](../web/assets/formicand.css) 开头的令牌为准，强调只用黑白，彩色只表达成功、警告、危险这类语义。浮层统一用 `--popover-*` 实色。动效时长用 [ui.css](../web/assets/ui.css) 的 `--motion-*` 令牌，不写裸时长。
- **字号。** 正文 15px、控件 14px、辅助文字 12px、栏目标题 16px、面板和弹窗标题 18px。字体是本地的 Inter，中文回退到系统字体。
- **用现成组件。** 菜单用 [menu.js](../web/assets/ui/menu.js)，弹窗用 [modal.js](../web/assets/ui/modal.js)，下拉框用 [select-menu.js](../web/assets/ui/select-menu.js)，短表单用 [dialogs.css](../web/assets/dialogs.css) 的 `.app-dialog`。图标按钮要有 `aria-label`。
- **状态归控制器。** 界面状态和 DOM 分开，草稿和异步请求的归属由各自的控制器保存。异步回来的结果要核对原来的任务和导航，不要覆盖用户已经切到的新会话。不要往 `web/app.js` 里加功能专用的状态机。
- **流式更新**要保留 DOM 身份、展开状态、焦点和阅读位置。
- **验收截图**要看浅色和深色、1440/1280 和 474/320 宽度，检查对比度、菜单位置、标题截断、键盘焦点和横向溢出。

## 文档约定

- 每个事实只在一份文档里写，其他地方链接过去。现行行为写进使用和接口文档；还没做的范围和下一步记在需求台账的开发记录里，不写进仓库。
- 改了命令、配置、路径或接口，在同一个改动里更新文档。命令必须和 `package.json`、脚本、CLI 帮助对得上。
- 产品说明是根 [README](../README.zh-CN.md) 和 [README](../README.md) 一对，改一份要同步另一份。英文读者从 [AGENTS.en.md](../AGENTS.en.md) 和 [CONTRIBUTING.en.md](../CONTRIBUTING.en.md) 进入开发标准；开发与测试标准只写中文。浏览器、本机窗口、CUA 脚本和中断恢复的英文正文写在 [docs/en/README.md](en/README.md#built-in-capabilities)：它随 CLI 和桌面包装分发，安装里的 cua 技能只读得到 `.pi/skills` 和 `docs`，所以这几节要写全，不能只留指向根 README 的链接。过程记录（复盘、坑点、交接、架构决定与历史）只写中文。
- 新增、移动或删除文档时，同步根 [AGENTS](../AGENTS.md#文档) 的文档登记表；仍在生效且难逆的选择写成 [架构决定](adr/)，被取代的决定和删掉的文档记进 [架构决定历史](adr-history.md)，未结项记在开发记录里。
- 不提交真实密钥、私有服务、个人配置和用户任务。示例用占位符和通用路径。
- 用相对 Markdown 链接。删除或移动文档时，更新所有引用它的地方，再跑 `npm run check:docs`。

文档站：`cd docs/site && npm ci && npm run preview` 在本机预览，`npm run build` 生成静态站点到 `.tmp/docs-site/`。导航在 [navigation.mjs](site/navigation.mjs)，新增的需要出现在侧栏的文档要登记进去。

## 定位故障

| 现象                           | 先查                                                          |
| ------------------------------ | ------------------------------------------------------------- |
| 保存失败、409                  | 版本号、外部修改和并发提交；保留草稿后重读，不要自动覆盖      |
| Agent 看不到附件或工具         | 上传记录、工具组是否打开、首轮和后续的上下文装配              |
| 任务卡住、停不干净、恢复后重复 | 任务和 Run 的事件、收件箱消费、提问、派单、后台任务和进程结束 |
| 重启后草稿或附件不见了         | 数据目录、全局索引和草稿文件；先记下实际路径                  |
| 模型启动失败                   | 地址、接口格式、模型、参数和环境变量覆盖；不要打印完整配置    |
| 异步结果覆盖了新会话           | 记下的任务和草稿身份、导航 token、迟到的请求                  |

各种日志和记录的位置见 [数据布局](#数据布局)。
