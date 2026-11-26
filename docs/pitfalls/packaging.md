# 发行包与技能文档

## 技能引用的指南迁出 docs 目录后在安装态被拒绝读取

- **Trigger:** 修改 `.pi/skills/` 内技能链接的参考文档路径，或把技能操作正文迁往仓库根目录的 `README.md` 等文件。
- **What happens:** 即使 `npm run check:docs` 通过且发行包包含根目录文档，已安装的 Agent 在外部项目工作时仍会被 `src/tools/private-data.ts` 的 `installRefusal` 拒绝读取 `.pi/skills/` 与 `docs/` 之外的安装目录文件，导致技能只能打开索引而读不到正文。
- **Confirm:** 对安装目录根目录的 `README.md` 调用 `dist/src/tools/private-data.js` 的 `installRefusal`（传入外部项目目录）会返回拒绝文本，而对 `docs/` 内的指南文件返回 `undefined`。
- **Avoid:** 技能直接或间接引用的操作指南正文须留在 `docs/` 下，并同步加入 `electron-builder.config.cjs` 与 `scripts/package-cli.mjs` 的打包清单；修改后运行 `test/shipped-guides.test.js` 与 `test/cli-packaging.test.js` 验证两种发行包和读取边界。
- **Sources:** 杂项（产品与配套说明整理），2026-11-26。
