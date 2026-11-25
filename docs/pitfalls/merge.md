# 合入工作树

## 合入工作树缺少依赖导致检查失败

- **Trigger:** 在 `request_merge` 中省略 `mergeChecks`（复用开发工作树里已记录的检查），或未先安装依赖就直接运行 Node、TypeScript 与 Playwright 检查。
- **What happens:** 合入服务会在全新的 detached Git worktree 中构建组合版本并直接执行检查，其中不存在被 `.gitignore` 忽略的 `node_modules`，所有依赖本地包的构建和测试都会报 `MODULE_NOT_FOUND` 或找不到可执行文件。
- **Confirm:** 在刚创建的干净工作树中不执行 `npm ci` 直接运行 `npm run verify`，会因缺少 `node_modules/typescript/bin/tsc` 失败；先执行 `npm ci` 后该报错消失。
- **Avoid:** 调用 `request_merge` 时显式传入 `mergeChecks`，把 `npm ci` 作为首条命令放在构建与测试命令之前，让合入工作树先安装依赖再执行验证。
- **Sources:** 消息中的文件与链接渲染，2026-11-25。
