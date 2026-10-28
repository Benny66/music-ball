# 测试资产与音符板数据契约

**Blocked by**: 无

**来源**: `docs/specs/2026-10-28-piano-note-sync.md`（US-06/US-08/US-12/US-13）

## 目标

准备好可复现的表达性钢琴 fixture 与真值，并让音符驱动的板把主导音高、力度带到图表层；现有鼓组画面逐项不变。

## 涉及层

- [ ] 数据层：新增表达性钢琴生成脚本与 `fixtures/piano-expressive.truth.json`（wav 仍被 `.gitignore` 忽略）；给 `Beat`、`Board`、内部 `Node` 增加可选 `midi` 与 `dyn`
- [ ] 逻辑层：`boardsFromNotes` 计算主导音高（和弦最高音）与原始 amplitude；`buildChart` 在合并/抽稀/长间隔细分/预卷过程中携带字段
- [ ] UI层：无
- [ ] 测试：字段存活断言；网格模式数值不变；现有 verify 5/5

## 验收标准

- 新 npm script 可重复生成 fixture wav 与 truth JSON；真值覆盖切分、装饰音/快速跑动、rubato、长音、休止、强弱段、上行/下行音阶、和弦。
- 传 `noteSource` 时，所有非 ghost 板都带 `midi` 与 `dyn`；网格驱动时两字段为 `undefined`。
- 合并、stride、长间隔细分、预卷之后字段不丢失；ghost/预卷不伪造音高与力度。
- 现有 5 个 verify 用例通过；同 seed 的网格 `Chart` 与改动前逐项一致。
