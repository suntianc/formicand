# 运行时参考

简体中文 | [English](en/runtime-reference.md)

本页维护工具、委派、恢复与停泊唤醒的运行契约。模型和预算见[配置参考](configuration-reference.md)，持久文件见[数据布局](task-workspace-layout.md)，HTTP 字段见 [Product API](product-api.md)。

## 会话与消息

项目文件夹用于文件和命令操作，会话历史和恢复数据另存于用户数据目录。项目目录变更不搬移历史或外部文件，原有绝对路径和文档绑定仍指向原位置。路径与归属见[数据布局](task-workspace-layout.md#项目与会话归属)。

App/Web 的文字、附件和编辑草稿按项目或会话分别持久保存。运行中提交的普通消息排队；补充指令在下一次模型调用时投递，当前调用或工具先执行完。中断只结束当前回合，保留会话、草稿、已经产生的文件修改与在跑的子代理；关闭会话才停止进程并取消该会话的委派。

Main 常驻：一个 Run 由同一个 Pi 进程服务，一轮结束后进程不退出，后续用户消息与回调经该进程的持久 Inbox 送达并开始下一轮。退出只在关闭会话、空闲超时（默认 5 分钟，`mainIdleTimeoutMs`）和无法继续的模型请求；空闲计时从回合结算后开始，执行中的回合和未完成的委派会保留进程。回合结束的边界在 Run 事件日志写入终态记录（`main.run_completed`，仍有未结束工作项时为 `main.run_waiting`），所以回合在进程存活时也能结算，读取会话的一方不必等进程退出。空闲退出保留会话文件与任务状态。只有用户主动停止本轮时，会话活动记录才显示对应的「已停止」提示。之后的消息或回调由后端重新拉起同一会话。后端重启不结束 Main，重新接管仍在运行的进程。

常驻 Main 在每轮开始时重新读取本机保存的模型配置：连接、协议、模型、输出上限、上下文窗口与图片能力，以及该条消息显式选择的思考档位，都在回合边界生效，无需重启进程。连接与协议也按回合切换：同一 Pi 会话继续，历史与工具结果保留；模型看不到图片时，历史图片按 Pi 的占位规则替换。启动时由环境固定、单次指定（`profileId`/`model`）或失败请求重放决定的连接保持不变：它们属于该进程或该请求本身，而不是本机保存的默认配置。显式档位跟着打开回合的那条消息走：后面排队的消息覆盖 Run 的输入记录时，先前那条仍用自己的档位；并入进行中回合的 steer 消息不改该回合的档位，档位只在消息自己开启回合时生效。

常驻 Main 的外部名额按回合与委派占用：Main 有进行中的回合，或有未结束的子代理工作项（含尚未送达的回调）时，都占一个名额。回合结束且没有待办子代理时在边界释放名额、进程保留；下一条消息先重新准入再投递，不为腾名额杀空闲 Main。暂停的 Main 只要还有未结束的子代理工作项就继续占名额，恢复请求直接送达同一进程；待办工作清空后才释放名额，之后的恢复按新需求重新准入，名额满时进入队列，释放后由后端启动。

暂停不是停止：请求写在 Task 记录里，Main 在当前工具调用或模型回复结束后、下一次工具调用或模型请求之前读取它并停下，进程与会话保留，已完成现场、候选与需求记录保留。暂停期间到达的回调与其他工作留在 Inbox，恢复后送达；该边界已经完成 Task 时保持 `completed`。继续从同一 Run、进程与 Pi 会话恢复，保留已完成的工具结果，不重复已完成步骤；暂停中且没有子代理在跑时按空闲计时。取消（关闭会话）从暂停状态按现有终止语义清理未完成委派与后台工作。

编辑最近一条消息会使用原会话前缀和新输入重新执行；此前文件修改和外部操作不会撤回。失败请求的精确重放见[请求重试与上下文恢复](#请求重试与上下文恢复)。

## Pi 版本与回滚

Main、子智能体和会话文件都由 Pi 运行。`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai` 与 `@earendil-works/pi-agent-core` 保持同一版本，当前为 1.5.2；会话文件由 Pi 原样写入 `sessions/`（位置见[数据布局](task-workspace-layout.md)），Formicand 不做自有格式转换。

### 两个方向读取会话的结果

0.87.1 与 1.5.2 写的都是 v3 会话文件。`test/p46-session-compat-pi.test.js` 用真实 Pi 进程加载真实 Main 扩展、对接本地假模型，实测两个方向：

| 方向                              | 实测结果                                                                                                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.87.1 写下，1.5.2 读回并继续一轮 | 可以继续。模型收到的历史完整：`system → user → assistant(toolCall) → toolResult → assistant → user`；工具调用 id 与结果配对、结果正文不变，旧用户消息原文保留，续跑写回同一个会话文件。                                           |
| 1.5.2 写下，0.87.1 读回并继续一轮 | 可以继续，历史同样完整。1.5.2 在助手消息里额外写入的 `thinkingLevel` 不在 0.87.1 的消息定义里，读取时被忽略；`toolsRemoved` 等系统消息字段两个版本都声明并处理。0.87.1 的会话投影对不认识的条目类型返回空条目，不会打断前后历史。 |

两次运行都确认 Main 的系统提示注入（`<current_workspace>`）存在。测试只覆盖 Main 普通对话（系统提示、用户/助手消息、工具调用与结果）；压缩摘要、分支、自定义消息等更少见的条目未逐一实测。0.87.1 由测试从本机 npm 缓存离线安装到临时目录，不改项目依赖；缓存缺失时该测试以明确原因跳过，跳过不构成兼容结论。

### 回滚到 0.87.1

只降级三个包不足以启动：升级后的启动器会传 1.x 才有的 `--no-mcp`，0.87.1 以 `Error: Unknown option: --no-mcp` 退出；`scripts/cli-ui-policy.json` 与 `scripts/cli-shell-policy.json` 锁定的是 1.5.2 bundle 的 hash；源码还把 `Type` 改为从直接依赖 `typebox` 导入。回滚因此撤销整个升级提交 `4e5bde0`（“升级 Pi 运行时到 1.5.2（行为不变）”），一次恢复 0.87.1 的依赖、启动参数与 UI 策略：

```sh
# 先停止 App/CLI、Main、Worker 与守护，避免运行中的进程继续写入会话。
cd <仓库根目录>
git status --short                     # 工作树需要干净
git switch -c rollback/pi-0.87.1       # 保留当前分支
git revert --no-edit 4e5bde0
npm ci
npm run build:cli
npm run build:web-assets
npm run verify
```

已打包安装的 CLI/App 用 0.87.1 的安装包重装；安装和卸载不改动用户数据目录里的 `sessions/`，回滚后原会话直接可用。

回滚后的会话处理：

- 升级期间由 1.5.x 写下的 Main 会话按上表继续，不需要转换或改写会话文件；不要手工编辑会话 JSONL 来“修复”它。
- 若某个会话在 0.87.1 下无法打开或继续（例如用到 0.87.1 没有的条目），保留原文件并先备份，用 `formicand session export <session-id-or-path> --format json --output audit.json` 留证，然后新建会话，在首条消息里复述仍在进行的目标与已完成结果。恢复入口见[请求重试与上下文恢复](#请求重试与上下文恢复)。
- 再次升级时，0.87.1 写下的会话仍可在 1.5.x 继续（上表第一行），但升级提交会重新引入上述启动参数与 UI 策略，不能只改 `package.json` 的版本。

## 输入格式

### 数学公式

Web/App 支持行内 `\(...\)`、`$...$` 与独立公式 `\[...\]`、`$$...$$`。代码和无法排版的公式保留源码；终端不提供公式排版。

## 通用能力与按需工具

终端和 App 的 Main 共用 Formicand 扩展与能力规则；委派子代理由同一个扩展按角色收窄工具。Coordinator 可接收外部 `capabilityProvider`。

`enable_tools({})` 查询可用工具组，`enable_tools({groups:["attachments"]})` 加载附件读取工具，`delivery` 组提供产出物发布。显式加载随 Main Run 恢复；附件和已授权任务也可按上下文启用工具。加载不代表授权，jobs 仍需 `longRunning`，电脑操作仍逐次核对有效授权。

Browser/CUA 对象属于当前 Pi 会话，退出或切换时清理。恢复工具组不会恢复浏览器页面或脚本对象，普通子智能体也不自动继承它们。操作与权限见 [Browser Use](browser-use.md)、[Computer Use](computer-use.md) 和 [CUA 脚本](cua-scripting.md)。

Main 与委派子代理都用 Pi 原生的 `bash` / 文件工具，`cwd` 默认是所选项目目录（子代理是它自己的工作现场）；没有第二套 `run_command` / `run_tests` 工具，也没有程序化工具工厂。跨工具调用继续运行的命令使用 `start_job`，通过 `check_job` 查看。停止 Main 当前轮次不会自动取消已委派子智能体，需显式 `cancel_subagent`。

### MCP 服务

MCP 服务只有一份全局配置 `~/.formicand/mcp.json`（`mcpServers` 格式，与其他客户端相同），所有项目共用，智能体不能读取它。Main 保留 Pi 内置的 MCP 客户端，但服务只经扩展注册（[MCP 注册](../.pi/runtime/mcp.ts)）：进程启动时注册已启用的服务，之后每轮开始重读配置，新增或修改的重新注册，删除或停用的注销，读取失败时沿用已有服务并提示一次。Pi 自己目录下的 `mcp.json` 保持为空；Main 与委派进程都以 `--no-approve` 启动，项目里的 `.pi/mcp.json`、设置与扩展不会被加载。可见方式只有三种：`deferred`（默认，经 `tool_search` 找到后才声明给模型）、`direct`（直接声明）与 `hidden`（不可达），单个工具可另设；Formicand 不启用 codemode，配置里的 `codemode` 会被拒绝。Main 只注册它在设置页「Agent」里选的服务（默认全部已启用的）；内置 Executor 与 Reviewer 默认以 `--no-mcp` 启动，设置里选了服务时只注册所选的。

设置页「MCP」检查连接、列出工具与 OAuth 登录都调用 Pi 自己的 `pi mcp list --json` 与 `pi mcp login`：后端在 `~/.formicand/runtime/mcp-probe/` 下为每次操作建一个只含相关服务的临时目录（用完即删），该目录在 Pi 目录的 `trust.json` 中登记为信任；登录凭据写入 Pi 目录的 `mcp-auth.json`，按服务名与地址对应，Main 连接同名同址的服务时直接使用。

### 自定义 Agent

自定义 Agent 是 Markdown 文件（[定义与校验](../src/runtime/agent-definitions.ts)）：头部写 `name`、给 Main 的 `description`、`permission`（`write` 或 `read`），可选 `profile`/`model`、`thinking`（推理强度）、`tools`、`skills`、`mcp`、`enabled`，正文是附加提示词。没写模型时可写的跟 Executor、只读的跟 Reviewer。全局放在 `~/.formicand/agents/`，项目放在 `.formicand/agents/`（项目信任后才读），同名时项目的生效；`main`、`executor`、`reviewer` 是内置名称。

代码保证的规则：`read` 不能有 `edit`、`write`；可选工具只有 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`、`browse_workspace`、`search`、`visit`，Main 专用工具与桌面、浏览器操控都不在其中；`ask_main`、`send_peer_message` 始终持有；不写 `skills` 时可见全部技能，写空列表则没有技能；不写 `mcp` 时不注册任何服务。

用户项目有坑点索引 `docs/pitfalls/README.md` 时，程序在工作开始时提示去读一次，不把索引放进系统提示：Main 在 `project_development create` 打开需求检出时，结果多一个 `pitfalls` 字段；Executor、Reviewer 在首条任务消息里，按各自检出判断（返修续接不再重复）。提示要求只打开触发情形与手头工作相关的条目，条目与代码不符时以代码为准。见 [代码](../src/runtime/project-pitfalls.ts)。

Main 每轮在系统提示的 `<custom_agents>` 里看到已启用、有效的 Agent，用 `call_subagent` 的 `agent` 参数派出。后端在派单时解析定义并写进工作项（之后修改不影响它），记一条 `call.agent_selected`（名称、来源、权限、模型来源）；找不到、已停用或定义有误时直接报错并写明名称，不改派。`write` 以 Executor 角色在隔离现场运行，`read` 在 Reviewer 那样的独立 checkout 里运行但不提交审查结论，结论以文字交回。子进程按定义设置工具、过滤技能清单、只注册所列 MCP 服务，并把附加提示词接在角色提示之后。侧栏和需求面板用 Agent 名称代替角色名。

Main 用 `manage_agent`（[工具](../.pi/runtime/tools/agents.ts)）列出、新建、修改、停用或启用 Agent。每次写入前，它以带 `proposal` 的提问把完整定义交给用户：会话里显示定义卡片，用户点「确认」才写文件；拒绝、写修改意见、选「在设置里修改」或超时都不写入，「在设置里修改」会打开设置页并带上这份草稿。Main 只能引用已配置的 MCP 服务，不能新增；项目未信任时不能写项目 Agent。设置页的「让 Main 帮我写」新开会话，把请求放进输入框。

设置页「Agent」分全局与项目两页（[接口](../src/dashboard/agent-routes.ts)），可新建、复制、修改、启停、删除，并标出引用了不存在或已停用的技能、MCP 服务的 Agent。两页都列出内置的 Main、Executor、Reviewer：名称、使用说明、权限和工具不可改，模型、推理强度、技能、MCP 和附加提示词存在执行主机配置的 `roleModels` 里，项目页可逐项覆盖（见[角色模型](configuration-reference.md#角色模型)）。Executor、Reviewer 派单时把这些设置写进工作项，子进程据此过滤技能、注册服务并把附加提示词接在角色提示之后；Main 每轮重读，附加提示词放在系统提示的 `<user_main_instructions>` 里。工作区里第一次打开带 `.formicand/agents`、`.formicand/skills` 或 `.agents/skills` 的项目时，会询问是否信任（[询问](../web/assets/controllers/project-trust-prompt.js)），只读取名称来提问。

### 输入框 `/` 与 `@`

输入框里打 `/` 列出技能、指令模板和命令，打 `@` 搜索项目文件、自定义 Agent 和 MCP 资源（[菜单](../web/assets/controllers/composer-menu.js)，列表来自 [输入框服务](../src/dashboard/composer-service.ts)）。技能清单与 Main 看到的一致；指令模板是 `~/.formicand/prompts/` 与项目 `.formicand/prompts/` 下的 Markdown，同名时项目的优先，选中后直接展开成可再编辑的文字；文件列表在 Git 仓库里按 `.gitignore` 过滤，否则遍历目录并跳过 `node_modules` 等；MCP 资源由后端连接已启用的服务读取，`ui://` 界面资源不列，需要登录或用 `!命令` 取值的服务不列资源。

选中的技能、文件、Agent 与资源在消息里留下 `/名称`、`@路径`、`@Agent 名`、`@服务:地址`，发送、运行中插话与修改重发时由前端识别成引用随请求发送。后端只保留能解析的引用（技能在清单里、文件在项目内且存在、服务已启用），在消息开头加上 `<formicand_references>` 清单（[格式](../src/runtime/composer-references.ts)），写明每类引用的用法，技能只给名称，由 Main 用 `load_skill` 加载；清单在会话里不显示，只把对应的词标成标签。

## 显式委派附件

普通 `call_subagent({task})` 保持有效。附件和桌面权限不会全部自动继承，需要显式共享范围：

```javascript
call_subagent({
  task: "核验此装配的部件与运动参数，返回证据",
  attachments: ["明确共享的upload ID"]
});
```

附件读取只接受已共享的 ID；未共享的附件不因 Main 可读而出现在子智能体中。委派成功或总结不能替代 Main 对结果的核对。

### 派单经后端

`call_subagent` 只向后端登记工作项：后端把登记写进该 Run 的持久队列（`queue.json`）并答复 `callId`，依赖满足后由后端启动独立的子代理 Pi 进程，进程结束时把结论写回队列、运行事件与 Main 的回调。派单只有异步一种：登记落盘后立即返回，结果经回调送达；本轮必须拿到结果时用 `wait_for_subagents` 等待，协作者提问或用户插话会让等待提前返回。`wait_for_subagents`、`get_subagent_status` 与 `get_task_status` 读同一份队列、回调与结果记录，不依赖后端内存。

每个工作区根只有一个属主启动与结算委派进程：Dashboard 运行时 CLI worker 不接管（`formicand worker` 报告属主后退出），跨重启接管、启动排队项和结算都由属主完成。属主启动时从持久记录接管仍在运行的子代理，并在停机期间结束的子代理上补发回调；结算由进程记录上的文件锁去重，所以同一工作项不会产生两份回调。中止启动的拒单在任何持久写入之前完成，不留下无人结算的工作项；已入队后启动失败按该工作项自己的失败结算。

前端（Dashboard）在派单时确定工作项的现场与候选：`developmentId` 取本后端就绪的需求现场；Reviewer 的 `reviewSite` 固定为需求当前冻结候选的提交（没有独立审查时按派单那一刻的提交冻结），因此冻结之后 Executor 现场再前进也不会移动 Reviewer 的审查对象。工作项现场、会话目录与结论都在持久记录里，返修续接同一个 Executor 的 Pi 会话文件（`sessions/<agentId>/pi/<原 callId>`）与现场，追加一轮。附件授权随工作项传递：被授权的上传 ID 在派单时校验，委派进程只在有授权时注册 `read_attachment`，未授权不注册。

后端重启不影响这些记录：Main 的本地凭据与后端实例一起保存在数据根，被接管的 Main 继续用同一凭据访问新的后端进程；子代理进程与 Main 一样不随后端退出。没有 Dashboard 的 CLI Run 由 CLI 宿主在自己的进程里装配同一个子代理后端，并通过回环地址只开放该 Task 的派单/取消入口；子代理同样是独立 Pi 进程，`call_subagent` 不存在进程内回退。

### 执行角色、工作项依赖与需求现场

委派默认以 `executor` 角色运行，审查使用 `role: "reviewer"`。两个角色在前置工作结束、即将创建会话时读取执行主机的角色配置：显式传入的 `profileId`/`model` 优先，其次是主机默认；都没有时沿用 Main 本次 Run 的连接，普通 `call_subagent({task,mode})` 行为不变。选择以非敏感快照写入 `call.model_selected`，只在真正启动时记录；排队期间修改绑定会作用于该工作项本次启动，删除引用则让它以包含角色和连接 ID 的错误结束，不会改投其他账号。启动后的请求保持原连接，后续配置变更只影响之后启动的工作项。密钥留在执行主机，不进入工作项记录、回调或界面响应。

`dependsOn: ["<callId>", …]` 声明前置工作项。前置未全部结束前，工作项保持排队（界面显示等待前置），不启动进程、不发模型请求；前置完成后继续执行，前置失败或取消则本项不执行并以原因结束。取消某个工作项只结束它自己（包括仍在等待前置的工作项，状态立即显示已取消而不是排队），其他工作项、Main 和回调不受影响；重启后从持久队列恢复依赖与角色请求，无法重新进入的工作项以失败结束并保留原因，不会反复重试或被静默丢弃。

传入 `developmentId` 时，工作项在需求现场的独立执行现场运行：从本后端 `project_development` 记录中的 ready 需求现场按当前提交分出该工作项自己的 `git worktree` 与分支（`<需求现场同级的 work-items>/<callId>`），作为该 Subagent 的项目目录。并行工作项互不覆盖，也不会写入需求集成现场或用户原工作树；现场未 ready 时拒绝委派，提示先执行 `ensure_workspace`。同时传入 `ticketId` 时，程序把已确认票的范围、验收标准、保留不变和本次不做写在任务前面，并把这次调用记到票上；direct 与 full 路线按票在 Executor 自己的现场冻结和审查（冻结时检查改动是否越出票的范围），审查通过后由 `integrate_ticket` 并进集成现场并跑项目检查与该票的验收命令。quick 路线由 Main 用现有文件/Git 工具明确收取结果到集成现场；需要审查汇总结果时，在汇总后委派 Reviewer，它从汇总现场的新提交分出自己的现场。重试、重启恢复和返修沿用同一目录与分支，保留已有提交和文件，不重建或 reset。`get_subagent_status`、Task 详情给出每个工作项的 callId、名称、角色、模型、实际工作目录、依赖、阻塞状态和失败原因；界面在这些字段上显示角色、模型与独立现场。

`continueCallId`（可配 `reviewId`）是原上下文返修契约：它必须指向本 Run 中已结束的 Executor 工作项，复用该工作项的 agent 身份、Pi 会话文件与现场，把返修任务作为同一会话的下一轮追加，而不是新建 Agent 或重复执行已终态工作；没有可续接的会话记录时拒绝派单。运行中的工作项、Reviewer、已有续接在运行或现场不可续接的调用会被拒绝；重启恢复沿用同一续接记录。`project_development` 的审查动作把候选提交、候选树、Reviewer 身份和现场、发现、裁定和返修关联写为共享记录；候选提交或受审内容变化后，旧结论不会被当作当前候选的有效审查。失败或漂移的审查仍可对其发现作裁定或记录返修，复审沿明确的 previousReview 链结算已验证的修复，链外发现不受影响；self 通道的自检绑定记录时的提交/树，现场前移后需在当版本重新验证。完整接口见 [Product API](product-api.md#fixed-candidate-reviews)。`request_merge` 把已满足交付资格的需求候选提交到项目共同入口，`application` 由配置的执行后端串行更新目标分支；等待期间目标前移时会在最新目标与候选的组合版本上重新运行检查。`apply_merge` 由该执行后端核对中断操作并继续队列，`merge_status` 读取操作、实际合入 SHA 与可幂等对账的回执；失败只处理操作自有现场，保留用户脏文件、先前合入和未合入分支。申请时还须带上 `ledger`：新的现状或现状不变的理由、一行历史，功能大变时带新的功能描述，否则写明描述不变；真实合入后程序自动写台账/看板交付，同时把这份现状、历史和描述写回需求，没合进去则台账不变。`full` 路线照 Workloop 在冻结整体终审时先检查需求现场根目录 AGENTS.md 里的文档登记表：没有表、或这个需求新加的文档没登记、表里有指向不存在的行、同类同领域出现两份都拒绝，已有表时只算这个需求带来的问题，用修复票改好；`quick` 与 `direct` 路线不查；台账维护完成时 `finish_tidy` 必须交上哪些文档跟不上代码或为什么都不用改；外部需求转待发布并保留归属人与实际合入 commit，内部需求只写台账。`delivery_status` 读取阶段、协作者进度、固定到交付版本的改动、检查与同步回执；共享服务暂不可达时执行主机保留本机待同步事实，恢复后按有界重试自动补齐，不要求重新开发或合入。

### 角色工具与审查结论

子代理进程与 Main 加载同一个扩展，按角色声明工具表。Executor 得到 `read`、`bash`、`edit`、`write`、只读的 `browse_workspace`、`ask_main`、`send_peer_message` 与 `search`/`visit`；Reviewer 得到 `read`、`bash`、`grep`、`find`、`ls`、`browse_workspace`、同样的两个通道工具、`search`/`visit` 与 `submit_review`，没有 `write`/`edit`。`search`/`visit` 与 Main 同一实现、同一配置：未关闭搜索时注册，`FORMICAND_WEB_TOOLS=0` 或 `provider: "off"` 时两个角色都不声明。两个角色都能用 `load_skill`：与 Main 同一实现、同一份技能清单，只加载指令，不取得新工具或权限。清单由 [技能清单](../src/runtime/skill-registry.ts) 计算，按优先级依次读取项目 `.formicand/skills/`、项目 `.agents/skills/`（自项目目录向上到仓库根）、`~/.formicand/skills/`、`~/.agents/skills/` 与随产品提供的 `.pi/skills/`，同名时前者覆盖后者；项目里的两处只在用户信任该项目后读取（记录在 `~/.formicand/project-trust.json`），从索引移除的技能（`~/.formicand/skill-index.json`）不进入清单，文件不动。Pi 自带的技能发现以 `--no-skills` 关闭，Main 与子代理的系统提示和 `load_skill` 用同一份清单；系统提示只列技能名称与说明，不给文件路径，技能一律用 `load_skill` 加载。子代理按原项目目录判断信任，不按自己的隔离副本。后端从被审候选的提交为 Reviewer 建一份 detach 的独立 checkout 作为它的项目目录；成功的审查保留这份现场，因为 Main 在进程结束后才绑定审查并核对候选是否漂移；没有产出结论的失败尝试立即清理，审查漂移时随漂移结论释放，需求合入后释放该需求的全部审查现场，记录本身保留 Reviewer 身份与现场路径。没有需求现场时按派单时刻的 HEAD 冻结候选并建同样的副本，项目不是 Git 仓库则在派单前拒绝。它运行的测试与写入的文件留在这份副本里，不进入候选提交、Executor 的现场或用户工作树。两个角色都没有 `call_subagent`、`send_subagent_message`、`cancel_subagent`、`get_subagent_status`、`wait_for_subagents`、`get_task_status`、`finish_task`、`askhuman`、`sleep_until`、`grant_capabilities`、`clear_context`、`enable_tools`、`project_ledger`、`project_development` 与 `publish_artifact`，因此子代理不能再派子代理或改变 Task 生命周期。角色说明沿用同一段文本；角色只决定工具，不扩大授权：电脑操控、浏览器与 CUA 等能力由 Main 的扩展注册，委派进程当前不提供。附件授权随工作项传递，只有被授权的上传 ID 才让委派进程注册 `read_attachment`。Main 与两个角色对受保护路径的 `write`、`edit` 与 `bash` 写入按同一规则拦截并返回同一段错误；`bash` 拦截跟随 `cd`、`pushd`/`popd`、`git -C` 与子 shell 的目录切换解析相对目标，目录无法确定时只要项目内存在受保护路径就保守拒绝。它尽力识别常见写法，不是沙箱：解释器内写入、引号内的命令替换、反引号、`xargs`、`find -delete`、`git clean`、目录级目标的 `git restore .` 与 `git checkout .`、`tar`/`unzip` 解包写入等仍可能绕过。Main 与两个角色的任何工具调用，只要参数里写到 Formicand 自己的数据目录（`FORMICAND_HOME`，默认 `~/.formicand`），就整条拒绝，读、列目录和写入都一样；只有任务工作区 `workspace/`、需求现场 `runtime/development-workspaces/`、临时工作区 `runtime/temporary-workspaces/` 与已安装技能 `skills/` 可以访问；已安装技能对 `write`、`edit` 和 `bash` 写入同样受保护。`backend-instance.json`、`project-data.sqlite` 等 Formicand 自有文件名出现在参数的任何位置也会拒绝，因此从允许目录用相对路径向上找到的文件同样被拦下。Formicand 自己的程序目录（源码或安装目录）同样拒绝读、列和运行，只放行随产品提供的 `.pi/skills/` 与技能引用的 `docs/`；用户的项目就是 Formicand 本身、在它里面或包含它时不拦。这条规则针对一次 Main 读取后端主机凭据、绕开缺失的合入配置的事件；它同样不是沙箱，运行时拼出来的路径看不到，对外工作的系统级隔离在 P5 交付。委派进程与 Main 一样对 `cache_warming_decision` 返回 `stop`，不进行提示缓存保温。委派会话与 Main 共用上下文管理和历史工具。
Reviewer 的结论只经 `submit_review({verdict, findings, previousFindings?})` 提交：`verdict` 为 `pass` 或 `changes_requested`，每条 finding 含 `title`、`location`、`evidence` 与 `blocking`，拦截的还要写 `basis`：本次审查的某条验收标准编号（票的 `AC1`…，整体审查的完成标准 `CC1`…），或四类底线之一 `regression`、`data_loss`、`security`、`project_rule`；不拦截的是建议。复审还要在 `previousFindings` 里逐条回答上一轮要修的发现修好没有，新提的发现只能拦截，依据为验收标准，或出在这一轮改到的文件里的底线问题。`changes_requested` 需要一条拦截的发现或一条没修好的上一轮发现，`pass` 两者都不能有；可引用的编号、上一轮的发现和这一轮改到的文件在冻结候选时由程序定下，随派单传给 Reviewer 进程（`FORMICAND_REVIEW_SCOPE`），后端导入时再按同一份规则核对；不合法的提交作为工具错误返回，模型可改正后重试。结论写入该工作项结果记录的 `review` 字段并随回调送达 Main；Reviewer 没有提交结论就结束记为失败，后端读取结果记录时按同一格式复核。验证 [真实角色工具表与结论](../test/subagent-roles-pi.test.js)。

带票派出的 Executor 另有 `submit_report({criteria})`：票的每条验收标准一项，写 `criterionId`、`met` 与 `evidence`，编号随派单传给进程（`FORMICAND_TICKET_CRITERIA`），缺项、重复或编号不对作为工具错误返回。报告写入结果记录的 `report` 字段，后端按同一规则复核后接在 Executor 的交回之后送达 Main；没交报告就结束记为失败。两个角色的 `bash` 里按名字结束进程（`pkill`、`killall`，或由 `pgrep`/`pidof` 喂给 `kill`）一律拒绝，因为会连带用户自己的应用和服务；按自己启动时记下的 PID 结束不受影响。验证 [票的报告与按名字结束进程](../test/subagent-roles-pi.test.js) 和 [规则单测](../test/executor-rules.test.js)。

### 子代理的持久收件箱与追加消息

Main 发给运行中子代理的追加消息、对 `ask_main` 问题的回答与同伴消息都先写入该子代理自己的持久 Inbox（`runs/<runId>/agents/subagents/<id>/inbox-store.json`），由子代理进程内的扩展在安全回合边界读取，作为下一轮输入。消息不经标准输入，也不要求写入时后端仍在运行：后端重启或子代理在停机期间继续工作都不影响送达。

空闲进程由写入方直接通知唤醒：进程把本地端点登记在持久进程记录里，写收件箱或写 `ask_main` 回答的一方在持久写入后向该端点发一次「有新消息」，被唤醒的进程重读完整收件箱或问题记录，不信任通知内容；端点不可达（进程已退出、socket 文件残留）时通知方静默跳过。`ask_main` 阻塞等待也订阅同一通知。文件监听留作补充，不轮询。每个回合结束时扩展先重读整个收件箱再让回合继续，所以监听事件迟到、被合并、通知没有送达或没能赶在进程结束前到达时，消息仍在该回合边界被读走，送达不依赖它们。消息先租约给该进程，只有出现在它的 Pi 会话上下文中才记为已消费，并写入 `inbox.consumed` 事件；因此每条消息只读一次。进程在读取前退出时消息仍是持久的，由同一 Agent 的下一个进程重新投递。Main 正在用 `askhuman` 等用户回答时，它答不了任何子代理，所以这段时间不计入 `ask_main` 的等待：同一 Run 有待回答的用户问题时等待暂停（每 2 秒复查一次），用户回答、超时或取消后重新给一段完整的等待时间。`ask_main` 的回答仍作为阻塞工具的结果返回，而不是普通追加消息——Pi 的 steer 队列只在当前回合的工具返回后排空，工具等待自己会死锁。

验证见 [真实子代理进程的送达、提问与取消](../test/p46-subagent-messages-pi.test.js)。

### 子智能体之间的单向消息

运行中的 Subagent 可以调用 `send_peer_message({targetCallId, message, priority?})`，向同一 Task/Run 中的另一个 Subagent 发送一条非阻塞消息。`targetCallId` 必须由 Main 在委派任务或后续指导中提供；消息最多 8,000 个字符，适合传递短问题、修正意见、结论或文件/产物路径。

消息先持久化到目标 Subagent 的 Inbox，再在其下一次安全模型轮次注入。工具只返回排队结果，不等待回答；目标可以自行发送另一条消息。已结束或不存在的调用会被拒绝，peer message 不建立嵌套委派或同步依赖，Main 仍负责最终验收和 Task 完成判断。

### 查询任务与委派状态

`get_task_status()` 默认只返回委派的标识、状态、回调状态和诊断路径，不重复附带子任务简报、结果正文、错误正文或产物清单。`resultAvailable` 表示已有持久回调或诊断文件，重试期间也可能指向上一轮尝试，不代表本次任务已完成或验证通过。只有回调已持久确认消费时，`resultDelivered` 才为 `true`；没有回调记录时省略该字段，`callbackState` 为 `none`。

需要找回某次异步结果时，用 `get_task_status({resultCallIds:["<callId>"]})` 显式重读指定回调保存的正文、错误和产物路径；其余委派仍返回简要状态。查询不认领或消费 Inbox 消息，待交付结果通过原有回调或 `wait_for_subagents` 接收。`wait_for_subagents` 把结束的回调作为工具结果交付并随该结果确认消费，之后仍可按 `resultCallIds` 重读；诊断路径指向完整运行记录。

### 子智能体中断后的部分进展

子智能体失败、超时或取消时，返回结果会附带最多 6,000 字符的部分进展，包含：

- 最近两条可见说明；
- 最近六个有工具回执的文件改动；
- 最近四个已返回的工具记录；
- 最多两个结果未知的操作。

命令记录保留退出码和输出首尾，文件正文、补丁内容和思考记录不回灌，也不额外请求模型生成总结。摘录可能省略更早的工作，不能证明任务或测试已经完成；结果未知的操作须先检查实际影响再决定是否重做。

该结果通过现有 Inbox 交付。必要时可按诊断路径定向查看完整记录。

## 请求重试与上下文恢复

Main 与子智能体默认最多自动重试 5 次，不含首次请求。Main 通常按 2、4、8、16、32 秒退避，已有 Pi 显式设置保留；子智能体可用 `maxErrorRetries` 覆盖。明确的模型不存在、认证、权限和额度耗尽不自动重试，连接测试只请求一次。`FORMICAND_MAX_ATTEMPTS` 是另一层委派预算。

App/Web 的“重试”重发失败请求保存的序列化正文，包括系统消息、模型、工具定义、附件和生成参数，不追加“继续”指令。成功的工具结果沿用。重放期间的新回调先排队，成功后再处理；未进入原正文的输入和文档变更不会被视为已经读取。

私有快照在请求发送前保存，记录写入时的 Pi 版本，并校验 Task 存储根与工作目录。设置或来源变化、快照损坏或缺少执行归属时，拒绝精确重放并保留记录。版本与当前运行时不一致时不重放，按原请求身份继续该轮并由 Pi 从会话重建上下文，新快照写明原因。没有快照的旧会话只能按已存上下文继续。取消优先于恢复，旧重试操作不能复活已取消运行。格式与备份边界见[数据布局](task-workspace-layout.md)。

Headless Run 恢复时读取该 Run 的 Pi 会话与运行记录；若最后已是完整结束文本且没有未完成工具调用，只完成落盘，不重新请求模型。已成功的 Run ID 不能复用；新增工作使用新 Run。生命周期命令本身不等于启动模型执行。

CLI 显式 `FORMICAND_TASK_ID` 优先于自动关联。Task 与会话属于不同项目时拒绝恢复。未记录关联的旧会话可使用 `FORMICAND_TASK_ID=my-task formicand --session <session-id-or-path>`，此后按关联继续。

### 上下文窗口与交接页

Main 与子代理共用五级上下文管理。前三级不调用模型；换窗时请求一次模型总结。

1. 工具文本或结构化结果超过 20,000 字符时，原文写入 Pi 会话旁的 `tool-results/`，模型看到 `Output too large (N KB). Full output saved to: <相对路径>` 和最多 1,000 字符的头尾预览。原结果另存在结果的 `details.archivedOutput` 里，供对话界面显示。图片按原有形式传递，嵌套工具以最外层的结果为归档单位。
2. 回合结束时，用量超过 50% 且一批预计能节省窗口的 10%，Pi 用 `context_edit` 将较旧结果换成占位。保留最近五次、所有 `load_skill` 和 `askhuman` 结果，以及最近一次 `project_development`。占位为 `[Old tool result content cleared]`，工具调用本身保留，原结果可用 `search_history` 与 `read_history` 取回。
3. 每个窗口首次在回合边界超过 75% 时，提醒大致还剩多少 token，以及怎样保存笔记。
4. 达到 Pi 的压缩阈值、调用 `clear_context` 或在输入框发送 `/compact` 时，请求模型总结离开的窗口，与程序带过去的记录合成交接页后换窗口。常规换窗保留最近最多八个可见条目，预算为 2,000 估算 token 和窗口 10% 中较小者，从一条用户或助手消息开始。正在执行一步时收到命令，在步骤边界换窗。对话里只显示一条分隔线，交接页不发给浏览器；标题栏显示用量，提示里有窗口序号。
5. 模型接口返回上下文超长错误时，不请求总结，使用更短的交接页并清空原文尾部，然后重试当前回合。首条输入已超长、Pi 无法准备原生切点时也走这条路径。应急交接页最多 6,000 字符，小窗口进一步缩减。

交接页最多 60,000 字符且不超过窗口，先是一段接续说明，然后依次是模型总结、当前开发记录的目标、完成标准、路线、票状态和开发服务给出的 `next`、未结束的委派和提问、会话笔记、用户原话。总结请求只含离开的窗口，放不下时保留开头和最近部分，禁止调用工具，丢弃 `<analysis>`，只留 `<summary>`。总结失败、超时或为空时交接页注明没有总结。各记录节有上限，没用满的空间留给用户原话；原话从最新往前整条放入，放不下的只计条数，最新一条过长时写出条目 ID 与长度。Main 离线时 `/compact` 由后端用 Main 的模型连接请求总结。系统指令与技能目录沿用原来的提示路径。

用 `session_notes` 读取、追加或整篇改写笔记，继续同一个 Pi 会话时保留。用 `search_history` 搜索原始用户、助手、自定义消息和工具结果，可按角色与工具名筛选。用返回的条目 ID 或预览中的归档相对路径调 `read_history` 取原文，每次最多 16,000 字符。范围从零开始，结束位置不含在内。也可按编号取回原始图片，或选择已归档的结构化结果。

## CLI 导出与反馈

以下导出不需要模型连接：

```sh
formicand session export <session-id-or-path> --format json --output audit.json
formicand session export <session-id-or-path> --format html --output conversation.html
# 兼容旧的离线 HTML 导出入口。
formicand --export /path/to/session.jsonl conversation.html
```

会话参数可为完整 ID、唯一前缀或路径。默认不覆盖已有文件；`--force` 也不能覆盖源会话或其链接。导出校验分支引用，失败时保留源文件和已有导出。JSON 包含所有分支，HTML 可独立打开且不含脚本或外部资源。格式见[会话导出](task-workspace-layout.md#formicand-会话导出格式)。

交互终端支持 `/export [json|html] [文件路径]`、`/share [文件路径]` 和 `/bug [描述]`。分享副本和反馈报告只存本机，不自动上传；`/help` 查看命令，`/changelog` 查看更新记录。诊断可用 `/formicand-debug`、`FORMICAND_DEBUG=1 formicand` 和 `Ctrl+O`。

模型请求归档与私有重试快照分别保存。归档里每次请求只写比之前多出来的内容：对话只记新增的条目，并附上沿用前一条请求的条数和校验值；系统提示词、工具定义和请求里其他没变的字段不重写。压缩改写了历史、接不上时整条重写。按 `parseModelRequestArchive` 读取即可逐字还原每次实际发送的请求；链断开或校验不符时报错，不猜测。Pi 自己那份上下文副本只留在重试快照里。归档包含用户内容、工具结果和模型响应，虽不写认证 headers，仍应按私有数据保护。用量只代表服务实际报告的字段，缺失值不能当作零或据此证明上游缓存状态。路径、格式与保留范围统一见[数据布局](task-workspace-layout.md)。

## Task、Worker 与人工问题

安装包可将 `npm run cli --` 换成 `formicand`。以下示例使用独立开发工作区：

```sh
npm run cli -- task cancel <task-id> --workspace /tmp/formicand-dev
npm run cli -- task resume <task-id> --workspace /tmp/formicand-dev
```

`formicand start` 这类没有本地服务的 Run 由启动器装配自己的子代理后端；不需要单独 `single` 命令或进程内会话入口。

Main 等待人工回答时，可离线列出并回答持久问题：

```sh
npm run cli -- human list --workspace /tmp/formicand-dev --task <task-id> --status pending
npm run cli -- human reply --workspace /tmp/formicand-dev --task <task-id> --request <request-id> --answer "确认后的答案"
```

已接受的回答只消费一次。人工回复草稿按任务和问题保存，提交失败或切换会话时保留。等待结束与后台回调共用持久投递机制；只读状态查询不消费回调结果。

独立恢复入口需要正确的 Task、Run、模型连接与预算：

```sh
# 恢复子智能体队列，检查一次。
npm run cli -- worker --workspace /tmp/formicand-dev --task <task-id> --run <run-id> --once
# 恢复 Main Inbox。
npm run main-worker -- --workspace /tmp/formicand-dev --task <task-id> --once true
# 默认只报告；--spawn true 才启动模型进程。
npm run cli -- main-supervisor --workspace /tmp/formicand-dev
npm run cli -- main-supervisor --workspace /tmp/formicand-dev --spawn true
```

Task/Worker 命令在执行前验证选项。以 `-` 开头的任务或回答文本放在 `--` 后。帮助和版本查询不启动后台进程。

## 停泊与定时唤醒

`sleep_until(reason, wakeInSeconds)` 把当前 Task 记为等待：Task 跨进程重启保持打开，到期后由 Main 守护把一条持久 Inbox 唤醒消息写入 Task 当前活动 Run 的收件箱，并在写入后清除停泊记录。停泊后 Task 可能已经换了 Run，只有当前 Run 的 Main 会读取收件箱，所以唤醒不写回停泊时那个 Run。`wakeInSeconds` 最小 60 秒；没有到期时间的停泊会被拒绝，因为已经没有别的调度器能唤醒它。结束一轮不等于停泊：没有停泊记录且没有未了结工作的 Task 按完成处理。

`FORMICAND_DISABLE_MAIN_GUARDIAN=1` 关闭守护；`FORMICAND_MAIN_GUARDIAN_INTERVAL_MS` 默认为 60000。守护只读取 Task、Inbox、人工问题和停泊记录；有未消费回调、没有存活 Main、且没有等待人回答的 Task 会被重新拉起。

## 通用工具接口

`load_skill` 默认保留完整指令，避免丢掉中间的必需规则；显式预算仍可限制它。`browse_workspace` 只读整个 Task 工作区，写入和命令仍限制在智能体自己的现场。没有程序化的 `PiSession` / `RunService.runPi` 入口，也没有 `createBuiltinTools`：Main 用扩展注册的 Pi 工具，委派子代理按角色用同一套工具，两者共用 Pi 的上下文压缩。

`createWebTools` 的公开合同不变。未指定 `provider: "exa"` 时，`visit` 直接读取源文本；可选 Jina Reader 和提取回调仍受总超时与取消限制。产品 Main 的搜索配置见[联网搜索](configuration.md#联网搜索)。模型手测与评测入口见[本地测试](testing-local-run.md)。
