# 玻璃珠核心生产化（prefactoring）

**Blocked by**: 无

**来源**: `docs/specs/2026-10-28-bead-production.md`（接缝 1/3、测试纯函数）

## 目标

把已验收的 `spike/bead/choreography.ts` 与 `spike/bead/draw.ts` 移入 `src/chart/bead.ts`、`src/render/bead.ts`，生产代码不再依赖 spike；行为与原型逐字节一致。

## 涉及层

- [ ] 逻辑层：`src/chart/bead.ts`：搬移纯函数与类型；参数默认值保持 `minGap=0.7`、滚动 0.45–0.75s、最短掉落 0.45s。
- [ ] 逻辑层：`src/render/bead.ts`：搬移 `drawBead`、`beadScreen`、`createBeadScratch`；复用 `src/render/assets.ts`。
- [ ] 逻辑层：`spike/bead/*` 改为 re-export 或删除；生产 `src` 不 import `spike`。
- [ ] 测试：`scripts/verify-bead.mts` 改从 `src/chart/bead.ts` 导入；现有 17 条断言全绿。
- [ ] 测试：同一 notes/参数下，搬移前后 `BeadPath` 深比较一致（可用临时脚本/固定 JSON 哈希）。
- [ ] 边界：不改 `main.ts`、`buildChart`、`draw`、音频、导出；不改变任何用户可见行为。

## 验收标准

- `npm run typecheck`、`npm run verify:bead` 全绿；生产 `src` 无 `spike/` import。
- 同一输入构建的 `BeadPath` 与搬移前一致（至少 impact 时间、side、slide/fall 端点、camera 采样、roll 角度）。
- 原型渲染脚本仍可用；旧经典运动未改。
- 不触碰工作区 MDF/音频/Worker 三组未提交改动。
