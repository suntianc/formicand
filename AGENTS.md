# Formicand 开发入口

中文 | [English](AGENTS.en.md)

本文件供人和编码 Agent 使用。用户安装从 [README](README.zh-CN.md) 开始；产品内 Agent 的提示词和技能在 `.pi/`，与本仓库开发指引分开。

## 开始一项修改

1. 阅读 [代码地图](docs/development.md#代码地图)，找到功能的实现层、消费者与测试；不要先向入口文件追加分支。
2. 阅读目标目录内的 `AGENTS.md`，跨目录修改时阅读两端指引；从 [坑点索引](docs/pitfalls/README.md) 选择与本次工具、路径或接口匹配的条目。
3. 当前行为以代码、测试和 [架构](docs/development.md#架构) 为准；按当前问题和验收范围选择工作。
4. 先复现问题，再修改负责该行为的模块。完成后运行相关行为测试和本地验证，报告实际执行命令、失败和跳过项。

涉及多个桌面平台时，按[跨平台改动的分工与交接](docs/development.md#跨平台改动的分工与交接)确定共享实现、目标机验证和交接提交。

## 仓库地图

| 目录                                            | 职责                                      | 约束入口                                 |
| ----------------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| `src/cli/`、`scripts/formicand.mjs`             | 用户命令、启动器与 smoke 入口             | [代码地图](docs/development.md#代码地图) |
| `src/dashboard/`                                | 本地 HTTP/SSE、服务装配和 Run 编排        | [服务指引](src/dashboard/AGENTS.md)      |
| `src/runtime/`                                  | Task/Run、调度、恢复、模型与 Pi 会话      | [运行时指引](src/runtime/AGENTS.md)      |
| `src/gui/`、`src/security/`                     | 原生交互、窗口授权与执行权限              | [窗口访问](README.zh-CN.md#操作本机窗口) |
| `src/domain/`、`src/storage/`、`src/workspace/` | 领域类型、事件、工作区与产出物            | [数据布局](docs/development.md#数据布局) |
| `.pi/`                                          | 产品运行时的 Pi 装配、领域工具和技能      | [Pi 指引](.pi/AGENTS.md)                 |
| `web/`                                          | Web 与桌面共用的界面与控制器              | [前端指引](web/AGENTS.md)                |
| `desktop/`                                      | Electron 窗口、可信 IPC、本地后端生命周期 | [桌面指引](desktop/AGENTS.md)            |
| `test/`、`e2e/`                                 | Node 回归与浏览器/原生验收                | [测试指引](test/AGENTS.md)               |
| `docs/`                                         | 用户指南、开发约定和接口参考              | [文档指引](docs/AGENTS.md)               |
| `scripts/`、`.github/`                          | 构建、验证、打包、CI                      | [开发指南](docs/development.md)          |

## 文档

登记表说明每份文档是什么、归哪个领域。一个文件属于第一行覆盖它的路径，所以这里逐项写出路径，不设兜底行：新文档没登记时程序会拒绝冻结终审。根 `AGENTS.md`、`CLAUDE.md` 和 `docs/pitfalls/` 不写也算已登记；产品说明只剩根目录的 `README.md` 与 `README.zh-CN.md` 一对，`docs/en/README.md` 是英文文档入口。

| 路径                                 | 类型         | 领域         |
| ------------------------------------ | ------------ | ------------ |
| `.pi`                                | instructions | Pi           |
| `src/runtime`                        | instructions | 运行时       |
| `src/dashboard`                      | instructions | 后端         |
| `web`                                | instructions | 前端         |
| `desktop`                            | instructions | 桌面         |
| `test`                               | instructions | 测试         |
| `docs/AGENTS.md`                     | instructions | 文档         |
| `AGENTS.en.md`                       | instructions | global       |
| `docs/adr`                           | adr          | global       |
| `docs/adr-history.md`                | history      | global       |
| `docs/pitfalls`                      | pitfalls     | global       |
| `docs/retrospectives.md`             | history      | global       |
| `docs/p1-retrospective.md`           | history      | global       |
| `docs/p2-retrospective.md`           | history      | global       |
| `docs/p3-retrospective.md`           | history      | global       |
| `docs/p4-retrospective.md`           | history      | global       |
| `docs/p4.5-retrospective.md`         | history      | global       |
| `docs/core-pruning-retrospective.md` | history      | global       |
| `docs/development-handoffs.md`       | standards    | 交接         |
| `docs/development.md`                | standards    | 开发         |
| `docs/testing.md`                    | standards    | 测试         |
| `CONTRIBUTING.md`                    | standards    | 贡献规范     |
| `CONTRIBUTING.en.md`                 | standards    | 英文贡献规范 |
| `GLOSSARY.md`                        | glossary     | global       |
| `README.zh-CN.md`                    | product      | 产品说明     |
| `README.md`                          | product      | 英文产品说明 |
| `THIRD_PARTY_NOTICES.md`             | product      | global       |
| `docs/en/README.md`                  | product      | 英文文档     |
| `docs/README.md`                     | product      | 文档         |
| `docs/hero/README.md`                | product      | 界面         |
| `scripts/eval/README.md`             | product      | 测评         |
| `scripts/eval/repo/README.md`        | product      | 测评示例     |
| `.github/pull_request_template.md`   | product      | 审查模板     |
| `.github/RELEASE_TEMPLATE.md`        | product      | 发布模板     |

## 代码规则

- CLI 与桌面宿主使用同一套服务。共享业务模块不能导入 CLI 入口；运行时层不能反向导入 Dashboard。ESLint 检查这些方向。
- 路由只校验、调用服务、映射响应；进程由 Run/ProcessHost 管理。导入服务模块不能启动端口、安装信号或发出模型请求。
- 按功能职责扩展现有服务、控制器或 `.pi/runtime/tools/`。保持入口负责装配，避免把新能力集中到 `web/app.js`、Coordinator 或 Pi 扩展入口。
- TypeScript 使用 strict 和 ESM，本地 TS 导入保留 `.js` 后缀；桌面宿主保留 `.cjs`。外部 JSON、文件、工具参数、HTTP/IPC 在入口验证，错误必须可定位且不泄露密钥。
- 错误要处理或向上传递，类型已保证的值直接使用。ESLint 检查丢弃错误、多余条件和类型断言；存量记录在 `eslint-suppressions.json`，新代码保持零新增。确有依据的例外逐处写 `// eslint-disable-next-line <rule> -- <依据>`。构建前置、规则范围与基线收紧见 [Lint 基线](docs/development.md#lint-规则)。
- 持久格式、事件、HTTP、IPC 变更同时检查生产者和消费者。破坏兼容时写迁移和恢复策略；不原地改变旧格式字段含义。
- 不修改 Pi 的 `node_modules` 或生成文件来修产品问题；第三方改动要记录来源、版本和差异。
- 根目录保留公共入口、许可、示例配置与工具配置。维护中的技术文档放 `docs/`，构建与启动脚本放 `scripts/`；生成产物和本机绑定配置不作为源码提交。
- 只格式化本次修改。不要顺带重排旧文件、升级依赖或移动无关模块。

## 界面设计

避免不必要的次要标签、说明文字、辅助文案、描述性文字和冗余的微文案。让布局、视觉层级、间距和清晰的主操作自己完成解释。

- 优先用强视觉层级和自解释的结构，而不是用文字去解释。
- 默认不要添加 slogan 式文字、教学段落，或在每个区块下都加“帮助说明”。
- 如果确实需要补充信息，优先使用 info 图标 + tooltip，而不是始终显示的次要文字。
- 保留必要的表单标签和可访问名称，方便读屏软件；界面清爽不能牺牲可访问性。
- 危险或不可逆操作（删除、支付、提交永久性变更）必须保留清晰的后果提示。
- 去掉说明文字后，第一次使用的人仍应能看懂下一步点哪里、点了会发生什么。
- 重写已有界面时，先去掉冗余标签和说明；如果清晰度下降，再优化布局和按钮文案。
- 性能优先：动效、图标和列表在保持最佳性能的前提下做到同等精致，具体要求见[前端指引](web/AGENTS.md#性能与动效)。

## Pi 依赖边界

Pi 包（`@earendil-works/pi-*`）的运行时导入只允许出现在持有 Pi 进程的地方，其余模块只能用 `import type`。允许的范围是 [ESLint 规则](eslint.config.mjs) `formicand/pi-import-boundary` 里的明确清单，[依赖边界回归](test/architecture-boundaries.test.js) 检查清单和本节一致：

- 目录：`.pi/`（扩展和工具）、`scripts/`（启动器）。
- 模型配置：`src/runtime/main-request-retry.ts`、`src/runtime/model-cache.ts`、`src/runtime/model-connection.ts`、`src/runtime/model-levels.ts`、`src/runtime/model-profile.ts`、`src/runtime/model-provider.ts`、`src/runtime/model-request-recording.ts`。
- Main 会话文件读写（Main 不在运行时由后端改写会话，用于编辑重发、分叉和离线换窗）：`src/runtime/conversation-fork.ts`、`src/runtime/main-message-edit.ts`。

Pi 包内部深路径（例如 `@earendil-works/pi-ai/api/...`）只允许模型配置模块导入。这样升级 Pi 时，只需排查清单里的模块。

## 独立审查

改动碰到下表的路径时，程序不接受 Main 只靠自查合入，必须有独立 Reviewer。一行一个路径（文件或目录，`*` 匹配一段名字里的任意字符），规则以开发开始时的版本为准。

| 路径                            | 原因                         |
| ------------------------------- | ---------------------------- |
| `src/storage`                   | 持久格式与迁移               |
| `src/workspace/*-repository.ts` | 项目数据的读写               |
| `src/dashboard/*-routes.ts`     | HTTP 接口                    |
| `desktop`                       | 桌面宿主、IPC 与后端生命周期 |
| `src/security`                  | 执行权限与窗口授权           |

## 本地验证与交付

开发环境使用 Node >=22.19.0 和 `npm ci`。日常按修改范围验证：纯文档改动运行 `check:docs` 和 `format:check`；行为改动运行相关测试及轻量 `npm run verify`（CLI 与 Web 资源构建、源码卫生、静态检查和发布执行器自测）。发布验收或影响范围广的修改显式运行 `npm run verify:full`，完成完整构建、发布 runner 自测和全量确定性 Node 回归，不对每次小修改重复全量执行。`npm run test:unit -- --match model` 选择相关文件，`npm run check:docs` 检查文档链接，`npm run check:source` 检查当前源码是否混入私有配置、凭据、个人路径或生成/旧文档。完整命令和测试分层以 [本地测试指南](docs/testing.md) 为准。相关测试不能由模拟断言替代真实生命周期；浏览器、原生、真实模型与干净安装分别记录结果。

日常 PR 与 main 推送运行桌面纯策略单测和轻量静态检查 `npm run check:ci`。桌面相关路径另触发三平台目录包冒烟，也可定时或手动运行。发布 tag 或手动发版按[打包和发布](docs/development.md#打包和发布)生成草稿，干净机验收和发布确认另行留证。完整回归按改动范围在本地执行。

提交说明包含：问题和结果、涉及模块/接口、执行的检查、尚未验证的范围。委派、返修、独立审查和归档按 [开发交接](docs/development-handoffs.md) 明确本轮增量、验证责任与证据。改变命令、功能、路径或接口，同一变更更新对应文档与代码地图；还没做的范围和下一步记在需求台账的开发记录里，不写进仓库文档。

`config.json`、`.formicand/`、`.tmp/`、`applications/`、`workspace/`、`task-*/`、supervisor 锁和用户数据都不是源码。不要读取真实密钥、删除运行数据、清理用户任务或把它们放进发布包。测试使用自己的临时目录与本地假模型服务。

第三方许可清单、分发渠道、签名/公证、干净机器安装和实际模型连接分别记录独立证据。正式/稳定版须完成对应 P0 门槛；限定范围的公开 beta 按贡献约定声明支持范围、ad-hoc/未公证的安装方式和待验收项，未完成的检查不能写成通过。本项目自有代码采用 MIT，第三方例外见 [许可证说明](THIRD_PARTY_NOTICES.md)。完整流程见 [贡献约定](CONTRIBUTING.md) 与 [打包和发布](docs/development.md#打包和发布)。
