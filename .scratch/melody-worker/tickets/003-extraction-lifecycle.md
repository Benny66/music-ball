# 提取生命周期：busy 解耦 + 换歌/取消

**Blocked by**: 002

**来源**: `docs/specs/2026-10-28-melody-worker.md`（US-03/04/05/06/07）

## 目标

旋律提取改到后台：`busy` 只保护解码/分析；提取期间可播放/调参/换歌；提供“取消旋律提取”按钮；新加载或取消会终止旧 Worker，旧结果不会覆盖新歌。

## 涉及层

- [ ] 逻辑层：`loadFile` 在 `applyAnalysis` 后释放 `busy`，不 await 旋律 Worker
- [ ] 逻辑层：`melodyGen` generation token；新加载/取消时递增并终止旧 Worker；旧 progress/done/error 一律忽略
- [ ] 状态：提取期间保持当前图表（网格），不阻塞播放/seek/参数
- [ ] UI层：`#melodyCancel` 按钮（提取期间显示）；取消后提示“已取消旋律提取，使用节拍网格”；完成/失败/取消后隐藏
- [ ] 测试：取消、换歌、无迟到结果、最多一个 Worker、文件选择恢复

## 验收标准

- 提取期间文件选择可用；可正常播放/seek/调参。
- 点击取消：Worker 终止；`melodySource` 保持 null/FFT；图表网格；状态提示；按钮隐藏；无迟到 done 覆盖。
- 提取期间加载新歌：旧 Worker 终止；新歌正常解码/分析；旧音符不会应用到新歌。
- 同时最多一个 melody Worker；完成/失败/取消/换歌后都终止。
- 主线程帧间隔仍 <200ms；`verify` / `verify:note` / `verify:speed` 通过。
