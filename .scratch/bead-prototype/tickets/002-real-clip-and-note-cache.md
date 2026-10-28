# 真实钢琴片段与撞击点缓存

**Blocked by**: 001

**来源**: `docs/specs/2026-10-28-bead-prototype.md`（US-11/12、测试决策 1、补充说明「素材」「音符来源」）

## 目标

从真实钢琴曲中固定截出 15–20 秒，产出本地音频片段 + basic-pitch 音符 JSON + 元数据；之后渲染只读缓存，不再跑模型、不联网，同一份输入可重复重建原型。

## 涉及层

- [ ] 数据层：用现有 Worker 对 `fixtures/real/006.夜的钢琴曲5 - 文武贝.mp3` 提取一次全曲音符（浏览器 `__musicball.melody` 导出，或复用已有全曲 JSON）。
- [ ] 数据层：从音符表选固定窗口（默认 18 秒），选择标准：
  - 用 `boardsFromNotes`（minGap 0.7s）得到的撞击数 14–40
  - 撞击中位间隔 0.5–1.4 秒，最大间隔 ≤2.0 秒
  - 窗口起点距首个撞击 ≥0.3 秒（留给开场掉落）
  - 记录起点、时长和选择理由
- [ ] 脚本：新增 `scripts/bead-fixture.mts`：
  - ffmpeg 切出 `out/bead/clip.wav`（44.1kHz 单声道）
  - 全曲音符平移到片段相对时间，写 `out/bead/notes.json`（`{ source, notes }`，`notes` 为 `MelodyNote[]`）
  - 写 `out/bead/meta.json`：窗口起止、duration、source、音符数、撞击数、中位/最大间隔
- [ ] 测试：脚本内校验时间单调、都在 `[0,duration]`、数量达到下限；固定参数重复运行结果一致
- [ ] 边界：`out/bead/` 不入库；不修改 `fixtures/real/` 原文件；不新增依赖

## 验收标准

- `out/bead/clip.wav` 时长 18.0±0.1 秒，ffprobe 显示 44100Hz 单声道，可直接被现有 `analyze`/`render-video` 读取。
- `out/bead/notes.json` 的 `source` 为 `basic-pitch`；音符数 ≥80；平移后首音 ≥0.3 秒、末音 ≤duration。
- `meta.json` 记录完整；撞击数 14–40，中位间隔 0.5–1.4 秒，最大间隔 ≤2.0 秒（当前实测 16 次 / 1.11s / 1.75s）。
- 同一命令重复运行，`notes.json`/`meta.json` 逐字节一致；音频切片仅允许容器元数据差异，并在 meta 里记录 ffmpeg 参数。
- 删除模型/断网后，后续渲染仍能用缓存 JSON 完成；`out/bead/` 仍被 `.gitignore` 覆盖。
