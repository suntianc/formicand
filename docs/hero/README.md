# Formicand README 头图 / README hero

## 中文

用在 [README](../../README.md) 与 [README.zh-CN](../../README.zh-CN.md) 顶部，本页是它的构建说明。

独立的 React + SVG 头图工程，与产品同为黑白配色。左侧是产品的五节点标志，取自 [应用图标](../../web/assets/brand/app-icon.svg)；中间是用仓库 Inter 字体排的 `Formicand` 字标；右侧是按当前深色界面用代码重画的桌面窗口左上角，不含真实截图或用户数据。

动画每 6 秒循环一次：一道信号环从最大的节点出发，每 1.2 秒依次经过下一个节点，代表 Main 把工作分派给子代理。字标与窗口保持静止。

### 预览与导出

```sh
cd docs/hero
npm ci
npm run preview
```

预览地址为 `http://127.0.0.1:18742`。`?time=3.25` 固定动画时间，`?static=1` 显示静态场景；系统启用“减少动态效果”时默认静态。预览按钮可切换播放与静态。

首次导出需准备 Chromium 和 Pillow：

```sh
npx playwright-core install chromium
python3 -m pip install Pillow
```

```sh
npm run render
python3 encode.py ../../.tmp/readme-hero-frames
```

导出 **1440 × 480、6 秒、20 fps** 的循环 GIF 和同尺寸静态 PNG，更新 [readme-hero.gif](../assets/readme-hero.gif) 与 [readme-hero.png](../assets/readme-hero.png)，中英文 README 共用。渲染器直接采样 120 帧，编码器使用共享调色板并校验时长与循环；帧与检查用的 `contact.png` 保留在 `.tmp/readme-hero-frames/`。

### 编辑入口

- [scene.jsx](scene.jsx)：画布、标志、字标与窗口位置，播放时钟。
- [Mark.jsx](Mark.jsx)：五节点标志与信号环。
- [HarnessCorner.jsx](HarnessCorner.jsx)：窗口栏、侧栏与对话区的重画。
- [render.mjs](render.mjs)、[encode.py](encode.py)：逐帧导出、GIF 编码与循环校验。

预览构建输出到 `.tmp/readme-hero/`；依赖隔离在本目录，不接入产品运行时。

## English

Shown at the top of [README.md](../../README.md) and [README.zh-CN.md](../../README.zh-CN.md); this page explains how to build it.

A standalone React + SVG hero in the product's black and white. On the left is the five-node mark, taken from the [application icon](../../web/assets/brand/app-icon.svg); in the middle, the `Formicand` wordmark set in the repository's Inter font; on the right, the top-left corner of the desktop window redrawn in code from the current dark theme, with no screenshot or user data.

The animation loops every six seconds: a signal ring leaves the largest node and reaches the next node every 1.2 seconds, standing for Main handing work to subagents. The wordmark and window stay still.

### Preview and export

```sh
cd docs/hero
npm ci
npm run preview
```

Open `http://127.0.0.1:18742`. Use `?time=3.25` for a fixed frame or `?static=1` for the static scene. Reduced-motion preferences select the static scene by default; the preview button toggles playback.

Install Chromium and Pillow once:

```sh
npx playwright-core install chromium
python3 -m pip install Pillow
```

Then export:

```sh
npm run render
python3 encode.py ../../.tmp/readme-hero-frames
```

The output is a **1440 × 480, six-second, 20 fps** looping [GIF](../assets/readme-hero.gif) and a matching static [PNG](../assets/readme-hero.png), shared by both README languages. The renderer samples 120 frames; the encoder uses a shared palette and checks duration and looping. Frames and `contact.png` stay in `.tmp/readme-hero-frames/`.

Edit placement and timing in [scene.jsx](scene.jsx), the mark and signal rings in [Mark.jsx](Mark.jsx), and the window drawing in [HarnessCorner.jsx](HarnessCorner.jsx). Preview output stays in `.tmp/readme-hero/`, with no product runtime dependency.
