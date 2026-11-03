# 自然滚动 + 表面节奏接入生产

状态：完成（2026-10-29），待用户全曲观感确认

**Blocked by**: 001（spike 用户已确认「好」）

## 目标

把 spike 的滚动玻璃珠接入生产默认：音符驱动歌用表面节奏选点 + 自然滚动；网格/鼓组保留拍点玻璃珠；预览、导出、播放中音符升级共用同一场景；经典运动保留手动回退。

## 实现

- `src/chart/salience.ts`：音符板起音候选，onset/力度/节拍位置/低音/音高变化打分；1/3、2/3 细分权重 0.75；O(K·N) DP（1.2 次/秒、最短 0.5s、1.8s 补洞）。
- `src/chart/natural.ts`：撞击 → 滚动/掉落烘焙；预置板、自由落点、低通镜头 54%；首板前镜头钉住；开场从上方落入；防重复/过短间隔。
- `src/render/natural.ts`：spike 渲染迁入生产，复用 classic 资产。
- `src/chart/scene.ts`：音符 → `motion='natural'`；网格 → `motion='bead'`；失败回退。
- `src/audio/glass.ts`：`notesFromNatural`；`src/main.ts` / `scripts/render-video.mts` 接线。
- 拍点修正：钢琴（`highRatio<0.09`）DP 规整惩罚 1.5 + 绕过全局锁相网格。

## 验收

- 真实钢琴全曲：206 次撞击，中位 0.560s，最大 1.686s；规律度 0.967；拍点全曲对 Essentia 中位 12ms / p90 29ms。
- 撞击 87% 落在音符板起音 80ms 内（中位 1ms）。
- 生产全曲：`out/prod-natural-full.mp4`（168.5s，1080×1920@60fps，50MB，玻璃音轨）。
- 无头浏览器：piano-90 加载后 `motion=natural`（83 次撞击），播放中音符升级成功，切经典/切回自动正常，无控制台错误；截图 `out/browser-natural.png`。
- 回归：verify 5/5、verify:note 26/26、verify:bead 23/23、verify:natural 7/7、verify:scene 10/10、verify:cache、typecheck、build 全过。

## 已知差异

- 150–160s 三连音段：Essentia 跟 0.36s 表面网格，自研跟音符起音；选点仍有 5 处不同，但都在真实音符上。
- 网格/鼓组仍是旧拍点玻璃珠几何（左右交替、板滑入），未迁移到自然几何；用户本轮目标是音符歌。
