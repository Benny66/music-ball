# 力度映射

**Blocked by**: 004

**来源**: `docs/specs/2026-10-28-piano-note-sync.md`（US-08/US-12）

## 目标

音符力度/和弦规模驱动弹跳高度、板宽与撞击强度；强段与弱段在画面上有明确高度差。

## 涉及层

- [ ] 数据层：`dyn` 按曲目分位数归一化；音符模式 power 融合 amplitude、和弦规模、时值
- [ ] 逻辑层：`bounceRatio` / `boardHalfW` / `boardThick` / accent 使用音符 power；网格公式不变
- [ ] UI层：无新控件
- [ ] 测试：amplitude 与 h 的 Spearman ≥0.7；和弦规模与板宽单调；弱段/强段均值差异；网格快照不变

## 验收标准

- 在强弱交替 fixture 上，强段的平均弹跳高度与板宽显著高于弱段；同一和弦规模下，amplitude 越高 h 越大。
- 不出现 h 超上界、NaN 或板子互相穿插；`clampBounce` 仍生效。
- 网格驱动的 `Chart` 与改动前逐项一致。
- 现有 verify 5/5 通过。
