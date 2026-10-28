# 手动音符驱动端到端

**Blocked by**: 001, 002

**来源**: `docs/specs/2026-10-28-piano-note-sync.md`（US-01/US-03/US-04/US-06/US-07）

## 目标

用户在纯钢琴曲上手动选择「音符驱动」后，图表立即重建，板落在音符起音上；密度控件被禁用并解释原因。

## 涉及层

- [ ] 数据层：`rebuild()` 在音符模式传 `noteSource`，且仅在来源为 `basic-pitch` 时传
- [ ] 逻辑层：修复 `applyAnalysis` 中「先 `rebuild` 后 `updateRhythm`」的顺序；手动切换走 002 的纯判定
- [ ] UI层：`#rhythm` change 立即生效；显示当前模式；音符模式禁用 `#density` 并给 title
- [ ] 测试：真值音符 → `buildChart` 事件对齐；切换/顺序单元测试；浏览器手动检查

## 验收标准

- 选择「音符驱动」后无需重新加载，`window.__musicball.rhythm` 变为 `notes`，板数/时间立即变化。
- 音符模式下 `#density` 禁用且有原因；切回网格后恢复。
- 在 fixture 的「简单段」（起音间隔 ≥125ms、无长休止）上：板到最近真值起音 median ≤10ms、p90 ≤30ms、100% ≤50ms；召回 ≥95%。
- 手动选「网格」立即回到网格；切「自动」重新判定。
- 现有 verify 5/5 通过。
