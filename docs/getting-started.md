# Mac App 快速开始

简体中文 | [English](en/getting-started.md)

<a id="安装与首次使用"></a>

macOS 14+ · Apple Silicon

<a id="mac-app"></a>
<a id="安装前准备"></a>

## 安装

在源码检出中运行 `npm ci` 和 `npm run desktop:dist`，在 `release/` 得到 `Formicand-<version>-mac-arm64.dmg`；打开后把 App 拖到“应用程序”。也可以用 `npm run desktop` 直接以开发模式运行，见 [开发指南](development.md#准备环境)。首次打开若被 macOS 阻止，按 [Apple 安装说明](https://support.apple.com/zh-cn/102445)，在“系统设置 → 隐私与安全性”中允许打开。

App 没有应用内更新，新版本用本地 DMG 手动升级。先备份数据和外部项目，结束任务并停止独立后端，再退出 App；保留旧 App，将新包拖入安装目录，启动后核对数据。步骤见 [安装与升级](installation-reference.md#更新)。当前安装包尚未通过 Apple 公证。

## 连接模型

首次打开 App 会进入“设置 → 模型”并弹出“添加供应商”。选择你的服务商（预置的只需填 API Key），或选“自定义”填写 API 地址并选择接口格式（Chat Completions、Responses 或 Anthropic Messages）。点击“添加并获取模型”，勾选要用的模型后加入。服务需要支持所选格式的流式响应和工具调用。

在供应商详情点击“检查”确认连接可用，检查会消耗少量额度。更多选项见 [模型设置](configuration.md)。

## 创建项目

先在 Finder 的“文稿”中新建一个空文件夹，命名为 `formicand-quickstart`。

在 Formicand 侧栏“项目”旁点击 `+`，填写项目名称并选择这个文件夹。然后点击项目标题旁的 `+`，打开新对话。

## 完成第一个任务

发送：

> 在当前项目中创建 hello.txt，写入“你好，Formicand。”，然后读取文件并确认内容。

任务结束后，在 Finder 打开刚才选择的 `formicand-quickstart` 文件夹。里面应有 `hello.txt`，打开后应看到 `你好，Formicand。`。

<a id="cli-安装包"></a>

<a id="从源码运行-cli"></a>

<a id="更新"></a>
<a id="数据退出与升级"></a>
<a id="常见问题"></a>

[CLI](cli-quickstart.md) · [源码安装](development.md#准备环境) · [更新与排错](installation-reference.md)
