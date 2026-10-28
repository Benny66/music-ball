# 速度信号接缝

**Blocked by**: 无

**来源**: `docs/specs/2026-10-28-music-driven-fall.md`（接缝 1/2、测试 A）

## 目标

把「活跃度采样」和「本段 V」抽成纯函数并测好，视觉暂不变；后续切片只接线，不再在 `buildChart` 里现写公式。

## 涉及层

- [ ] 逻辑层：新增 `src/chart/speed.ts`（或同文件纯函数）：
  - `envelopeP90(analysis) -> number`：全曲包络 p90；空包络返回 1
  - `activityAt(analysis, t0, t1, p90) -> number`：取段落后 75% 的包络均值 / p90，clamp 0..1；空包络 0.5
  - `speedFor(baseV, bpm, activity, dt, drama) -> number`：BPM 因子 + 活跃度因子 + 上下限夹取；本切片**不加**长段落因子（留给 003）
- [ ] UI层：无
- [ ] 测试：纯函数单测；`drama=0` 时 `speedFor` 恒等于 `baseV`

## 验收标准

- `envelopeP90` / `activityAt` 对空包络、全零包络、正常包络都有确定结果；段落后 75% 窗口边界正确。
- 同一输入下 `speedFor` 确定；`drama=0` 恒等于基础速度；activity 越高 V 越大；BPM 60/120/180 单调。
- `speedFor` 结果始终在 `[base·(1−0.55·drama), base·(1+0.9·drama)]` 内。
- 现有 `verify` 5/5、`verify:note` 24/24；本切片不改变任何 Chart 输出。
- `typecheck` 通过。
