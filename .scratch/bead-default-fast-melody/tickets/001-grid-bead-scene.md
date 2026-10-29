# 拍点玻璃珠：纯逻辑与场景

状态：已完成（2026-10-29）

**Blocked by**: 无

**来源**: `docs/specs/2026-10-29-default-bead-and-fast-melody.md`（US-01–05、US-15–18）、`docs/adr/0006-bead-default-all-rhythms.md`

## 目标

鼓组/流行歌加载后，首个可渲染帧就是玻璃珠；撞击来自约 1s 抽稀的真实拍点，不依赖 basic-pitch；经典回退仍可用。

## 涉及层

- [ ] 逻辑：`src/chart/bead.ts` 新增 `impactsFromBeats(beats, opts)`——过滤 synthetic/非有限拍点；按约 1s 窗口选最强拍；保证相邻撞击 > 0.9s；左右交替；band→midi/band、power、dur 映射；少于 2 个撞击返回空。
- [ ] 逻辑：`src/chart/scene.ts` 的 `auto` 在 `noteSource` 为空时用拍点玻璃珠；新增网格抽稀参数（默认约 1s）；`reason` 区分「音符玻璃珠 / 拍点玻璃珠 / 经典回退」；无撞点或构建异常回退经典并给原因；`classic` 强制不变。
- [ ] 音频：`notesFromBead` 沿用；确认网格撞击的 midi/band 让玻璃音轨有变化；场景切换时玻璃轨缓存失效（现有机制）。
- [ ] CLI：`scripts/render-video.mts` 支持 `--motion=bead|auto` 在无音符输入时构建拍点玻璃珠；默认仍 classic，不改变现有出片默认。
- [ ] 测试：`scripts/verify-bead.mts` 新增 `impactsFromBeats` 的 BPM 矩阵；`scripts/verify-scene.mts` 更新网格 auto/bead 旧断言；浏览器加载 steady-120 检查首帧玻璃珠。

## 验收标准

- 60/90/120/140/180 BPM 矩阵：相邻撞击间隔 ≥0.9s；优先强拍；左右严格交替；首/尾撞击合理；不含 synthetic 拍点。
- `buildScene(steady-120, { motion: 'auto' })` → `motion='bead'`、`bead.impacts.length ≥ 2`、reason 含「拍点」；`motion='classic'` → 经典；无拍点 → 经典 + 提示。
- 音符驱动歌仍走音符玻璃珠，撞击时刻不变（`verify:note` / `verify:bead` 回归）。
- 页面加载 steady-120：首个可渲染帧是玻璃珠，撞击约 1s 一次（UI 文案可能仍是旧的，002 修）。
- `npm run typecheck`、`npm run build`、现有 `verify*` 全绿。

## 备注

- 本切片故意不碰 UI 文案/控件（002）；场景一变，页面就会先看见拍点玻璃珠。
- 超长前奏只用真实拍点，首撞前沿用现有 intro 掉落；视觉问题记录到 006，本轮不加幽灵拍点。
