# Melody Worker：WebGL 优先 + CPU 回退

状态：已完成（2026-10-29）

**Blocked by**: 002（共享 `src/main.ts` 的加载流程/状态行，按顺序落地减少冲突；后端逻辑本身独立）

**来源**: `docs/specs/2026-10-29-default-bead-and-fast-melody.md`（US-12–14）、`docs/adr/0007-melody-webgl-cache.md`

## 目标

真实钢琴 168.5s 的 basic-pitch 提取从 CPU 90.0s 降到 WebGL 21s 量级；WebGL 不可用/失败时回退 CPU，回退原因可见；播放与主线程不被阻塞。

## 涉及层

- [ ] 逻辑：`src/analysis/melody.worker.ts` 在创建后端前设置 `globalThis.window = globalThis`、`tf.env().set('USE_SETTIMEOUTCUSTOM', false)`；优先 `tf.setBackend('webgl')` + `tf.ready()`，失败/不可用回退 `cpu`；`postMessage` 带上 `backend` 与可选 `fallbackReason`；保留 FFT 降级。
- [ ] 逻辑：`src/analysis/melody-client.ts` 的消息/类型扩展 `backend`；支持强制后端（用于测试/调试，例如 URL `?melodyBackend=cpu` 或 debug API 传入 `forceCpu`），不改变默认路径。
- [ ] UI：`src/main.ts` 的 `fileMeta`/console 显示当前后端（WebGL / CPU / 回退原因）；不影响进度、取消、换歌终止。
- [ ] 测试：用 headless 浏览器加载 168.5s 真实钢琴，分别跑 WebGL 与强制 CPU；记录总耗时、音符数、起点/音高/力度逐条差异；模拟 WebGL 失败确认回退。
- [ ] 文档：README 的「旋律提取 Worker」性能/回退说明更新（最终在 006 收口）；ADR-0007 已有，补一条实测记录。

## 验收标准

- 真实钢琴 168.5s：本机 WebGL 提取 ≤30s（headless 探针 21.2s）；强制 CPU 仍可完成（约 90s），UI/日志明确显示 CPU。
- WebGL vs CPU：两边音符数、起点、音高、力度逐条一致；若真机硬件 WebGL 有差异，记录差异并交给 005/006 的真实钢琴同步验收判断。
- WebGL 不可用或推理抛错：自动回退 CPU，提示可见；不出现主线程长任务/白屏；取消/换歌/播完行为不变。
- 提取期间预览 60fps（主线程帧间隔不因 Worker 后端变化而恶化）；播放不重启。
- `typecheck` / `build` / 现有 `verify*` 全绿。

## 备注

- 兼容补丁只放在 Worker 入口，不污染主线程；注释说明 tfjs 3.21 的 `PlatformBrowser.setTimeoutCustom` 引用 `window` 的原因。
- 不升级 tfjs、不引入 WASM/WebGPU；如果真机 WebGL 不可用或差异过大，CPU 回退就是验收路径。
