# 自动判定与模型失败回退

**Blocked by**: 003

**来源**: `docs/specs/2026-10-28-piano-note-sync.md`（US-01/US-02/US-03/US-05）

## 目标

纯钢琴自动进入音符驱动；稳定鼓组曲目保持网格；basic-pitch 不可用或音符不足时回退网格并给出可见提示；手动选择始终优先。

## 涉及层

- [ ] 数据层：必要时给 `AnalysisResult` 增加可选鼓组显著度指标；保留 `MelodyResult.source`
- [ ] 逻辑层：`selectRhythmMode` 新启发式（来源守卫 + 鼓组优先 + 音符密度）；阈值以 fixture 矩阵校准，不能只用 `kickRatio`
- [ ] UI层：显示模式与原因；回退提示；手动覆盖；旋律完成/失败后重新判定
- [ ] 测试：6 首流行 → grid；钢琴 → notes；fallback → grid+reason；短曲 → grid；手动覆盖

## 验收标准

- 6 首现有流行歌的分析结果自动选 `grid`，且图表与改动前一致。
- 表达性钢琴 fixture 自动选 `notes`，无需手动切换。
- `source === 'fft-fallback'` 或音符数/密度不足时，自动与手动都不进入音符驱动；界面出现「旋律模型不可用，已回退节拍驱动」类提示。
- 用户手动选 notes/grid 时，模式不被自动判定覆盖；切回 auto 后重新判定。
- 自动判定阈值有测试矩阵覆盖，不只靠单曲手测。
- 现有 verify 5/5 通过。
