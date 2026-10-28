# 玻璃珠编排纯函数 + 几何图

**Blocked by**: 002

**来源**: `docs/specs/2026-10-28-bead-prototype.md`（US-01~06/09、测试决策 2/4、测试 A）

## 目标

把「音符 → 撞击点 → 滚动段 + 掉落段 + 板几何/入场 + 相机关键点」做成纯函数，输出可求值的 `BeadPath`；用一张几何诊断图验证左右交替、外侧高点、滑向中心、掉边落到下一侧，不接动画。

## 涉及层

- [ ] 逻辑层：`spike/bead/choreography.ts`
  - `impactsFromNotes(notes, opts)`：用现有 `boardsFromNotes` 得到 `t/power/midi`；从原始音符补 `dur`（同一起音窗口内最大时值）；严格 L/R 交替，首侧固定（默认左，可由 seed/参数复现）
  - `buildBeadChoreography(impacts, opts)`：
    - 每段 `slide`：外侧高点 → 内侧低点；`slideT` 原始范围 [0.45,0.75]s，且 ≤Δt−0.45s；随 power/dur 单调不减
    - 每段 `fall`：滚动终点 → 下一块板外侧高点；终点时刻严格等于下一 `impact.t`；重力抛物线反解，坐标有限
    - 板几何：外侧撞击点、内侧低点、倾角、半宽、厚度、颜色；音高只影响宽/厚/颜色与该段下落距离
    - 相机：撞击帧 `camY = impactY`；滚动段保持不动，掉落段相机用 smoothstep 先向下走，球从 58% 上方落入下一块板
    - 滚动：`evalBeadRoll(p,t)`；左板顺时针、右板逆时针，空中保持角速度
    - 板入场：在下落段从对应侧滑入，`entryEnd < impact.t`
  - `evalBead(path,t)` / `evalBeadCamera(path,t)`：按 t 求值，段外 clamp；无随机/当前时间
- [ ] 脚本：新增 `scripts/bead-plot.mts` 或给 `render-bead.mts` 加 `--geometry`，输出 `out/bead/geometry.png`：每块板、滚动/掉落折线、撞击帧球位置；仅诊断，不做玻璃质感
- [ ] 测试：新增 `scripts/verify-bead.mts` + `npm run verify:bead`，覆盖本 ticket 验收标准
- [ ] 边界：不修改 `src/chart`、`src/render`、`src/main.ts`；spike 只读现有类型/工具

## 验收标准

- 每个 `impact.t` 与输入音符/板时间严格相等（≤1e-6）；80+ 个撞击无累积漂移。
- 侧别序列严格 `-1,+1,-1,...`；同 seed/首侧重复构建完全一致（深比较）。
- 滚动起点 = 板外侧高点，终点 = 板内侧低点；固定 Δt 时 `slideT` 随 power、dur 单调不减；掉落段 = Δt−slideT ≥0.45s。
- 掉落起点 = 滚动终点，终点 = 下一块板外侧高点且时刻 = 下一 `impact.t`；y 单调不减、无 NaN、无穿板。
- 相机在 `impact.t` 处严格等于球 y（屏幕 58%）；滚动段相机 y 不变；掉落段相机单调向下、球中段在 58% 上方；相邻 1ms 采样无位置突跳。
- 滚动角连续：接触段转角 = 板面弧长/球半径，方向随侧别；空中保持离开板时的角速度。
- 板入场 `entryEnd < impact.t`；`t≥entryEnd` 后板在最终位置；左板从左、右板从右滑入；`entryStart ≥ 上一段滚动结束`（首块除外）。
- 音高：相同 power/Δt 下，midi 84 相比 48 的 `halfW`/`thick` 更大、颜色档位不同、该段下落距离更小；`side` 与 `impact.t` 不变。
- `out/bead/geometry.png` 能一眼看出之字形：撞击在两侧外端、滑向中心、掉到对侧。
- `npm run typecheck`、`npm run verify:bead` 全绿；现有 `verify`/`verify:note`/`verify:speed` 不回归。
