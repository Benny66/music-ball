# 暮光观感原型：双光位

状态：原型已出片，待 A/B 选择（2026-10-29）

**Blocked by**: 无（视觉 spike；不阻塞上一轮的默认玻璃珠）

## 目标

在不改运动/同步/音频/UI 的前提下，把近黑底 + 硬霓虹的舞台改成「冷玻璃 + 暖光」的抽象暮光；先做可切换原型，旧观感保持默认。

## 已实现

- `VisualLook = classic | dusk-top | dusk-horizon`；`?look=` / CLI `--look=` 切换，默认 `classic`。
- `assets.ts`：暮蓝→深青渐变、冷底光、暖光区、柔化 vignette；顶光/低地平线两个光位。
- `atmosphere.ts`：两层薄雾 + 22 颗确定性浮尘；预烘焙 glow 贴图，不用 filter/shadowBlur。
- `bead.ts` / `draw.ts`：暮光下网格降到 22%，撞击环改暖白、更慢更淡、闪光降强度；球/板/玻璃材质不变。
- `main.ts` / `render-video.mts`：预览、导出、CLI 共用同一 look；预览 60fps 实测 p95 17.5ms / max 17.9ms。

## 对比物（不入库）

- `out/looktest/real-note-classic.mp4`（旧）
- `out/looktest/real-note-dusk-top.mp4`（顶光）
- `out/looktest/real-note-dusk-horizon.mp4`（低地平线暖光）
- `out/looktest/steady-bead-dusk-top.png` / `steady-bead-dusk-horizon.png`（网格玻璃珠关键帧）

## 待办

- [ ] 用户从 top / horizon 中选一个（或要求调暖度/雾量/撞击柔度）。
- [ ] 选定后翻默认，更新 README/观感说明，跑原有 verify/typecheck/build 与全曲导出回归。
- [ ] 如果选 top/horizon 后仍觉得“不够解压”，下一刀再考虑镜头/冲击/音频，不在本 ticket 偷渡。

## 验收

- 旧观感 `classic` 与改动前一致（同帧对比）。
- 两个暮光变体都保留玻璃球的青/粉/金与左右滚动可读性；撞击仍精确对拍。
- 预览 60fps；Node 出片与浏览器导出同一 `drawScene`/assets，不出现浏览器/Node 分叉。
- 用户明确选一个后，才把它设为默认。
