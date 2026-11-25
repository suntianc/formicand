# 文档维护

文档导航见 [README](README.md)，写法约定见 [开发 · 文档约定](development.md#文档约定)。

- 每个事实只在一份文档里写，其他地方链接过去。
- 产品说明是根 [README](../README.zh-CN.md) 和 [英文 README](../README.md) 一对，同一改动同步两份；开发与测试标准只写中文，英文入口 [AGENTS.en.md](../AGENTS.en.md) 指向它们。过程记录只写中文。
- 改了命令、配置、路径或接口，同一改动更新文档；命令要和 `package.json`、脚本、CLI 帮助对得上。
- 不提交真实密钥、私有服务、个人配置和用户任务。
- 新增、移动或删除文档时更新根 [AGENTS](../AGENTS.md#文档) 的文档登记表；仍在生效且难逆的选择写成 [架构决定](adr/)，被取代的决定和删掉的文档记进 [架构决定历史](adr-history.md)，未结项记在开发记录里。
- 用相对链接；删除或移动文档时更新所有引用，再跑 `npm run check:docs`。
- [测试](testing.md) 附录的用例编号被发版执行器读取，改编号要同步 `test/release/catalog.json`。
