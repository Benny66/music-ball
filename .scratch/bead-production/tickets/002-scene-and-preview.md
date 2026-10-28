# 场景分派 + 音符驱动预览接入

**Blocked by**: 001

**来源**: `docs/specs/2026-10-28-bead-production.md`（US-01/02/03、接缝 2/3/7）

## 目标

音符驱动歌曲在浏览器预览中默认玻璃珠；网格/鼓组仍走经典 `draw`；两条路径共用 `drawScene`，经典画面不变。

## 涉及层

- [ ] 逻辑层：`src/chart/scene.ts`：`buildScene(analysis, { motion, notes, rhythmEffective, ...buildChartOpts })` 返回 `{ chart, bead, motion }`。
  - 音符驱动 + auto/bead → `bead = buildBeadChoreography(impactsFromNotes(notes, { minGap: 0.7 }), { duration: analysis.duration })`
  - 网格驱动 + auto → classic；网格 + bead 请求 → classic + reason
  - 音符驱动 + classic → classic
- [ ] 渲染层：`SceneScratch { classic: Scratch; bead: BeadScratch }` + `drawScene(ctx, scene, t, view, assets, scratch)`；玻璃珠/经典分派。
- [ ] UI层：`src/main.ts` 的 `renderNow()` 改走 `drawScene`；`rebuild()` 构建 `scene`；保留 `chart` 引用给现有统计/音频。
- [ ] 测试：场景选择单测；音符驱动真实钢琴预览为玻璃珠；网格歌曲预览与改动前 framemd5 一致（经典回归）。
- [ ] 测试：`verify` / `verify:note` / `verify:speed` / `verify:bead` 全绿。
- [ ] 边界：本切片不做运动选择 UI、不做音频/导出改造；网格玻璃珠返回 classic 并带提示文案。

## 验收标准

- 加载 `fixtures/real/006.夜的钢琴曲5 - 文武贝.mp3` 片段/全曲，预览撞击严格落在音符起音，左右交替，滚动/掉落/58% 与原型一致。
- 网格歌曲（steady-120 / 鼓组）预览与改动前逐帧一致（同 seed/参数 framemd5）。
- 音符驱动下 `scene.bead != null`、`scene.motion==='bead'`；网格下 `bead==null`、`motion==='classic'`。
- seek 到任意时刻画面由 `(scene,t)` 唯一决定；无逐帧状态。
- 现有四套 verify 与 typecheck 全绿；不改音频/导出。
