# 子代理执行环境

## 子代理内绕过测试入口直接运行测试导致角色变量泄漏

- **Trigger:** 在委派的 Executor 或 Reviewer 会话中绕过 `scripts/test.mjs`，直接运行 `node --test` 执行会加载 `.pi/extensions/formicand.ts` 的测试。
- **What happens:** 绕过 `scripts/test.mjs` 会跳过 `test/isolate-user-data.mjs`，子代理进程继承的 `FORMICAND_AGENT_ROLE` 等变量泄漏进测试，使扩展入口走入 `registerSubagentAgent` 并报 `Agent process is missing FORMICAND_SUBAGENT_CALL_ID` 或注册错角色工具。
- **Confirm:** 运行 `FORMICAND_AGENT_ROLE=reviewer node --test test/formicand-extension.test.js` 会报 `Agent process is missing FORMICAND_SUBAGENT_CALL_ID` 失败，改用 `FORMICAND_AGENT_ROLE=reviewer node scripts/test.mjs --skip-build --file test/formicand-extension.test.js` 则通过。
- **Avoid:** 在子代理中执行 Node 回归优先使用 `node scripts/test.mjs --skip-build --file <path>`（或 `npm run test:unit -- --file ...`）；确需直接调用 `node --test` 时必须附加 `--import ./test/isolate-user-data.mjs`。
- **Sources:** 杂项（产品与配套说明整理），2026-11-26。
