# 全曲验收与文档收口

状态：技术验收完成（2026-10-29），待用户视觉确认

**Blocked by**: 001, 002, 003, 004, 005

**来源**: `docs/specs/2026-10-29-default-bead-and-fast-melody.md`（全部用户故事）、`docs/adr/0006-bead-default-all-rhythms.md`、`docs/adr/0007-melody-webgl-cache.md`

## 目标

用真实钢琴 + 鼓组/流行样例完成端到端验收，记录性能/同步/回退数据，更新文档，确认没有回归或不该入库的产物。

## 涉及层

- [ ] 验收：真实钢琴 168.5s——首次加载（清缓存）拍点玻璃珠→音符升级；二次加载缓存命中首帧音符玻璃珠；WebGL 提取 ≤30s；强制 CPU 回退可用；60fps；导出完成；玻璃音轨撞击点正确。
- [ ] 验收：鼓组/流行样例（fixtures/real 或 steady-120）——首帧拍点玻璃珠、撞击约 1s、左右交替、玻璃音轨与拍点同步；经典回退可对照。
- [ ] 验收：无拍点/分析失败回退经典；取消提取、换歌、seek、暂停/播完；三种音轨模式；浏览器导出与 CLI `--motion=bead|auto`。
- [ ] 验收：WebGL vs CPU 音符逐条对照（真机硬件）；缓存命中/失效/IDB 失败；主线程帧间隔与内存。
- [ ] 文档：README 更新默认运动、拍点抽稀、音符升级、WebGL/CPU 回退、缓存键/体积/失效、性能实测与已知限制；CONTEXT 与实现一致；ADR-0004/0005 状态与 ADR-0006/0007 互链；spec 状态改为已实现。
- [ ] 清理：不提交 `fixtures/real`、`out/`、生成视频/截图；`git status` 只含预期源码/文档；旧/新对比片按约定存放但不入库。

## 验收标准

- 真实钢琴全曲：首次/二次加载路径符合 spec；WebGL ≤30s、CPU ~90s、缓存命中 0s（Worker 不启动）；预览 60fps；导出 1080×1920/60fps 完成；撞击帧/同步通过。
- 鼓组/流行样例：首帧玻璃珠，撞击间隔约 1s，玻璃音轨与拍点一致；经典对照可用。
- 回退/异常：WebGL 不可用、IDB 不可用、模型失败、无拍点、取消/换歌/seek 全部有可见提示且不崩溃。
- `npm run typecheck`、`npm run build`、`verify`、`verify:note`、`verify:speed`、`verify:bead`、`verify:scene` 全绿；新增测试覆盖拍点玻璃珠/缓存/升级/回退。
- 旧/新对比片（经典 vs 拍点玻璃珠、拍点 vs 音符、升级过渡）通过用户视觉验收；README/CONTEXT/ADR/spec 与实现一致；真实音频/生成物未入库。

## 备注

- 把实测数字写进 README/ADR：168.5s 的 WebGL/CPU 耗时、音符数、缓存命中、帧间隔、导出时长；区分 headless 软件 WebGL 与真机硬件 WebGL。
- 如果升级过渡未通过视觉验收，记录回退到「暂停/seek 时应用」的现状，并把「自动过渡」留作后续 ticket，不要静默保留一个会跳变的默认。
- 本轮结束前做一次 `git diff` 审阅，确认没有把 MDF/音频/Worker 旧改动混进来。
