# 导出与 Node 出片接入场景

**Blocked by**: 002, 003

**来源**: `docs/specs/2026-10-28-bead-production.md`（US-08、接缝 5/6）

## 目标

浏览器 WebCodecs 导出与 Node `render-video` 使用与预览相同的 `drawScene`；玻璃珠/经典两条路径都能出片，同一场景逐帧一致。

## 涉及层

- [ ] 逻辑层：`src/export/mp4.ts` 的 `ExportOptions` 从 `chart/scratch` 改为 `scene/sceneScratch`；逐帧 `drawScene`。
- [ ] 逻辑层：`src/main.ts` 导出调用传入当前场景与 scratch；导出期间场景/音频冻结。
- [ ] 脚本：`scripts/render-video.mts` 支持 `--motion=bead|classic` 与 `--notes=<json>`；无音符输入默认 classic。
- [ ] 脚本：`scripts/render-bead.mts` 改为复用生产场景/渲染器，不再维护第二套 draw。
- [ ] 测试：浏览器导出与 Node 出片同场景 framemd5 一致；两种运动各一条；撞击帧 58%（bead）。
- [ ] 测试：导出取消、进度、音频 AAC、分辨率/帧率不回归。
- [ ] 边界：不改导出编码参数/音频延迟校准；不重写 mediabunny 流程。

## 验收标准

- 音符驱动真实钢琴：浏览器导出与 Node 出片均为玻璃珠，1080×1920/60fps，帧内容一致（视频流 framemd5）。
- 网格歌曲：默认导出仍为经典画面，与改动前一致。
- `--motion=classic` 可对音符驱动歌曲导出经典回退。
- 导出取消可用；无长任务阻塞主线程；音频/画面同步不回归。
- typecheck、build、四套 verify 全绿。
