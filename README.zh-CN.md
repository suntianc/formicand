<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="docs/assets/readme-hero.png">
    <img src="docs/assets/readme-hero.gif" alt="Formicand：几何字标、固定 OS 选框与代码绘制的桌面工作区" width="100%">
  </picture>
</p>

<p align="center">
  <a href="docs/README.md"><img src="docs/assets/badges/docs.svg" alt="文档"></a>
  <a href="LICENSE"><img src="docs/assets/badges/license.svg" alt="许可证：MIT；第三方例外见下文"></a>
</p>

<p align="center">
  <b>简体中文</b> | <a href="README.md">English</a>
</p>

**Formicand 是一个在本机运行的个人 Agent 客户端。**它保留 Main Agent、Coordinator Runtime、Subagent、持久任务与恢复，项目工作区、执行记录和可配置的模型服务都留在本机。

- **委派工作。** Main Agent 负责计划、委派和评估；Coordinator Runtime 分发子任务并跟踪生命周期；Subagent 以独立进程执行限定范围的任务。
- **开发交付。** 第一类内置工作是软件开发：需求台账与看板、拆票、独立审查、返修与合入。
- **记忆与上下文。** Main 用 `memory` 工具写用户级和项目级记忆，长会话压缩后可以接着做；设置页「记忆」可查看、修改和删除。
- **工具。** CLI、文件、搜索、MCP、自定义 Agent 与技能，以及 macOS 上的 Computer Use。

保留与移除的能力见[能力范围与迁移](docs/builtin-capabilities.md)。

## 从源码运行

需要 Node.js ≥22.19.0。

```sh
npm ci
npm run build
npm run ui
# Desktop: npm run desktop
# CLI: npm run cli
```

## 文档与贡献

| 文档                                                    | 说明                                |
| ------------------------------------------------------- | ----------------------------------- |
| [使用指南](docs/README.md)                              | 安装、配置模型并了解工作流          |
| [模型设置](docs/configuration.md)                       | 配置服务地址、模型 ID 和连接格式    |
| [更新与排错](docs/installation-reference.md)            | 更新、备份、恢复和安装问题排查      |
| [开发指南](docs/development.md)                         | 构建 Web/Desktop/CLI 并运行本地检查 |
| [贡献指南](CONTRIBUTING.md)                             | 贡献流程和验证要求                  |
| [反馈问题](https://github.com/suntianc/formicand/issues) | 报告问题或提出改进建议              |

## 致谢与许可

本项目最初 fork 自 [RUC-NLPIR/CoworkOS](https://github.com/RUC-NLPIR/CoworkOS)，之后做了大幅改造。感谢原 CoworkOS 的贡献者。

本项目自有代码采用 [MIT](LICENSE) 许可，第三方例外见[第三方软件说明](THIRD_PARTY_NOTICES.md)。
