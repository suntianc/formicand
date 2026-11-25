# 开发

简体中文 | [English](en/development.md)

先读 [AGENTS](../AGENTS.md) 和 [架构与代码地图](architecture.md)。测试的写法和跑法见 [测试](testing.md)。

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

## 日常修改流程

1. 从 [代码地图](architecture.md#代码地图) 找到负责这个行为的模块、它的消费者和测试，读目标目录的 `AGENTS.md`，再到 [坑点](pitfalls/README.md) 里找和本次工具、路径或接口相关的条目。
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

- 每个事实只在一份文档里写，其他地方链接过去。现行行为写进使用和接口文档；还没做的写进 [阶段规划](development-phases.md)，附上完成标准。
- 改了命令、配置、路径或接口，在同一个改动里更新文档。命令必须和 `package.json`、脚本、CLI 帮助对得上。
- 使用文档（上手、配置、内置能力、架构、开发、测试）中英双语，英文版在 `docs/en/`，改一份要同步另一份。过程记录（复盘、坑点、交接、设计方案）只写中文。
- 不提交真实密钥、私有服务、个人配置和用户任务。示例用占位符和通用路径。
- 用相对 Markdown 链接。删除或移动文档时，更新所有引用它的地方，再跑 `npm run check:docs`。

文档站：`cd docs/site && npm ci && npm run preview` 在本机预览，`npm run build` 生成静态站点到 `.tmp/docs-site/`。导航在 [navigation.mjs](site/navigation.mjs)，新增文档要登记进去。

## 定位故障

| 现象                           | 先查                                                          |
| ------------------------------ | ------------------------------------------------------------- |
| 保存失败、409                  | 版本号、外部修改和并发提交；保留草稿后重读，不要自动覆盖      |
| Agent 看不到附件或工具         | 上传记录、工具组是否打开、首轮和后续的上下文装配              |
| 任务卡住、停不干净、恢复后重复 | 任务和 Run 的事件、收件箱消费、提问、派单、后台任务和进程结束 |
| 重启后草稿或附件不见了         | 数据目录、全局索引和草稿文件；先记下实际路径                  |
| 模型启动失败                   | 地址、接口格式、模型、参数和环境变量覆盖；不要打印完整配置    |
| 异步结果覆盖了新会话           | 记下的任务和草稿身份、导航 token、迟到的请求                  |

各种日志和记录的位置见 [数据布局](architecture.md#数据布局)。
