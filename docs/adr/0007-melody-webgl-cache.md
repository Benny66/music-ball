# 旋律提取改用 Worker WebGL + 持久缓存

状态：accepted（2026-10-29）

背景：ADR-0004 把 basic-pitch 放进 Web Worker，但固定 CPU 后端；168.5s 真实钢琴曲实测提取 90.0s，用户要求加快。tfjs 3.21 的 WebGL 后端此前被认为在 Worker 里不可用，实际卡点是 `PlatformBrowser.setTimeoutCustom` 直接引用 `window`。一次探针在 Worker 里设置 `globalThis.window = globalThis` 并关闭 `USE_SETTIMEOUTCUSTOM` 后，OffscreenCanvas WebGL2 可正常跑完整模型。

决定：Melody Worker 优先使用 WebGL 后端（含上述兼容补丁），WebGL/OffscreenCanvas 不可用或推理失败时回退 CPU，回退原因可见。提取结果持久化到 IndexedDB：键 = 文件内容哈希 + 模型版本，存原始 basic-pitch 音符，加载后用当前 onset 重新精修；缓存命中在首次重建前应用，同曲再次加载 0 秒出音符。缓存损坏/配额不足/IDB 不可用时，不阻塞地降级为正常提取并给出可见提示；条目设上限并淘汰。

证据：同一 168.5s PCM、headless Chromium，CPU 90.0s vs WebGL 21.2s（4.3x）；两边均 5981 个音符，匹配率 100%，起点/音高/力度差异 0。headless 为软件 WebGL，真机硬件 WebGL 仍需 CPU 对照与真实钢琴同步验收。

备选方案：多 Worker CPU 分片（不确定的加速，内存/复杂度更高，GPU 已给 4.3x）；WASM/WebGPU（依赖/兼容性风险）；只做缓存（首次仍 90s）；升级 tfjs（超出本轮，且 basic-pitch 版本约束在 3.x）。

## 后果

- ADR-0004 的「Worker 固定 CPU」部分被本 ADR 取代；Worker 线程模型、取消/换歌、FFT 降级保留。
- 兼容补丁依赖 tfjs 3.21 的内部行为，升级 tfjs 时要重验并删除/替换补丁。
- 硬件 WebGL 的浮点差异可能改变音符；必须有 WebGL/CPU 对照，差异大则回退 CPU 并记录。
- 缓存增加 300KB/首量级的本地存储，需要版本失效、容量上限与淘汰；缓存不是正确性依赖。
- 提取完成后的自动升级/待应用策略由 ADR-0006 与规格定义，过渡需视觉验收。
