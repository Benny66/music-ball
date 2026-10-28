# 旧/新双版 15–20 秒 MP4 对比

**Blocked by**: 002, 003, 004

**来源**: `docs/specs/2026-10-28-bead-prototype.md`（US-11/12/13、测试决策 4/5、测试 C）

## 目标

用同一段音频、同一组音符/撞击点、同分辨率/帧率输出 `bead-old.mp4`（现有 `buildChart` + `draw`）与 `bead-new.mp4`（玻璃珠路径），并证明可重复、未改生产默认。

## 涉及层

- [ ] 脚本：`scripts/render-bead.mts` 增加 `--variant=old|new`、`--full`
  - 旧版：`analyze(clip)` + `buildChart(analysis, { noteSource: notes, drama: 0.7 })` + 现有 `draw`
  - 新版：`buildBeadChoreography(impactsFromNotes(notes))` + `drawBead`
  - 两版同一 `out/bead/clip.wav` 音轨、1080×1920/60fps
- [ ] 数据层：两版都从 `out/bead/notes.json` 读取；若使用玻璃音轨，两版共用同一组音符/seed，确保撞击点一致
- [ ] 测试：
  - ffprobe 两版时长/分辨率/帧率一致
  - 旧版、新版各独立渲染两次，视频流 framemd5 完全一致
  - 新版撞击帧抽样对齐 58%（脚本断言）
- [ ] 交付：`out/bead/bead-old.mp4`、`out/bead/bead-new.mp4`
- [ ] 边界：不改 `src/main.ts`/生产默认；spike 改动只落在 `spike/`、`scripts/`、`docs/`、`.scratch/`；不提交 `out/`/`fixtures/real/`；不混入 MDF、音频、Worker 三组未提交改动

## 验收标准

- 两版均 18.0±0.1 秒、1080×1920、60fps，音频流时长一致；ffprobe 校验通过。
- `bead-old.mp4` 保持现有「球在 58%、背景滚」观感；`bead-new.mp4` 是掉落/滚动/左右交替。
- 两次独立渲染的视频流 framemd5 完全一致；无网络/模型/随机时钟依赖。
- 旧版使用当前 `buildChart`（含工作区 MDF 速度映射）但不修改该组；新版路径不读当前时间。
- 生产默认未改：`src/main.ts`、`index.html` 无 diff；现有 `verify`/`verify:note`/`verify:speed` 全绿。
- 两个 mp4 路径与对比结论交给 006 的用户观看环节。
