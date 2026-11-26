# 架构与代码地图

简体中文 | [English](en/architecture.md)

Formicand 是单用户、跑在本机的多 Agent 工作台。一个后端管理全部任务和 Agent 进程；Mac App、浏览器页面和 CLI 都是它的客户端，用同一套运行时。

## 整体结构

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

依赖方向：可复用的服务不导入 CLI 入口；`src/runtime/` 不导入后端 HTTP 层；`src/gui/` 不导入 HTTP 或 CLI。ESLint 和 [架构回归](../test/architecture-boundaries.test.js) 检查这些方向。

## 各层职责

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

**会话与上下文。** Pi 自己保存追加式会话记录。上下文快满时由 Formicand 换窗：模型写总结，程序带上必要的记录，接着在同一会话里继续。会话笔记和历史查询按会话隔离。

## 开发流程

Main 可以把一个需求按 Workloop 式的流程交给子代理完成，状态和规则由程序保存和执行：

1. **需求台账**（`project_ledger`）：每个项目的长期需求、现状和历史。
2. **需求开发记录**（`project_development`）：为需求建一个独立的 `git worktree` 现场，放在 `~/.formicand/runtime/development-workspaces/` 下，不碰用户自己的工作目录。
3. **票**：范围、带检查方式的验收标准、保留不变的部分、本次不做的事和依赖。用户确认后冻结。
4. **派单**：Executor 在需求现场分出的自己的 worktree 里工作，交回时用 `submit_report` 逐条报告验收标准。
5. **审查**：Reviewer 审一个冻结的候选提交，用 `submit_review` 交回 `pass` 或 `changes_requested`。拦截的发现必须引用验收标准，或属于回归、数据丢失、安全、项目规则四类底线之一。
6. **返修**：票回到返修状态后，派发前先检查剩余轮数。还有轮数时，用 `continueCallId` 在原 Executor 的会话和工作区继续。用尽轮数时，Main 在最近一次失败的审查上记录下一步做法；若选择更换 Executor，票留在返修状态，供新的 Executor 接手。
7. **并入需求现场**：每张票审查通过后由程序并进需求现场（`integrate_ticket`），先跑项目检查，再跑本票的验收命令；`full` 的整体终审只在全部票并入之后冻结。
8. **终审**：`full` 路线冻结整体终审时必须先写对照表（`mapping`，每行一条要求和证明它的测试、命令或文件），程序编行号，拦截发现可以直接引用行号。冻结前程序还检查项目 `AGENTS.md` 的文档登记表：还没有表就要求建表并登记现有文档，新加或改名的 Markdown 没登记、登记行指向已删文档、同类同领域出现两份时拒绝冻结，用修复票改好。
9. **合入目标分支**：满足这条路线的验收后，才在临时组合现场合并到配置的目标分支并跑项目检查；`full` 路线还要求同一版本通过整体终审。

路线分两种：`quick` 是默认路线，由 Main 自己改、自己检查；改动碰到项目 `AGENTS.md`“独立审查”表里的路径，或非文档文件超过 20 个时，程序拒绝只靠自查（`review_plan` 的 `self`），要求独立审查。`full` 按票冻结、审查后再并入；目标分支有新提交时，`sync_target` 把它们干净地合进需求现场，不用另开票。票改到范围以外的文件不拦截，交给 Reviewer 判断。

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

项目、需求台账、看板、Main 会话、开发记录、审查和合入记录由 [项目数据服务](../src/workspace/project-data-service.ts) 统一持有。后端启动时按配置打开 SQLite 或 PostgreSQL 并执行版本化迁移，SQL 差异封装在 [存储适配器](../src/storage/project-data/) 里，业务代码不按数据库分叉。其他后端可以经 [远程客户端](../src/workspace/project-data-remote.ts) 共用同一份数据，只登记自己的本机目录。任务、Pi 会话和现场目录始终留在执行它们的后端上。配置方式见 [配置](configuration.md#项目数据)。

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

## Pi 依赖边界

Pi 包（`@earendil-works/pi-*`）的运行时导入只允许出现在持有 Pi 进程的地方，其余模块只能用 `import type`。允许的范围是 [ESLint 规则](../eslint.config.mjs) `formicand/pi-import-boundary` 里的明确清单，[依赖边界回归](../test/architecture-boundaries.test.js) 检查清单和本节一致：

- 目录：`.pi/`（扩展和工具）、`scripts/`（启动器）。
- 模型配置：`src/runtime/main-request-retry.ts`、`src/runtime/model-cache.ts`、`src/runtime/model-connection.ts`、`src/runtime/model-levels.ts`、`src/runtime/model-profile.ts`、`src/runtime/model-provider.ts`、`src/runtime/model-request-recording.ts`。
- Main 会话文件读写（Main 不在运行时由后端改写会话，用于编辑重发、分叉和离线换窗）：`src/runtime/conversation-fork.ts`、`src/runtime/main-message-edit.ts`。

Pi 包内部深路径（例如 `@earendil-works/pi-ai/api/...`）只允许模型配置模块导入。这样升级 Pi 时，只需排查清单里的模块。

## 终端界面适配

CLI 的交互界面直接使用原版 Pi 1.5.2，不改依赖文件。启动时只在交互子进程里对一个经过审核的代码块做六处界面文字替换（重启提示、tmux 提示、反馈和崩溃提示等改成 Formicand 的说法），另有三处让命令行工具的身份变成 `AI_AGENT=formicand`、长输出文件名变成 `formicand-bash-*.log`。

替换内容固定在 [cli-ui-policy.json](../scripts/cli-ui-policy.json) 和 [cli-shell-policy.json](../scripts/cli-shell-policy.json)。构建和启动时都会核对 Pi 版本、文件 hash 和替换位置，对不上就报错，不会带着没适配的界面运行。升级 Pi 时要重新生成和核对这两份策略。

## 信任边界

- 后端只监听本机。桌面用随机端口，主窗口经可信 preload 通信，渲染进程没有 Node 权限。
- 密钥不进页面状态、源码、日志和安装包。
- 窗口访问需要用户在 App 里开启并在本机确认身份，Agent 不能自己开启或恢复，见 [内置能力](capabilities.md#操作本机窗口)。
- 这个授权只管窗口操作，不是整个产品的系统沙箱：Agent 执行的命令不受操作系统隔离。
- App 只支持 Apple Silicon Mac。Windows/Linux 桌面、远程 Worker 和多用户隔离都还没有做。

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
| 桌面窗口、IPC、退出        | [main](../desktop/main.cjs)、[preload](../desktop/preload.cjs)                                                                                                                         |
| CLI 命令                   | [formicand.mjs](../scripts/formicand.mjs)、[src/cli/](../src/cli/)                                                                                                                     |
| 浏览器和窗口操作           | [browser-use](../src/gui/browser-use.ts)、[computer-use](../src/gui/computer-use.ts)                                                                                                   |

改的时候：

- **修一个用户流程**：先找到出问题的那一层和它的消费者，补一个能复现的测试，再改实现，不要在入口文件里加分支绕过去。
- **加一个工具**：按领域放进对应模块，参数用 typebox 定义；改了工具就同步更新 [内置能力](capabilities.md) 和相关测试。
- **拆一个大模块**：先按职责拆出新文件，保持对外接口不变，测试全过后再调整调用方。
