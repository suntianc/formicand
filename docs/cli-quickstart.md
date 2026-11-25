# CLI 快速开始

简体中文 | [English](en/cli-quickstart.md)

macOS / Linux · Node.js >=22.19.0 · npm · Git

## 从源码安装

需要 [Node.js ≥22.19.0](https://nodejs.org/en/download)（含 npm）和 Git。在终端运行：

```sh
git clone https://github.com/suntianc/CoworkOS.git
cd CoworkOS
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build:cli
npm link
coworkos --version
```

最后一条命令应输出 `CoworkOS` 和版本号。之后在这个检出里运行 `coworkos update` 跟随上游分支更新，见 [开发指南](development.md#更新源码检出)。

## 连接模型

先建立测试文件夹并进入。CLI 会在启动时所在的文件夹读写项目文件；安装目录不必放在项目里。

```sh
mkdir -p "$HOME/coworkos-quickstart"
cd "$HOME/coworkos-quickstart"
coworkos init
```

按顺序填写服务商提供的 API 地址、模型 ID 和 API Key。下面的地址和模型 ID 仅为占位示例，请填写自己的实际值；密钥输入时不显示字符。

```text
API 地址（根地址或 /v1）: https://your-service.example/v1
模型 ID: YOUR_MODEL_ID
API Key（输入隐藏）:
```

保存成功会显示 `连接配置已保存：` 和文件路径，默认是 `~/.atria/config.json`。若提示“配置已存在，未覆盖”，先按[安装排错](installation-reference.md#常见问题)检查已有连接。

新连接默认使用 Responses。服务需要支持流式响应和工具调用；如果服务只支持 Chat Completions，在同一个终端先运行：

```sh
export COWORK_MODEL_API=openai-completions
```

此设置只对当前终端及其启动的 CLI 生效。要让以后打开的终端也使用该格式，按 [CLI 配置文件与环境变量](configuration.md#cli-配置文件与环境变量)保存配置。

接着测试连接；这一步会请求模型并消耗额度。

```sh
coworkos doctor --test-connection
```

所有检查通过后继续。模型连接成功时会出现：

```text
OK  流式模型连接与工具调用
```

若出现 `FAIL`，先根据同一行的错误按[安装排错](installation-reference.md#常见问题)处理，再运行同一条测试命令。

## 完成第一个任务

仍在 `~/coworkos-quickstart` 的终端中启动：

```sh
coworkos
```

出现交互界面后，在输入区填写下面的请求，按 Enter 发送：

> 在当前项目中创建 hello.txt，写入“你好，CoworkOS。”，然后读取文件并确认内容。

运行中可按 `Esc` 中断当前回复。等任务完成并显示回复后，清空输入区，按 `Ctrl+D` 退出。回到终端命令提示符后运行：

```sh
cat hello.txt
```

应看到：

```text
你好，CoworkOS。
```

文件位于 `~/coworkos-quickstart/hello.txt`。

## 继续使用

以后打开终端，在同一项目目录继续最近的会话：

```sh
cd "$HOME/coworkos-quickstart"
coworkos --continue
```

要从历史会话中选择，运行 `coworkos --resume`。直接运行 `coworkos` 会开始新对话。

[更新与排错](installation-reference.md) · [源码安装](development.md#准备环境)
