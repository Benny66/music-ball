# 旋律模块拆分 + 主线程重采样接缝

**Blocked by**: 无

**来源**: `docs/specs/2026-10-28-melody-worker.md`（接缝 1/3、US-15）

## 目标

把 basic-pitch 模型代码拆到可被 Worker 导入的模块，并把 22.05k 重采样抽成返回 `Float32Array` 的接缝；现有主线程提取行为不变。

## 涉及层

- [ ] 逻辑层：新增 `src/analysis/melody-model.ts`，导出 `runBasicPitch(pcm22050, onProgress) -> Promise<MelodyResult>`；模型加载/推理/`outputToNotesPoly`/`noteFramesToTime` 都移到这里
- [ ] 逻辑层：`src/analysis/melody.ts` 保留 `fftMelody` / `snapNotesToOnsets` / `midiAt` / 类型；`resampleTo22050(pcm, sr)` 返回 22050 的 `Float32Array`
- [ ] 逻辑层：主线程 `extractMelody` 改为「重采样 → `runBasicPitch` → 失败 FFT」，行为与现在一致
- [ ] UI层：无
- [ ] 测试：`typecheck` / `build` / 现有三套 verify；浏览器快速加载一次确认主路径仍出音符

## 验收标准

- `melody-model.ts` 没有顶层 DOM/`OfflineAudioContext` 依赖，可被 Worker 导入；模型路径仍是 `/models/basic-pitch/model.json`。
- `resampleTo22050` 输出 22050Hz `Float32Array`；`runBasicPitch` 接受该数组（basic-pitch 支持 `Float32Array`）。
- 现有主线程路径仍能产出 basic-pitch 音符；FFT 回退语义不变。
- `verify` 5/5、`verify:note` 25/25、`verify:speed` 13/13；`typecheck` / `build` 通过。
- 本切片不引入 Worker，不改变用户可见行为。
