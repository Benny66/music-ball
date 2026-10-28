# 用户观看与原型决策

**Blocked by**: 005

**来源**: `docs/specs/2026-10-28-bead-prototype.md`（US-14、完成定义）

## 目标

让用户观看 `bead-old.mp4` 与 `bead-new.mp4`，给出「采用 / 继续调 / 放弃」的明确结论，并写回 ADR/spec；采用后才开生产任务。

## 涉及层

- [ ] 验收：提供两个 mp4 的路径/预览，确认用户能播放完整 18 秒
- [ ] 文档：在 `docs/adr/0005-bead-performance-trajectory.md` 记录结论（accepted / rejected / needs-tuning）、日期、关键观感；同步 `docs/specs/2026-10-28-bead-prototype.md` 状态
- [ ] 决策：
  - 继续调：把具体问题拆成后续调参 ticket（不在本 ticket 实现）
  - 采用：新开生产 spec/tickets（全曲/UI、与 MDF/音频/Worker 整合、回归与真实曲验收）
  - 放弃：记录原因，并明确 spike 文件保留还是清理
- [ ] 边界：不合并三组未提交改动；不 push

## 验收标准

- 用户明确回答「采用 / 继续调 / 放弃」，不能由实现者代答。
- ADR/spec 状态与结论已更新，包含日期和两个 mp4 路径。
- 若继续调：至少列出 1 条可验证的调整项（如滚动时长、相机跟随、板入场比例）。
- 若采用：列出生产范围，并明确与 MDF/音频/Worker 三组未提交改动的先后关系。
- 若放弃：明确 `spike/bead/`、`scripts/bead-*` 的处置。
- `out/` 内容仍不入库；工作区未提交分组保持分离。

## 结论（2026-10-28）

用户观看 `out/bead/bead-new-preview.mp4`、`bead-old.mp4`、`bead-new.mp4` 后确认：**采用**。
- 生产范围：音符驱动（钢琴/轻音乐）先接入玻璃珠；网格/鼓组保留经典运动。
- 旧运动保留切换/回退。
- 下一步：`docs/specs/2026-10-28-bead-production.md` 与 `.scratch/bead-production/tickets/`。
