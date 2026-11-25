<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="docs/assets/readme-hero.png">
    <img src="docs/assets/readme-hero.gif" alt="Formicand：五节点标志、字标与桌面工作区" width="100%">
  </picture>
</p>

<p align="center">
  <a href="docs/README.md"><img src="docs/assets/badges/docs.svg" alt="文档"></a>
  <a href="LICENSE"><img src="docs/assets/badges/license.svg" alt="许可证：MIT；第三方例外见下文"></a>
</p>

<p align="center">
  <b>简体中文</b> | <a href="README.md">English</a>
</p>

**Formicand 是在你自己电脑上运行的多智能体工作台。**你和 Main Agent 对话，它负责计划、分派和验收，具体工作交给在独立进程里运行的子代理。项目、会话记录和配置都留在本机，模型服务用你自己的。

- **分派与协作**：Main 拆分任务、分派给子代理并检查结果；子代理可以向 Main 提问，也可以互相发消息。退出或重启后，任务从原来的地方接着做。
- **软件开发交付**：内置需求台账和看板。需求拆成票，在独立的 Git 工作区里开发，经过独立审查和返修后合入。
- **记忆与上下文**：Main 记录用户级和项目级的约定，长会话自动压缩后接着做；记忆可在“设置 → 记忆”查看和修改。
- **工具**：命令行、文件、联网搜索、MCP、自定义 Agent 与技能；macOS 上还能操作桌面应用和浏览器。
- **三个入口**：Mac App、网页界面和终端命令 `formicand`，共用 `~/.formicand/` 中的同一份数据。

## 从源码运行

需要 Node.js ≥22.19.0；Mac App 需要 macOS 14+、Apple Silicon。

```sh
git clone https://github.com/suntianc/formicand.git
cd formicand
npm ci
npm run desktop   # Mac App（开发模式）
npm run ui        # 网页界面
npm run cli       # 终端
```

首次打开后在“设置 → 模型”添加模型服务，步骤见 [上手](docs/getting-started.md#mac-app)。

## 文档

| 文档                                   | 内容                                    |
| -------------------------------------- | --------------------------------------- |
| [上手](docs/getting-started.md)        | 安装、连接模型、第一个任务、更新和排错  |
| [配置](docs/configuration.md)          | 模型、Agent、密钥、搜索、代理和项目数据 |
| [内置能力](docs/capabilities.md)       | 看图、浏览器、本机窗口和 CUA 脚本       |
| [架构与代码地图](docs/architecture.md) | 进程、数据布局、接口和“要改什么去哪找”  |
| [开发](docs/development.md)            | 环境、检查命令、合并和发布              |
| [测试](docs/testing.md)                | 怎么跑测试、发版验收                    |
| [贡献指南](CONTRIBUTING.md)            | 提交流程和验证要求                      |

问题和建议请提交到 [Issues](https://github.com/suntianc/formicand/issues)。

## 致谢与许可

本项目最初 fork 自 [RUC-NLPIR/CoworkOS](https://github.com/RUC-NLPIR/CoworkOS)，之后做了大幅改造。感谢原 CoworkOS 的贡献者。

自有代码采用 [MIT](LICENSE) 许可，第三方例外见 [第三方软件说明](THIRD_PARTY_NOTICES.md)。
