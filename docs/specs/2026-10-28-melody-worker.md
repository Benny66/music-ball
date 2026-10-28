# basic-pitch 旋律提取移到 Web Worker

- 状态：实现中（001–004 完成，005 待真实曲/用户验收）
- 日期：2026-10-28
- 相关文档：`CONTEXT.md`、`docs/adr/0004-basic-pitch-worker.md`
- 范围：浏览器预览/导出；CLI 不运行 basic-pitch，不受影响
- 不在本 spec 内：MDF 下落速度、默认原曲/玻璃音色（工作区已有未提交改动，单独提交）

## 1. 问题陈述

上传 168 秒真实钢琴曲后，basic-pitch 旋律提取在主线程运行。实测主线程出现 **16 秒**的帧间隔；提取到 100% 后播放恢复 60fps、JS 堆约 338MB。用户感知为“播放一段时间后浏览器特别卡”。

具体缺口：

- `extractMelody` 的 `evaluateModel` 在主线程跑；模型推理、帧/onset/contour 数组处理和 TFJS 调度都会占用 UI 线程。
- 提取在每次加载后自动触发，用户无法在提取期间换歌或取消。
- `loadFile` 的 `busy` 一直持续到旋律提取完成（长曲 30–90 秒），文件选择实际被锁住。
- 提取完成时如果正在播放，图表会立即从网格切成音符驱动；播放中的球/板可能跳一下。
- 模型失败时静默回退 FFT（这条保留），但主线程仍要承担模型尝试的开销。

## 2. 方案概述

把**模型推理**搬到专用 Web Worker，主线程只保留轻量工作：

```
主线程：decode → analyze → OAC 高质量重采样到 22.05k
  → transfer Float32Array 给 melody worker
Worker：加载 basic-pitch 模型（固定 CPU 后端）
  → 推理 → 输出带时间的音符事件
主线程：onset 精修（snapNotesToOnsets）→ 待应用/立即应用 → chart/glass
```

交互：

- 提取期间 UI 保持可交互：可播放、调参、切音轨、换歌、取消。
- 新加载或“取消提取”会 `terminate()` 旧 Worker；旧结果用 generation token 丢弃。
- 完成时如果正在播放：先缓存为“待应用旋律”，暂停/seek/播完再应用；已暂停则立即应用；用户手动切“音符驱动”时立即应用。
- 界面显示提取进度、取消按钮；完成后提示“音符驱动已就绪，暂停/跳转后应用”。
- 模型/Worker 失败 → FFT 旋律回退（自动模式回网格），与现有回退语义一致。

## 3. 用户故事

### 主线程与性能

- **US-01** 提取期间主线程不冻结：加载 168 秒真实钢琴曲并播放，提取全过程最大帧间隔 <200ms；提取完成后仍保持 60fps。
- **US-02** 进度可见：模型加载/推理阶段在 `fileMeta` 显示进度；进度更新不阻塞播放。
- **US-03** 提取在后台：Worker 运行期间可以播放、拖 seek、调速度/变化幅度/物理自由度、切音轨。

### 换歌与取消

- **US-04** 可取消：提取期间出现“取消旋律提取”按钮；点击后 Worker 终止，状态提示“已取消旋律提取，使用节拍网格”，图表保持网格。
- **US-05** 可换歌：提取期间重新选择文件会终止旧 Worker，新文件从解码/分析重新开始；旧结果不会覆盖新歌。
- **US-06** `busy` 只覆盖解码/分析，不覆盖旋律提取；文件选择不再被长时间锁住。
- **US-07** 同时最多一个 melody Worker；完成/失败/取消/换歌后必须终止，不泄漏 Worker。

### 结果应用

- **US-08** 完成时正在播放：旋律进入“待应用”，当前图表不变、不跳；状态提示“音符驱动已就绪，暂停/跳转后应用”。
- **US-09** 暂停、seek 或播完时自动应用待应用旋律；应用后图表切到音符驱动，状态更新。
- **US-10** 完成时已暂停：立即应用音符驱动，无需再操作。
- **US-11** 用户在待应用期间手动把“节奏来源”切到“音符”：立即应用，不再等待暂停/seek。
- **US-12** 应用后玻璃音轨（若当前是玻璃/混音）按新图表重渲；预览与浏览器导出共用同一份结果。

### 回退与正确性

- **US-13** Worker/模型失败：回退 FFT 旋律，`source='fft-fallback'`；自动模式回网格并显示现有回退提示；FFT 仍不作为时间基准。
- **US-14** 模型成功路径仍经过 `snapNotesToOnsets`；事件对齐、主导音高、玻璃音高、自动判定与现有行为一致。
- **US-15** 重采样仍用主线程 `OfflineAudioContext`（22.05kHz），不因 Worker 降低音质；Worker 只接收 Float32Array。
- **US-16** Worker 固定 CPU 后端（TFJS 3.21 的 WebGL 后端在 Worker 里引用 `window`，不可用）；CPU 保证 UI 不阻塞，总耗时可能更长。后端名称可记录/调试，不要求用户选择。
- **US-17** 现有 `verify` 5/5、`verify:note` 25/25、`verify:speed` 13/13 不回归；`typecheck` / `build` 通过。

### 真实曲验收

- **US-18** 用 `fixtures/real/006.夜的钢琴曲5 - 文武贝.mp3`（168.5s）实测：提取期间播放流畅；提取完成后音符/图表正常；取消/换歌/暂停或 seek 应用均符合预期。
- **US-19** 用户最终确认“播放一段时间后不再卡”，并接受 Worker 可能更长的总提取时间。

## 4. 已定决策

| 决策 | 结论 | 理由 |
|---|---|---|
| 推理位置 | 专用 Web Worker | 主线程 16s 停顿实测；UI 必须可交互 |
| 重采样 | 主线程 `OfflineAudioContext` → 22.05kHz | 重采样很快，保留音质；Worker 里没有 OAC |
| Worker 输入 | 22.05kHz `Float32Array`（transfer） | basic-pitch `evaluateModel` 直接支持 Float32Array |
| 后端 | 固定 CPU | TFJS 3.21 WebGL 后端在 Worker 里引用 `window`，会报错并卡住；CPU 保底且 UI 不阻塞 |
| 失败回退 | FFT 旋律（`fft-fallback`） | 与现有回退语义一致；自动模式回网格 |
| 提取交互 | 后台运行；可播放/调参/换歌/取消 | 用户选择“可换歌/可取消” |
| busy | 只覆盖解码/分析 | 提取不再锁文件选择 |
| 换歌/取消 | `terminate()` 旧 Worker + generation token | 防止旧结果覆盖新歌 |
| 完成时应用 | 正在播放 → 待应用；暂停/seek/播完应用；已暂停立即 | 避免播放中画面跳变 |
| 手动切音符 | 立即应用待应用旋律 | 用户显式选择，不应再等 |
| 取消按钮 | 提取期间显示，完成/失败/取消后隐藏 | 让“可取消”可发现 |
| Worker 生命周期 | 完成/失败/取消/换歌后终止 | 不泄漏 Worker/模型内存 |
| 玻璃整轨渲染 | 不在本 spec 优化 | 独立性能点；本次只解决模型主线程阻塞 |
| 模型精度/时间基准 | 不改 | 仍用 basic-pitch + onset 精修 |

## 5. 测试决策

### 接缝

1. **`melody-client.ts`**（新增）
   `startMelody(pcm22050, callbacks) -> { cancel(): void }`。负责 Worker 创建、progress/done/error、终止、generation token 由调用方持有。
2. **`melody.worker.ts`**（新增）
   Worker 协议：`{type:'progress', phase, ratio}`、`{type:'done', notes, source, backend}`、`{type:'error', message}`；模型/FFT 都在 Worker 内完成。
3. **`melody.ts`**（现有）
   保留 `fftMelody`、`snapNotesToOnsets`、`midiAt`、`MelodyNote/MelodyResult`；移除主线程模型推理路径。
4. **`main.ts` 状态机**（现有）
   新增 `pendingMelody`、`melodyHandle`、`melodyGen`、`melodyCancel` UI；`loadFile` 的 busy 只覆盖解码/分析。
5. **浏览器 E2E / headless**（新增检查）
   真实 168s 文件；采样主线程帧间隔；覆盖取消、换歌、待应用、失败回退。
6. **现有 `verify` / `verify:note` / `verify:speed`**
   回归。

### 测试用例与断言

**A. 主线程性能（浏览器）**

- 加载真实 168s 钢琴，立即播放；在提取期间以 `requestAnimationFrame` 采样帧间隔：最大间隔 <200ms（headless 允许 <250ms；用户桌面目标 <100ms）。
- 提取完成后主线程恢复 60fps；`melodySource` 变为 `basic-pitch`；音符数/图表正常。
- 播放期间 seek/调参不触发长时间阻塞。

**B. 取消与换歌**

- 提取中点击“取消”：Worker 被终止；`melodySource` 保持 null/FFT；图表网格；状态提示；无迟到的 done 消息覆盖。
- 提取中加载另一首歌：旧 Worker 终止；新歌完成解码/分析；旧旋律不会应用；同时最多一个 Worker。
- 取消后按钮隐藏；可以正常再次加载。

**C. 待应用**

- 提取完成时正在播放：图表仍网格；状态“已就绪”；播放位置连续；暂停后图表切音符；seek 后也切；播完再播时切。
- 提取完成时已暂停：立即切音符。
- 待应用期间手动切“音符”：立即切。
- 待应用期间换歌/取消：不应用旧结果。

**D. 回退**

- 阻断模型请求或强制 Worker 失败：返回 `fft-fallback`；自动模式网格；提示可见；不崩溃。
- Worker 不可用（模拟 `Worker` 构造失败）：主线程 FFT 回退；`verify` 仍通过。

**E. 回归**

- `npm run typecheck` / `build` 通过；`@spotify/basic-pitch` 只进 Worker chunk，主包不重复打包模型库（或至少不增加主线程执行）。
- `verify` 5/5、`verify:note` 25/25、`verify:speed` 13/13。
- 模型成功路径的音符经过 onset 精修；自动判定、玻璃音高、事件对齐与现有测试一致。
- 完成后 Worker 终止；重复加载不累积 Worker/内存。

**F. 真实曲人工验收**

- 用户用真实钢琴全曲确认：提取期间不卡；取消/换歌可用；待应用在暂停/seek 生效；音符驱动/玻璃轨正常。
- 接受 Worker 可能更长的总提取时间。

### 完成定义

- A–E 自动/headless 检查通过。
- F 用户 sign-off。
- README/ADR-0004/CONTEXT 与实现一致。
- 不把 MDF/默认原曲/玻璃音色的未提交改动混进本 spec 的提交。

## 6. 明确不做

- 不优化玻璃整轨渲染（681 块板 × 多个音频节点）——独立性能点。
- 不改 basic-pitch 模型/精度/时间基准；不引入云端推理。
- 不做主线程分块推理；不保留主线程模型路径作为默认。
- 不改分析 Worker（它已经不在主线程）。
- 不改音符/onset 精修、自动判定、速度/弹跳映射。
- 不做模型缓存/IndexedDB 持久化；每次加载重新提取（可后续单独立项）。
- 不改 CLI 出片（CLI 不跑 basic-pitch）。
- 不重做整个加载 UI；只加进度、取消按钮和待应用提示。

## 7. 补充说明

- **Worker 消息协议**：主线程 transfer 22.05k PCM；Worker 返回 `notes`（start/end/midi/amplitude）与 `source`；`backend` 仅调试。
- **重采样**：主线程 `resampleTo22050` 返回 Float32Array；用 `.slice()`/独立 buffer transfer，保留 `decoded.pcm` 供 Worker 失败时主线程 FFT 回退。
- **Worker 后端**：固定 `tf.setBackend('cpu')`；TFJS 3.21 的 WebGL 后端会引用 `window`，在 Worker 里直接报错并卡住。后端名称写入日志，不展示给用户。
- **模型路径**：`/models/basic-pitch/model.json`；`predev`/`prebuild` 已复制到 public；Worker 内用绝对路径。
- **generation token**：每次 load/cancel 递增；旧 Worker 的 progress/done/error 一律忽略；Worker 终止后不再发消息。
- **busy 语义**：`loadFile` 顶部 `busy` 只保护解码/分析；`applyAnalysis` 后释放；旋律提取不再 await 在 `loadFile` 的 finally 里。
- **待应用状态**：`pendingMelody` 只保存成功/FFT 结果；应用入口统一为 `applyMelodyResult()`；暂停/seek/onEnded/手动音符都调用它。
- **玻璃重渲**：应用旋律后若 `audioMode !== 'original'`，沿用现有 `applyAudioMode` 重渲；这次不改变玻璃渲染性能。
- **主线程帧间隔测量**：headless 采样 `requestAnimationFrame` 间隔；提取期间模型在 Worker，主线程只做重采样/消息；目标 <200ms，headless 可放宽到 <250ms。
- **总耗时**：Worker CPU 可能比主线程 GPU 慢；没有硬 SLA，进度条和可取消是体验保证。
- **工作区状态**：MDF 下落速度、默认原曲/手动切玻璃、玻璃音色是未提交的独立改动；本 spec 的实现/提交不要混入。
