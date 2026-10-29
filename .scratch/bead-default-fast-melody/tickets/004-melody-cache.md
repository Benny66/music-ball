# 旋律提取持久缓存

状态：已完成（2026-10-29）

**Blocked by**: 001, 002, 003

**来源**: `docs/specs/2026-10-29-default-bead-and-fast-melody.md`（US-09–11）、`docs/adr/0007-melody-webgl-cache.md`

## 目标

同一首歌再次加载时 0 秒拿到音符，首个可渲染帧就是音符玻璃珠；缓存按文件内容 + 模型版本隔离，失败不阻塞提取/播放。

## 涉及层

- [ ] 数据：新增 `src/analysis/melody-cache.ts`——`hashFile(file)`（SHA-256，优先 `crypto.subtle`）、`getCachedNotes(key)`、`putCachedNotes(key, notes)`、`MODEL_VERSION`、`clearCache()`；IndexedDB 打开/读写失败返回 null 并记录，不抛到主流程。
- [ ] 数据：键 = `sha256(file bytes):MODEL_VERSION`；存原始 basic-pitch 音符（不存已吸附结果）；加载命中后仍用当前分析 onset 重新 `snapNotesToOnsets`。容量上限建议 50 首/30MB 取小者，LRU 淘汰。
- [ ] 逻辑：`src/main.ts` 在 `loadFile` 开始时并行发起 hash + 缓存查询（与 decode/analyze 并行）；命中则在首次 `applyAnalysis`/`rebuild` 前写入 `melodyResult`，跳过 Worker；未命中走现有提取，Worker 完成后写缓存；`fileMeta` 显示「缓存命中」/「缓存写入失败」。
- [ ] 逻辑：同一文件重复加载不累积 Worker；换歌/取消不写错键；模型版本变化强制未命中。
- [ ] 测试：headless 加载真实钢琴片段两次——第二次不启动 Worker、`melodyBusy=false`、首帧音符玻璃珠；不同文件/版本不命中；模拟 IDB 不可用/条目损坏时正常提取；容量上限/淘汰的纯函数测试。
- [ ] 文档：README 补缓存键/版本/体积/失效说明（006 收口）；debug API 暴露缓存状态便于验收。

## 验收标准

- 同文件第二次加载：无 Melody Worker 启动，`melodySource='basic-pitch'`，首个可渲染帧是音符玻璃珠，`fileMeta` 显示缓存命中。
- 文件内容变化、文件名相同、`MODEL_VERSION` 变更：均不命中，重新提取并覆盖缓存。
- IndexedDB 不可用、配额不足、条目 JSON 损坏：删除坏条目/跳过缓存，正常提取，提示可见但不阻塞播放。
- 缓存条目有上限和淘汰；单首约 300KB 量级；页面刷新后仍命中。
- `typecheck` / `build` / 现有 `verify*` 全绿。

## 备注

- 缓存是加速项，不是正确性依赖；任何缓存路径失败都必须回到“正常提取”。
- 不缓存 FFT 降级结果（时间基准不可用）；只缓存 `source='basic-pitch'` 的原始音符。
- 非安全上下文（无 `crypto.subtle`）直接跳过缓存，并在 console 说明。
