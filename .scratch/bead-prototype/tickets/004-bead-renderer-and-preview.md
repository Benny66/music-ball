# 玻璃珠渲染器与 8 秒预览片

**Blocked by**: 003

**来源**: `docs/specs/2026-10-28-bead-prototype.md`（US-07/08/10、测试决策 3/5、测试 B）

## 目标

在 Node 里用 `drawBead` 渲染新运动：玻璃球、倾斜玻璃板、板从侧边滑入、慢跟随相机、撞击闪光/拖尾；输出 8 秒预览 mp4，能直接看出「掉落 → 撞板 → 沿板滚 → 掉边 → 撞对侧」。

## 涉及层

- [ ] 逻辑层：`spike/bead/draw.ts`
  - `drawBead(ctx, path, t, view, assets)`
  - 复用 `src/render/assets.ts` 的 `bg/vignette/glow/glassBall/glassBar`
  - 相机来自 `evalBeadCamera`，球屏幕 y = `58% + (ball.y − camY)·scale`
  - 板按入场偏移/倾角/宽厚绘制；撞击 flash、ring、拖尾全部由 t 决定
  - 背景只做静态网格/中线，不接入旧 `drawGrid`/弦线相机
- [ ] 脚本：`scripts/render-bead.mts` 增加 `--variant=new --seconds=8`，复用 001 的 ffmpeg 管道；音轨用 `out/bead/clip.wav`；输出 `out/bead/bead-new-preview.mp4`
- [ ] 测试：脚本级断言 + 截图
  - 每帧球坐标有限；撞击帧球屏幕 y 与 58% 误差 <0.5px
  - 板在 `entryEnd` 前不处于最终位置，之后不再移动
  - 无 NaN/空白帧
- [ ] 文档：在脚本注释里记录可调参数（outerX/innerX/slideFrac/entry/fall drop）
- [ ] 边界：不改 `src/render/draw.ts`、`src/main.ts`；旧运动不接入

## 验收标准

- 8 秒预览至少 5 次撞击；肉眼可见球从上方落到板、沿板滚向中心、掉边后落到另一侧板；左右严格交替。
- 球内深色内含物随滚动角转动；不是“球心平移、纹理不动”的滑过。
- 撞击帧球精确在屏幕 58%（脚本断言）；段内球明显低于 58% 线，能看出坠落，不是被钉住。
- 板在撞击前已从对应侧滑入并静止；撞击时板不再移动。
- 球/板有玻璃质感（高光、边缘亮、辉光），撞击有闪光/拖尾；背景不出现旧弦线运动。
- ffprobe：1080×1920、60fps、时长 8.0±0.1 秒、H.264；同一输入重复渲染视频流 framemd5 一致。
- `npm run typecheck`、`npm run verify:bead`、现有三套 verify 全绿；生产默认未改。
