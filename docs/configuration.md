# 配置

简体中文 | [English](en/configuration.md)

第一次连接模型的步骤见 [上手](getting-started.md)。本页是全部配置项的说明。

## 模型连接

一条连接需要四样东西：

| 项目     | 填写内容                                                                       |
| -------- | ------------------------------------------------------------------------------ |
| API 地址 | 服务根地址或带 `/v1` 的地址。不要带 `/responses`、`/chat/completions` 这类路径 |
| 模型     | 服务商提供、当前账号能调用的模型 ID                                            |
| API Key  | 当前服务的密钥                                                                 |
| 接口格式 | `openai-responses`、`openai-completions` 或 `anthropic-messages`               |

服务必须支持所选格式的流式响应和工具调用。

### App 里的设置

“设置 → 模型”管理供应商和模型；“设置 → Agent”决定每个 Agent 用哪个模型。

- 只填域名的地址会自动补 `/v1`，带路径的地址原样使用。`anthropic-messages` 不补路径。
- 模型行的参数按钮可以改上下文窗口、输出上限、推理档位和图片输入。标“自动”的值来自服务商接口或内置目录。
- 改了名称、地址、密钥或接口格式后要点“保存”。
- 正被某个 Agent 使用的模型或供应商不能删除或停用，先在“设置 → Agent”里换掉。

### Agent 用哪个模型

“设置 → Agent”的“内置”分组有三个 Agent：Main（主控）、Executor（执行）、Reviewer（审查）。它们的职责、权限和工具是固定的，可以改的是模型、推理强度、技能、MCP 服务和附加提示词。“项目”页可以给单个项目单独设置，没单独设置的项跟随全局。

| Agent    | 没选模型时                     | 默认技能                                                                                          | 默认 MCP         |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------- |
| Main     | 第一个启用的供应商的第一个模型 | 全部                                                                                              | 全部已启用的服务 |
| Executor | 跟 Main 一样                   | `implement`、`tdd`、`diagnosing-bugs`、`code-review`、`domain-modeling`、`codebase-design`、`cua` | 不用             |
| Reviewer | 跟 Main 一样                   | `code-review`、`domain-modeling`、`codebase-design`、`cua`                                        | 不用             |

生效时机：

- Main 的设置从下一轮对话开始生效。
- Executor 和 Reviewer 的技能、MCP、附加提示词在派单时定下来，模型在工作项真正启动时读取。已经在跑的工作项不受之后修改的影响。
- 切换模型会保留会话，下一轮把历史发给新的服务。

## 配置文件

CLI 和源码运行的 Web 按顺序找第一份存在的配置文件，文件之间不合并：

1. 环境变量 `FORMICAND_CONFIG` 指定的文件；
2. 启动目录下的 `.formicand/config.json`；
3. 启动目录下的 `config.json`；
4. `~/.formicand/config.json`（设置了 `FORMICAND_HOME` 时是 `FORMICAND_HOME/config.json`）。

环境变量覆盖文件里的同名设置，命令行参数再覆盖环境变量。选中的文件有错误时直接报错，不会退到下一份。`formicand doctor` 显示实际用的是哪一份。

App 的设置也写在执行主机的这份配置里，模型供应商保存在 `modelProviders` 下。

### CLI 单连接写法

```json
{
  "baseUrl": "https://your-service.example/v1",
  "model": "your-model-id",
  "apiKey": "replace-with-your-api-key",
  "api": "openai-responses"
}
```

`formicand init` 只新建，不覆盖；`formicand init --force` 读取已有文件，只询问缺的项。脚本里初始化可以从环境变量读密钥：

```sh
formicand init --base-url https://your-service.example/v1 --model your-model-id --api-key-env FORMICAND_API_KEY
```

可选参数：`--images`、`--reasoning`、`--thinking high`、`--max-tokens 8192`、`--force`。

只给当前项目单独配置时，在项目目录运行 `FORMICAND_CONFIG="$PWD/.formicand/config.json" formicand init`。源码开发可以复制根目录的 `config.example.json` 到 `.formicand/config.json`。

同时有 `modelProviders` 和顶层单连接字段时，以 `modelProviders` 为准。

### 模型参数

这些字段既可以写在单连接的顶层，也可以写在 `modelProviders` 里的每个模型上。

| 字段                                  | 说明                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| `api`                                 | 接口格式。缺省时是 `openai-completions`，`init` 新建的连接写 `openai-responses` |
| `supportsImages`                      | 是否把图片发给模型。默认 `false`                                                |
| `reasoningEffort`                     | `off`、`low`、`medium`、`high`、`xhigh`、`max`，服务要支持所选档位              |
| `supportsReasoningEffort`             | 是否发送推理强度字段。默认 `false`                                              |
| `thinkingFormat`                      | `auto`（默认）、`openai` 或 `zai`，只影响 Chat Completions。GLM 网关用 `zai`    |
| `supportsPromptCacheKey`              | 是否给第三方服务发 `prompt_cache_key`。默认 `false`                             |
| `contextWindow`                       | 上下文预算，默认 256000 token，用于自动压缩，不发给服务                         |
| `mainMaxTokens` / `subagentMaxTokens` | 单次输出上限，新连接都是 8192                                                   |
| `workspaceRoot`                       | 任务数据目录，建议写绝对路径                                                    |

不支持图片的连接上，读图工具会明确返回“当前模型不支持图片”，电脑操作和浏览器操作也不会提供。

### 供应商写法

```json
{
  "modelProviders": {
    "version": 1,
    "providers": [
      {
        "id": "<供应商 ID>",
        "name": "DeepSeek",
        "preset": "deepseek",
        "baseUrl": "https://api.deepseek.com",
        "api": "openai-completions",
        "enabled": true,
        "models": [{ "id": "deepseek-chat", "contextWindow": 256000, "mainMaxTokens": 8192 }]
      }
    ]
  }
}
```

模型用 `<供应商 ID>#<模型 ID>` 引用。`preset` 只影响界面上的图标和预置地址。

### Agent 设置写法

“设置 → Agent”写入 `roleModels`：

```json
{
  "roleModels": {
    "version": 1,
    "host": {
      "main": { "profileId": "<供应商 ID>#<模型 ID>", "thinkingLevel": "high", "mcp": "all" },
      "executor": { "skills": ["pg-migration"], "mcp": ["postgres"], "prompt": "改动前先跑测试。" }
    },
    "projects": { "/path/to/project": { "executor": { "thinkingLevel": "medium" } } }
  }
}
```

`host` 是本机的默认值，`projects` 按项目目录覆盖。每项都可以省略；`skills` 和 `mcp` 写名称列表或 `"all"`。引用的模型找不到时会报错并拒绝启动，不会悄悄换成别的模型。

## 密钥存放

| 密钥                   | 存放位置                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------- |
| 模型和搜索的密钥       | 配置文件旁边的 `credentials.json`（权限 0600），可用 `FORMICAND_CREDENTIALS` 改路径 |
| App 连接后端的会话凭据 | 用系统钥匙串加密，存在 `client-sessions.json`                                       |

界面和接口只显示“已配置”，不回传密钥。删除供应商时同时删除它的密钥。凭据文件损坏时会报错并保留原文件，不会覆盖。

## 联网搜索

默认用 [Exa 官方 MCP](https://exa.ai/docs/get-started/exa-mcp)，提供搜索和读网页两个工具。

- 关闭：配置里写 `"webSearch": { "provider": "off" }`，或设置环境变量 `FORMICAND_WEB_TOOLS=0`。
- 用自己的 Exa 密钥：`webSearch.exaApiKey`，或环境变量 `FORMICAND_EXA_API_KEY` / `EXA_API_KEY`。

修改后，常驻的 Main 在下一轮开始时生效。

## 网络代理

| 字段         | 环境变量                      |
| ------------ | ----------------------------- |
| `httpProxy`  | `HTTP_PROXY` / `http_proxy`   |
| `httpsProxy` | `HTTPS_PROXY` / `https_proxy` |
| `noProxy`    | `NO_PROXY` / `no_proxy`       |

环境变量优先。只接受 HTTP(S) 地址。`localhost`、`127.0.0.1`、`::1` 总是绕过代理。

## 项目数据

项目、需求台账、看板、开发与合入记录保存在项目数据服务里。默认用本机 SQLite，文件在 `~/.formicand/runtime/project-data.sqlite`。也可以用 PostgreSQL：

```json
{
  "projectData": {
    "engine": "postgres",
    "postgres": { "connectionString": "postgresql://formicand@db.example:5432/formicand" }
  }
}
```

另一台后端要共用同一份数据时，不开本地数据库，改成连到那台服务：

```json
{ "projectData": { "authority": { "url": "http://127.0.0.1:3880", "token": "<本机凭据>" } } }
```

引擎在启动时确定。配置错、连不上或认证失败都会直接报错，不会换引擎，也不会用空库继续。换引擎不会搬迁已有数据。

备份和恢复：

```sh
formicand data backup --to ~/backups/project-data.json
formicand data restore --from ~/backups/project-data.json
```

备份只含项目数据库里的记录，不含会话历史和项目文件。恢复前先停掉写这个数据目录的后端，恢复后再启动。数据库版本对不上时会拒绝打开，并说明文件和版本。

## 外部 Main 名额

通过外部入口创建的 Main 有名额限制，没配置时不接受外部会话：

```json
{ "mainCapacity": { "resident": 2, "continuation": 1 } }
```

`resident` 是同时运行的外部常规 Main 数，`continuation` 是留给接续 Main 的名额，两者不互相借用，上限都是 32。超出名额的请求按顺序排队。

## 运行限制

| 字段                        | 环境变量                                 | 默认值                                 |
| --------------------------- | ---------------------------------------- | -------------------------------------- |
| `mainMaxTurns`              | `FORMICAND_MAIN_MAX_TURNS`               | 2000                                   |
| `subagentMaxTurns`          | `FORMICAND_MAX_TURNS`                    | 200                                    |
| `mainTimeoutMs`             | `FORMICAND_MAIN_TIMEOUT_MS`              | 0，不限时                              |
| `mainIdleTimeoutMs`         | `FORMICAND_MAIN_IDLE_TIMEOUT_MS`         | 300000（5 分钟）；0 表示空闲时不退出   |
| `subagentTimeoutMs`         | `FORMICAND_SUBAGENT_TIMEOUT_MS`          | 0，不限时                              |
| `commandTimeoutMs`          | `FORMICAND_COMMAND_TIMEOUT_MS`           | 1800000（30 分钟）；0 不限时           |
| `maxAttempts`               | `FORMICAND_MAX_ATTEMPTS`                 | 3，含第一次派单；1 表示不重派          |
| `subagentQuestionTimeoutMs` | `FORMICAND_SUBAGENT_QUESTION_TIMEOUT_MS` | 180000（3 分钟）；0 表示子代理不能提问 |
| `subagentMaxQuestions`      | `FORMICAND_SUBAGENT_MAX_QUESTIONS`       | 3                                      |
| `humanAnswerTimeoutMs`      | `FORMICAND_HUMAN_ANSWER_TIMEOUT_MS`      | 60000（1 分钟）                        |

时间单位都是毫秒。`mainIdleTimeoutMs` 指常驻 Main 在没有进行中的回合、也没有子代理在跑时保留进程多久；到时退出，会话保留，下一条消息会重新拉起它。

## 环境变量

| 环境变量                                                            | 用途                                        |
| ------------------------------------------------------------------- | ------------------------------------------- |
| `FORMICAND_CONFIG`                                                  | 指定配置文件                                |
| `FORMICAND_HOME`                                                    | 数据目录，默认 `~/.formicand`               |
| `FORMICAND_API_BASE` / `FORMICAND_MODEL` / `FORMICAND_API_KEY`      | 覆盖地址、模型、密钥                        |
| `FORMICAND_MODEL_API`                                               | 覆盖接口格式，取值同 `api`                  |
| `FORMICAND_SUPPORTS_IMAGES`                                         | `1` 开启、`0` 关闭图片输入                  |
| `FORMICAND_REASONING_EFFORT`                                        | 推理强度                                    |
| `FORMICAND_WORKSPACE`                                               | 任务数据目录，默认 `~/.formicand/workspace` |
| `FORMICAND_PROJECT_DIR`                                             | Main 读写文件和执行命令的项目目录           |
| `FORMICAND_UI_PORT`                                                 | 源码运行 Web 的端口，默认 3880              |
| `FORMICAND_PROJECT_DATA_ENGINE`                                     | 项目数据引擎：`sqlite` 或 `postgres`        |
| `FORMICAND_PROJECT_DATA_SQLITE` / `FORMICAND_PROJECT_DATA_URL`      | SQLite 文件路径 / PostgreSQL 连接地址       |
| `FORMICAND_PROJECT_DATA_AUTHORITY` / `FORMICAND_PROJECT_DATA_TOKEN` | 共享项目数据服务的地址 / 凭据               |
| `FORMICAND_TRUSTED_CLIENT_ORIGINS`                                  | 允许访问后端的本机页面来源，逗号分隔        |

以 `FORMICAND_` 开头的其他变量是进程之间内部传递用的，不需要手动设置。

## 其他设置

- **界面语言**：“设置 → 通用 → 语言”，简体中文或 English，切换后刷新页面生效。
- **外观**：App 存在数据目录的 `appearance.json`，Web 存在浏览器里。
- **App 的命令搜索路径**：从 Finder 或 Dock 打开的 App 会把 `~/.local/bin`、Homebrew 和 `/usr/local/bin` 补进 `PATH`，Main 和子代理执行命令时都能用到。

## 连接失败

| 情况                 | 处理                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| 401 / 403            | 核对 API Key、模型 ID 和账号的模型权限                                                                       |
| 404                  | 核对 API 地址和模型 ID，去掉地址末尾的 `/responses` 或 `/chat/completions`                                   |
| 不支持接口格式或参数 | 换成服务支持的接口格式；关掉服务不支持的图片、推理或缓存参数                                                 |
| 改了配置文件还是旧值 | 检查 `FORMICAND_API_BASE`、`FORMICAND_MODEL`、`FORMICAND_API_KEY`、`FORMICAND_MODEL_API`，环境变量优先于文件 |

改完再检查一次：App 在供应商详情点“检查”，CLI 运行 `formicand doctor --test-connection`。

实现见 [配置读取](../src/runtime/config.ts)、[运行设置](../src/runtime/runtime-settings.ts) 和 [连接参数](../src/runtime/model-profile.ts)。
