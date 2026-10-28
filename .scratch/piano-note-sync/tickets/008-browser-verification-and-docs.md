# 浏览器自检、真实曲验收与文档

**Blocked by**: 004, 005, 006, 007

**来源**: `docs/specs/2026-10-28-piano-note-sync.md`（测试决策 E/F、完成定义）

## 目标

用真实 basic-pitch 路径验证合成钢琴 fixture，完成真实钢琴视觉验收，并把音符驱动的范围与 CLI 限制写进文档。

## 涉及层

- [ ] 数据层：暴露只读调试指标（analysis / melodyResult / chart 统计）
- [ ] 逻辑层：无；发现问题回到对应切片修
- [ ] UI层：自检入口不进入生产 UI；真实曲视觉确认
- [ ] 测试：浏览器自检记录；真实曲人工验收；README/CONTEXT/ADR 一致性

## 验收标准

- 在 headless/可复现浏览器中上传表达性钢琴 fixture，basic-pitch 音符起音相对真值 median ≤10ms、p90 ≤30ms；图表板时间符合 003/004 阈值。
- `window.__musicball` 能读到当前模式、旋律来源、分析结果与图表统计，供自检使用。
- 用户提供的真实钢琴曲（本地 `fixtures/real/`，不入库）视觉确认：撞击落在起音上、上行向右/下行向左、强弱有高度差、长音/休止无假撞击。
- README 写明：音符驱动仅浏览器、仅承诺纯钢琴独奏、CLI 仍网格、如何生成与运行新 fixture/verify。
- `npm run typecheck` / `npm run build` / `npm run verify` 全部通过；CONTEXT.md 与 ADR 和实现一致。
