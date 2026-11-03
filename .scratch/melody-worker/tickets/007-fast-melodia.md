# 快速 Melodia 补充搜索（行最大值堆）

状态：完成（2026-10-29），待用户实机确认

**Blocked by**: 006（关闭 Melodia 后提取 14.5s→11s，但少 1.5% 音符）

## 目标

恢复全部音符，同时把后处理留在亚秒级：本地复制 `outputToNotesPoly`（Apache-2.0），只替换 Melodia 的全局最大值扫描。

## 实现

- `src/analysis/basic-pitch-notes.ts`：行最大值 + 行版本堆，堆按「值降序、行号升序」取点；
  只刷新「当前最大值单元被清零」的行，避免每轮全矩阵扫描。
- `melody-model.ts` 改用 `outputToNotesPolyFast`，Melodia 保持开启。
- 缓存键 `MODEL_VERSION` 改为 `:fast-melodia`，旧缓存失效。

## 验证

- 随机矩阵（80/200/600 行×88，5 组种子）：快速版与原库输出**逐条完全一致**。
- 真实钢琴 168.5s：音符 5939 个，与优化前基线逐条零差异（start/midi/amplitude）。
- 后处理：原库 5.4s → 快速版 1.07s（高负载机器；隔离基准 2000×88：8.1s → 75ms，输出相等）。
- 总提取：高负载机器 wall 21.5s（推理 18.1s 被机器负载拖慢）；正常机器推理约 8.1s，预计总时长约 11–12s。
- 回归：verify 5/5、verify:melodia 3/3、note 26/26、bead 23/23、natural 7/7、scene 10/10、cache、typecheck、build。

## 备注

- 算法从 basic-pitch 1.0.1（Apache-2.0）移植，文件头已注明来源。
- 若后续升级 basic-pitch，需要重新对齐 `verify:melodia`。
