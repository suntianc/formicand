# 上手

简体中文 | [English](en/getting-started.md)

Formicand 有两个入口：Mac App 和终端里的 `formicand` 命令。两者共用同一套运行时和同一个数据目录 `~/.formicand/`。

## 准备

- Mac App：macOS 14 或更新版本，Apple Silicon。
- CLI：macOS 或 Linux。
- 两者都需要 [Node.js ≥22.19.0](https://nodejs.org/en/download)（含 npm）和 Git。

取得源码：

```sh
git clone https://github.com/suntianc/formicand.git
cd formicand
npm ci
```

只用 CLI 时，可以用 `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci` 跳过 Electron 下载。

## Mac App

两种运行方式：

| 方式     | 命令                   | 说明                                                                               |
| -------- | ---------------------- | ---------------------------------------------------------------------------------- |
| 开发模式 | `npm run desktop`      | 构建后直接从源码启动 `Formicand Dev`，改代码后重新运行即可                         |
| 安装包   | `npm run desktop:dist` | 在 `release/` 生成 `Formicand-<版本>-mac-arm64.dmg`，打开后把 App 拖到“应用程序”里 |

安装包尚未经过 Apple 公证。第一次打开被系统阻止时，按 [Apple 的说明](https://support.apple.com/zh-cn/102445) 到“系统设置 → 隐私与安全性”里允许打开。

### 连接模型

第一次打开会进入“设置 → 模型”，并弹出“添加供应商”：

1. 选一家预置的服务商，只需填 API Key。其他服务选“自定义”，填写 API 地址，再选接口格式：Chat Completions、Responses 或 Anthropic Messages。
2. 点“添加并获取模型”，勾选要用的模型后加入。服务商不提供模型列表时，用“手动添加”填写模型 ID。
3. 在供应商详情点“检查”，确认连接和工具调用可用。检查会消耗少量额度。

服务必须支持所选格式的流式响应和工具调用。更多选项见 [配置](configuration.md)。

### 第一个任务

1. 在 Finder 里新建一个空文件夹，例如 `formicand-quickstart`。
2. 在侧栏“项目”旁点 `+`，填写名称，选择这个文件夹。
3. 点项目标题旁的 `+` 新建对话，发送：

   > 在当前项目中创建 hello.txt，写入“你好，Formicand。”，然后读取文件并确认内容。

完成后，文件夹里应有 `hello.txt`，内容是 `你好，Formicand。`。

## CLI

在源码目录里构建并登记命令：

```sh
npm run build:cli
npm link
formicand --version
```

最后一条命令应输出 Formicand 和版本号。改了源码要重新运行 `npm run build:cli`。

### 连接模型

CLI 在启动时所在的文件夹里读写项目文件。先建一个测试文件夹，再配置模型：

```sh
mkdir -p "$HOME/formicand-quickstart"
cd "$HOME/formicand-quickstart"
formicand init
```

按提示依次填写 API 地址、模型 ID 和 API Key，密钥输入时不显示字符。保存后默认写在 `~/.formicand/config.json`。

`init` 建立的连接默认使用 Responses 格式。服务只支持 Chat Completions 时，在配置文件里加 `"api": "openai-completions"`，见 [配置文件](configuration.md#配置文件)。

测试连接（会请求模型、消耗额度）：

```sh
formicand doctor --test-connection
```

看到 `OK  流式模型连接与工具调用` 就可以开始用了。

### 第一个任务

```sh
formicand
```

在输入区发送和上面 App 一样的请求。运行中按 `Esc` 中断当前回复，清空输入区后按 `Ctrl+D` 退出。退出后运行 `cat hello.txt`，应看到 `你好，Formicand。`。

### 继续对话

| 命令                            | 作用                         |
| ------------------------------- | ---------------------------- |
| `formicand`                     | 开始新对话                   |
| `formicand --continue`          | 继续这个项目里最近的一次对话 |
| `formicand --resume`            | 从历史对话里选一个           |
| `formicand session export <ID>` | 把对话导出成 JSON 或 HTML    |

`formicand --help` 列出全部命令。

## 更新

源码检出：先退出正在运行的 App 和 CLI，再运行：

```sh
formicand update --check   # 只检查，不安装
formicand update
```

`update` 会从 Git 上游拉取并重新构建。App 用开发模式运行的，更新后重新 `npm run desktop`；用安装包的，重新打一个 DMG 覆盖安装，原来的数据不受影响。

## 数据与备份

| 内容                   | 位置                                          |
| ---------------------- | --------------------------------------------- |
| 配置、密钥、任务、会话 | `~/.formicand/`，可用 `FORMICAND_HOME` 改位置 |
| 项目文件               | 你选的项目文件夹，Formicand 直接在里面改      |

`formicand data paths` 显示实际路径。备份时把数据目录和项目文件夹一起备份；项目台账另有 `formicand data backup` 命令，见 [配置](configuration.md#项目数据)。不要靠删除数据目录来排错。

## 常见问题

| 现象                                 | 处理                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `node: command not found` 或版本过低 | 安装 Node.js 22.19.0 或更新版本，重新打开终端                                                                     |
| `formicand: command not found`       | 把 `$(npm prefix -g)/bin` 加进 `PATH`，重新打开终端                                                               |
| `npm link` 提示权限错误              | 运行 `npm config set prefix "$HOME/.local"` 后重试，再把 `$HOME/.local/bin` 加进 `PATH`；不要用 `sudo`            |
| `配置已存在，未覆盖`                 | `init` 不覆盖已有配置。运行 `formicand doctor` 看配置文件路径，直接改那个文件；或用 `formicand init --force`      |
| `FAIL 模型配置`                      | 按 `doctor` 打印的路径修正 JSON；还没有配置时运行 `formicand init`                                                |
| `FAIL 流式模型连接与工具调用`        | 核对地址、模型 ID、密钥和额度；只支持 Chat Completions 的服务要改 `api`，见 [连接失败](configuration.md#连接失败) |
| App 保存连接一直停在“保存中”         | 处理系统钥匙串的授权弹窗；已经拒绝的，再点一次保存                                                                |

反馈问题时请附上版本、系统、安装方式、复现步骤和去掉敏感信息的报错。不要发送 API Key 或完整配置文件。
