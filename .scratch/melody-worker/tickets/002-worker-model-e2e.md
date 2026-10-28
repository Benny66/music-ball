# Worker basic-pitch 端到端 + FFT 回退

**Blocked by**: 001

**来源**: `docs/specs/2026-10-28-melody-worker.md`（US-01/02/13/14/16、测试 A/D）

## 目标

把模型推理搬到 `melody.worker.ts`：主线程重采样后 transfer 给 Worker，Worker 跑 basic-pitch（WebGL→CPU），返回音符；主线程做 onset 精修并应用。模型/Worker 失败回退 FFT。主线程不再被模型阻塞。

## 涉及层

- [ ] 数据层：Worker 协议 `progress` / `done {notes, source, backend}` / `error`；transfer 22050 `Float32Array`
- [ ] 逻辑层：新增 `melody.worker.ts`（导入 `runBasicPitch`、`fftMelody`；尝试 WebGL，回退 CPU；模型失败在 Worker 内 FFT）；新增 `melody-client.ts`（创建/终止 Worker、消息）
- [ ] 逻辑层：`loadFile` 重采样后启动 Worker；等结果后 `snapNotesToOnsets` / `melodyResult` / `updateRhythm` / `rebuild`；失败走主线程 FFT
- [ ] UI层：`fileMeta` 显示模型加载/推理进度；本切片暂不解除 `busy`、不加取消按钮
- [ ] 测试：真实 168s 曲主线程帧间隔；音符/图表/自动模式；FFT 回退；现有回归

## 验收标准

- 加载 168s 真实钢琴并播放，提取期间主线程最大帧间隔 <200ms（headless <250ms）；提取完成后 60fps。
- 提取完成后 `melodySource='basic-pitch'`，音符/图表/玻璃音高正常；onset 精修仍生效。
- Worker 先 WebGL、失败回退 CPU；模型/Worker 失败返回 `fft-fallback`，自动模式网格、提示可见、不崩溃。
- 主线程不再执行 basic-pitch 模型推理；Worker 在 done/error 后 `terminate()`。
- `verify` 5/5、`verify:note` 25/25、`verify:speed` 13/13；`typecheck` / `build` 通过。
- 本切片提取期间仍受 `busy` 限制不能换歌（003 解除）。
