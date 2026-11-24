# 共用前端

`app.js` 装配页面状态和控制器；新行为优先进入 `assets/controllers/` 或 `assets/ui/` 的现有模块。Web 与 Electron 共用页面，浏览器模块不导入 Node。

- 控制器用明确端口/回调协作，不跨模块直接修改私有状态或复制请求逻辑。
- 异步操作捕获 Task、草稿和导航身份，晚返回不覆盖新的选择、草稿或会话。刷新复用焦点与滚动位置。
- 草稿与附件在关闭、重启和切换会话时保留；产物只读预览不写回文件。
- SSE 连接、重连、去重和清理由 connection controller 管理；不要另开一套事件通道。
- 产品 UI 只展示用户需要的信息，工程诊断放到日志/文档。文案与层级遵守[仓库界面设计要求](../AGENTS.md#界面设计)；颜色、图标、菜单、焦点、动效令牌和布局沿用 [UI 约定](../docs/development.md#应用-ui-约定)。列表悬浮默认只用轻背景，不抬升、不添加装饰阴影。

## 性能与动效

性能优先。任何动效和图标都先保证流畅，再在这个前提下做到同样精致好看；某个效果做不到流畅时，换一种实现达到同等观感，而不是降低观感或牺牲性能。

- 动画只改 `transform` 和 `opacity`。需要尺寸、位置或阴影变化时，用缩放、位移、裁剪或预先画好的伪元素淡入实现，不对宽高、边距、`top`/`left`、`box-shadow`、`filter` 做过渡。现有例外只有 `animateLayout` 在切换那一刻过渡网格列。
- 时长和缓动只用 `--motion-*`、`--ease-*` 令牌；过渡列出实际变化的属性，不写 `transition: all`。
- 动画不常驻：运行指示、加载动画只在可见且状态需要时播放，完成、隐藏或离开视口即停止。逐帧动画用 CSS、Web Animations 或 `requestAnimationFrame`，不用定时器逐帧改样式。
- `will-change` 只在动画开始前加、结束后移除，不写进常驻样式。新界面不使用 `backdrop-filter` 和大面积模糊。
- 尊重「减少动态效果」：脚本用 `reducedMotion()` 判断，CSS 在 `prefers-reduced-motion: reduce` 下去掉位移和缩放，只保留必要的透明度变化。
- 图标统一走 [icons.js](assets/ui/icons.js) 与 SVG sprite，不引入图标字体，不为几个图标加载整套图标库，不用位图做界面图标；品牌标识用单色 SVG 路径。远程图标（网页 favicon、MCP 服务图标）由后端获取并缓存，前端固定尺寸占位、按需加载，失败退回字母或默认图标，加载前后布局不跳动。
- 长列表分页、折叠或按可见区域渲染；流式和刷新更新复用已有 DOM（[reconcile.js](assets/ui/reconcile.js)），不整段重建 `innerHTML`。先批量读布局再批量写样式，不在循环里交替读写造成强制重排。
- 滚动、输入、缩放监听用 passive 并节流到每帧最多一次；轮询只在页面可见时进行（[visible-poll.js](assets/ui/visible-poll.js)）。
- 新增动效、长列表或高频更新，在 DevTools Performance 中确认没有长任务和布局抖动，CPU 4 倍降速下仍然顺畅。

验证可见行为使用对应 `e2e/*.spec.js`，补充 Node 的控制器/会话测试。详情见 [代码地图](../docs/code-map.md)，不要把只匹配 HTML 文本的断言当成操作验收。
