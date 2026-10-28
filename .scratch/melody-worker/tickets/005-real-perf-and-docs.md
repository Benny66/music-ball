# 真实曲性能/E2E 验收 + 文档

**Blocked by**: 002, 003, 004

**来源**: `docs/specs/2026-10-28-melody-worker.md`（测试 D/F、完成定义）

## 目标

用真实 168s 钢琴曲完成 Worker 性能与交互验收，跑全量回归，并把 Worker、取消、待应用、回退与总耗时 tradeoff 写进文档。

## 涉及层

- [ ] 测试：真实 `fixtures/real/006.夜的钢琴曲5 - 文武贝.mp3`（168.5s）加载+播放；采样主线程帧间隔：提取期间 <200ms（headless 可放宽 <250ms），完成后 60fps
- [ ] 测试：提取完成后的音符/图表/自动模式/玻璃音高
- [ ] 测试：取消、换歌、待应用（暂停/seek/播完）、Worker/模型失败 FFT 回退
- [ ] 测试：重复加载不累积 Worker；`typecheck` / `build` / 三套 verify
- [ ] 文档：README 增加“旋律提取 Worker”小节（进度/取消/待应用/后端/回退/可能更长的总耗时）；ADR-0004/CONTEXT 与实现一致
- [ ] 文档：说明玻璃整轨渲染仍是独立性能点，不在本次范围

## 验收标准

- 真实曲提取期间播放流畅，主线程最大帧间隔达标；提取完成后音符/图表正常。
- 取消/换歌/待应用/回退全部按 003/004 验收通过；最多一个 Worker，完成/取消后终止。
- `verify` 5/5、`verify:note` 25/25、`verify:speed` 13/13；`typecheck` / `build` 通过。
- README/ADR-0004/CONTEXT 与实现一致；明确总提取时间可能更长、Worker 后端 WebGL/CPU、失败 FFT。
- 用户最终 sign-off“播放一段时间后不再卡”，并接受 Worker 可能更长的总提取时间。
- 不把 MDF 下落速度、默认原曲/玻璃音色的未提交改动混进本次提交。
