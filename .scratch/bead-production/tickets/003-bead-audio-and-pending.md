# 玻璃音轨与待应用旋律接入

**Blocked by**: 002

**来源**: `docs/specs/2026-10-28-bead-production.md`（US-06/07、接缝 4/7）

## 目标

玻璃音轨按当前场景的玻璃珠撞击点生成；切换运动/应用待应用旋律时缓存正确失效；原曲/玻璃/混合三模式行为不变。

## 涉及层

- [ ] 逻辑层：`src/audio/glass.ts` 增加 `notesFromBead(path)`：`t/midi/accent/panX/dt` 来自玻璃珠 board/相邻撞击。
- [ ] 逻辑层：`buildGlassNotes()` 在 `scene.motion==='bead'` 时走 `notesFromBead`，否则沿用 `notesFromChart`。
- [ ] 逻辑层：`rebuild()`/`applyMelodyChart()`/`invalidateGlass()` 与场景构建顺序一致；玻璃缓存随场景失效。
- [ ] UI层：待应用旋律在播放中仍只缓存；暂停/seek/播完应用时同时重建场景与玻璃轨。
- [ ] 测试：`notesFromBead` 的时间/音高/力度/声像；玻璃轨在 bead/classic 下不同且与撞击点一致；切换运动后缓存不返回旧轨。
- [ ] 测试：原曲/玻璃/混合三模式可播；玻璃音高仍跟旋律；不重做音色配方。
- [ ] 边界：不改 `glass-recipe`/`glass-node` 参数；不改默认原曲/手动切玻璃行为。

## 验收标准

- 玻璃珠模式下玻璃轨的每个音对应一次撞击；撞击数 = board 数（不含尾部占位）。
- 点击玻璃/混合模式，听到的敲击与画面撞击对齐；切换到经典后玻璃轨按经典板重新生成。
- 播放中应用待应用旋律：画面与音频同时切到新场景，不出现一段旧轨/新画错位。
- 三种音频模式、切歌、取消提取、暂停/seek 均无回归。
- `verify` / `verify:note` / `verify:speed` / `verify:bead` / typecheck 全绿。
