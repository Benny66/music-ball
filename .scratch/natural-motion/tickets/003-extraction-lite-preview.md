# 提取期间轻量预览（性能）

状态：完成（2026-10-29），待用户实机确认

**Blocked by**: 无（性能修复，不改运动/选点）

## 背景

用户反馈音符提取期间浏览器预览很卡，声音正常。本机 Chrome（GPU）实测提取全程帧间隔 p50/p90 均为 16.7ms、无长任务，复现不出；按“画面掉帧、声音正常”判定为 GPU/画面合成与推理争用。

## 共识

提取期间**固定**轻量预览，不做掉帧检测：
- 内部分辨率 720×1280 → 540×960（0.56× 像素）。
- 跳过尾迹、板外辉光；保留球、板体、撞击环/闪光。
- 提取完成/取消/失败立即恢复全量；导出与音频不受影响。
- UI 状态行标注“预览降级中”，结束后清除。

## 实现

- `drawScene(..., quality?: 'full' | 'lite')`；`drawBead` / `drawNaturalFrame` / `draw` 接收 `lite`。
- `main.ts`：`syncPreviewQuality()` 按 `melodyHandle` 切换 canvas 尺寸与 lite 资产；开始/完成/取消/失败/加载重置都同步。
- 轻量资产单独 `createAssets(makeCanvas, liteView)`；预览、导出、升级过渡仍用全量路径。

## 证据

- 同一网格场景 A/B（Chrome + GPU，piano-90）：
  - lite：540×960，drawImage 7 次/帧（p50），drawMs p90 0.2ms。
  - full：720×1280，drawImage 34 次/帧（p50），drawMs p90 0.1ms。
- 浏览器：提取中 `previewLite=true`/540×960；完成后恢复 720×1280 且 `motion=natural`；取消后恢复全量；无控制台错误。
- 回归：verify 5/5、note 26/26、bead 23/23、natural 7/7、scene 10/10、cache、typecheck、build。
- 截图：`out/lite-preview.png`（轻量）、`out/full-preview.png`（全量）。

## 待用户确认

实机（你的浏览器/机器）提取期间是否明显变顺。如果仍卡，下一步考虑限制推理占空比或改用 CPU 后端。
