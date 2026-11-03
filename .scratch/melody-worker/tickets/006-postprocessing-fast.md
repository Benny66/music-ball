# 提取后处理提速：关闭 Melodia 补充搜索

状态：完成（2026-10-29）；后续 007 用快速堆恢复全部音符

**Blocked by**: 无

## 背景

真实钢琴 168.5s 提取 14.5s，其中 WebGL 推理 8.1s、`outputToNotesPoly` 后处理 5.4s（37%）；进度条 100% 后还要等 5.7s。后处理里的 `melodiaTrick` 在所有帧×音高单元反复找全局最大值，补回无 onset 的音符。

## 决定

`outputToNotesPoly(..., melodiaTrick=false)`。代价：真实钢琴音符 5939→5850（−1.5%），板 682→678；撞击仍约 206，平均时间差 3.4ms，仅 2 处变化（最大 0.556s）。缓存键 `MODEL_VERSION` 追加 `:no-melodia`，旧缓存自然失效。

## 证据

- 后处理 5415ms → 220ms；总提取 14.5s → 11.0s（浏览器实测，含分析后 11.9s）。
- 关/开音符对比：A missing 71、B extra 0；板 681→677（未 snap 口径）；撞击 206/206，平均差 3.7ms。
- 缓存命中：619ms，音符 5850。
- 批量推理不可行（实测）：batch1 68ms/窗；batch2 176ms/窗；batch4 2.2s/窗（GPU 显存告警）。
- 回归：verify 5/5、note 26/26、bead 23/23、natural 7/7、scene 10/10、cache、typecheck、build。

## 已知影响

- 169s 真实钢琴约 89 个长音/弱起音音符不再被补回；现有撞击/板选择几乎不变。
- 旧缓存会失效重算一次；之后的加载仍走缓存。
