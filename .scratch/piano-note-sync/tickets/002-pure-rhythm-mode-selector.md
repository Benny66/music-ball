# 纯模式判定与旋律来源

**Blocked by**: 无

**来源**: `docs/specs/2026-10-28-piano-note-sync.md`（US-01/US-03/US-05、测试接缝 1）

## 目标

把 `updateRhythm()` 的判定从 UI 中抽出为纯函数，并保留 basic-pitch / FFT 来源；本切片不改变现有自动行为。

## 涉及层

- [ ] 数据层：`main` 保留完整 `MelodyResult`（含 `source`），不再只存 notes
- [ ] 逻辑层：新增 `selectRhythmMode(analysis, melodyResult, userChoice) -> { mode, reason }`；先复刻现有 `melody.length >= 40 && kickRatio < 0.45`
- [ ] UI层：无可见变化，只替换调用点
- [ ] 测试：手动选择优先；auto 各分支；reason 文案稳定；现有 verify 不变

## 验收标准

- 纯函数可在 Node 中直接测试，不依赖 DOM。
- 用户选 notes/grid 时返回该模式；选 auto 时与旧 `updateRhythm` 在相同输入上结果一致。
- `MelodyResult.source` 在异步提取完成后仍可读；现有 `melody` notes 使用方行为不变。
- 现有 verify 5/5 通过。
