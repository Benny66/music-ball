# 玻璃珠 UI：运动选择、文案与控件

状态：已完成（2026-10-29）

**Blocked by**: 001

**来源**: `docs/specs/2026-10-29-default-bead-and-fast-melody.md`（US-16、US-19、US-15）、`docs/adr/0006-bead-default-all-rhythms.md`

## 目标

界面与场景一致：运动默认「自动（玻璃珠）」，音符/拍点原因可见；只在经典模式下启用经典运动相关控件，避免「拖了没反应」。

## 涉及层

- [ ] UI：`index.html` 的运动 `auto` 标签改为「自动（玻璃珠）」；删除「网格/鼓组暂用经典运动」的静态说明；保留 glass / mix / original 音轨选项。
- [ ] UI：`src/main.ts` 的 `updateMotionUi` 改为看 `scene.bead` 是否存在（不再要求 `noteDriven`）；`bead` 选项在有撞点时可选；`scene.reason` 展示「音符玻璃珠 N 次撞击 / 拍点玻璃珠 N 次撞击 / 经典（原因）」。
- [ ] UI：玻璃珠模式下，把只影响经典运动的控件（速度、密度/stride、物理自由度 seed/drama）置灰并加「仅经典运动」title/说明；切回经典恢复原值。
- [ ] UI：`rhythmNote` 不再出现「网格/鼓组暂用经典」；切换节奏来源 auto/notes/grid 时保持玻璃珠，手动 classic 时保持经典。
- [ ] 测试：playwright 截图/断言矩阵——网格歌 auto/bead/classic、音符歌 auto/bead/classic、无拍点回退经典；检查控件 disabled 状态与文案。

## 验收标准

- 网格歌与音符歌的 `运动=自动` 都显示玻璃珠；`bead` 选项不再因网格驱动被禁用；无撞点/经典回退时给出明确原因。
- 玻璃珠模式：速度/密度/自由度/seed/drama 置灰且有说明；经典模式全部恢复可用，值不被重置。
- 切换节奏来源 auto→notes→grid 不把运动强制切回经典；手动选 classic 后保持经典。
- 页面无「暂用经典」「网格/鼓组保留经典」等与实现不符的文案；console 无错误。
- `typecheck` / `build` / 现有 verify 全绿。

## 备注

- 运动选择的变化不改变音频、播放位置或 seek 行为。
- 若某些控件其实仍影响玻璃珠（例如音轨/on 时间微调），保留可用并单独标注，不要一刀切置灰。
