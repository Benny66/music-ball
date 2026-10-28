# 出片管道接缝（prefactoring）

**Blocked by**: 无

**来源**: `docs/specs/2026-10-28-bead-prototype.md`（测试决策 5、补充说明「原型渲染脚本」）

## 目标

把 `scripts/render-video.mts` 里的「解码音频 → 逐帧喂 ffmpeg →封装 mp4」抽成可复用模块，现有 `npm run render` 输出不变；玻璃珠 spike 只写自己的 draw，不再复制管道。

## 涉及层

- [ ] 逻辑层：新增 `scripts/lib/media.mts`（或等价路径）：
  - `readWav(path)` / `decodeWithFfmpeg(path)`：与现有实现等价，支持 mp3/wav、单/立体声
  - `encodeFramesToMp4({ output, fps, width, height, audioFile, totalFrames, onFrame })`：负责 ffmpeg 进程、stdin 背压、错误/退出码
  - 模块不读 `process.argv`、不依赖全局状态
- [ ] 逻辑层：`scripts/render-video.mts` 改为调用该模块；命令行参数、默认值、日志、`--stills` 分支保持现有行为
- [ ] 测试：改动前后各跑一次同参数出片，比较视频流 framemd5
- [ ] 边界：不修改 `src/`、`index.html`；不触碰工作区里 MDF、默认原曲/玻璃音色、basic-pitch Worker 三组未提交改动

## 验收标准

- 重构前先用 `npm run render -- fixtures/steady-120.wav out/refactor-before.mp4 --seconds=2 --scale=0.25 --audio=original` 出片并记录视频流 framemd5。
- 重构后同参数输出与 `refactor-before.mp4` 的视频流 framemd5 完全一致；ffprobe 的分辨率/帧率/时长一致。
- 新模块可被 `spike/bead` 导入；`encodeFramesToMp4` 在 ffmpeg 非零退出时 reject，并带 stderr 摘要。
- `npm run typecheck`、`npm run verify`、`npm run verify:note`、`npm run verify:speed` 全绿。
- 现有 `npm run render` 的 2 秒冒烟成功；`--stills` 仍能出 PNG。
