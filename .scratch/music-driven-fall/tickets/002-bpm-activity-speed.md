# BPM + 活跃度逐段速度

**Blocked by**: 001

**来源**: `docs/specs/2026-10-28-music-driven-fall.md`（US-01/02/04/06/07/08、测试 A/C）

## 目标

把 `buildChart` 的纵向速度从全局常量 V 改成逐段 V：BPM 定基准、谱通量 + 音符力度做段内加减速、EMA 平滑、上下限夹取；音符驱动和网格驱动都生效，`drama=0` 仍回到旧匀速。

## 涉及层

- [ ] 数据层：复用 `AnalysisResult.envelope` / `bpm` / board power；不新增 FFT
- [ ] 逻辑层：段循环里计算 `envP90`、`envAct`、`wBase`、`activity`、`rawV = speedFor(...)`、`v = EMA(0.55/0.45)`、`dy = v·dt`；倾角公式里的全局 `V` 改用本段 `v`；`bakeReflectionXs` 继续用 `seg.dy/dt`
- [ ] UI层：`index.html` 的“下落速度”改为“基础速度”；说明“变化幅度”同时控制速度跟随（不新增控件）
- [ ] 测试：新增速度断言或 `scripts/verify-speed.mts`；跑现有 `verify`、`verify:note`

## 验收标准

- `drama=0` 时所有段的 `dy/dt` 相等且等于基础速度；现有 `verify` 的 `h=Δy/3`、无倾角、无特殊板继续通过。
- 表达性钢琴 fixture 上，段 V 与该段活跃度的 Spearman ≥0.5；安静/稀疏段的 V 明显低于响/密集段。
- 60/120/180 BPM 假分析（同一 envelope/power）下，60 与 180 的 V 比值 ≥1.3（`drama=0.7`）。
- 所有 V 在 `[base·(1−0.55·drama), base·(1+0.9·drama)]` 内；相邻段 V 比值 ≤1.4（EMA 生效）。
- 音符 + 网格都覆盖：至少各一个 fixture 通过落点/g 自洽/NaN 检查。
- `verify` 5/5、`verify:note` 24/24；`typecheck` / `build` 通过。
- 浏览器演示：同一首表达性钢琴在密集段和安静段能看出滚动速度差异。
