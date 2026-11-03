# 预览静态舞台层（性能）

状态：完成（2026-10-29），待用户实机确认

**Blocked by**: 003（轻量预览）

## 目标

把预览里每帧重绘的背景/暗角移出动态画布：静态层只画一次，动态画布只画球/板/特效；导出仍走完整路径。

## 实现

- `index.html`：`.stage` 增加 `stage-backdrop` 与 `stage-vignette` 两个静态 canvas，动态 `#view` 夹在中间；空状态时静态层隐藏。
- `main.ts`：启动时把 `previewAssets.bg/vignette` 画进静态层；预览 `drawScene(..., backdrop=false)`，过渡画布也透明叠加。
- `drawBead` / `drawNaturalFrame` / `draw` / `drawScene` 增加 `backdrop` 参数（默认 true，导出/Node 不变）；关闭时先 `clearRect`。

## 证据

- 同一场景、720×1280：自然滚动每帧全屏填充 **1.98Mpx → 0.29Mpx（−85%）**；经典 **2.5Mpx → 0.47Mpx（−81%）**。
- 逐像素对比（背景+透明动态层+暗角 vs 原整帧）：平均差 0.35/255，差异集中在加法辉光边缘（最大值 30），screenshot 观感一致。
- 浏览器：空状态、提取中 540×960 轻量、音符升级、自然滚动、经典切换均正常；无控制台错误。
- 导出：Node 3s 片仍完整绘制背景/暗角。
- 回归：verify 5/5、note 26/26、bead 23/23、natural 7/7、scene 10/10、cache、typecheck、build。

## 已知差异

加法辉光在透明画布上合成后整体亮度有极小差异（平均 0.35/255）；如需完全一致，只能每帧把背景垫进动态画布，抵消本次收益。
