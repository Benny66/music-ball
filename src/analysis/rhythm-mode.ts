import type { AnalysisResult } from '../types.ts';
import type { MelodyResult } from './melody.ts';

export type RhythmSource = 'auto' | 'notes' | 'grid';
export type EffectiveRhythm = 'notes' | 'grid';

export interface RhythmDecision {
  mode: EffectiveRhythm;
  /** 可展示给用户的判定依据 */
  reason: string;
}

/** 非合成拍里低频 kick 的占比。钢琴左手低音也会落在这里，不能单独作为鼓组判据。 */
export function kickRatio(res: AnalysisResult): number {
  let kick = 0;
  let total = 0;
  for (const b of res.beats) {
    if (b.synthetic) continue;
    total++;
    if (b.band === 'kick') kick++;
  }
  return total > 0 ? kick / total : 1;
}

/**
 * 节奏来源判定。纯函数，不碰 DOM。
 *
 * 只有 basic-pitch 的音符起点能作为时间基准；FFT 降级旋律的帧移是 0.1s，
 * 拿它定板会制造新的不同步，所以一律回退网格。
 */
export function selectRhythmMode(
  res: AnalysisResult,
  melody: MelodyResult | null,
  userChoice: RhythmSource,
): RhythmDecision {
  if (userChoice === 'grid') return { mode: 'grid', reason: '用户选择节拍网格' };

  if (userChoice === 'notes') {
    if (!melody) return { mode: 'grid', reason: '旋律还未提取完成' };
    if (melody.source !== 'basic-pitch') {
      return { mode: 'grid', reason: '旋律模型不可用，已回退节拍驱动' };
    }
    if (melody.notes.length < 4) {
      return { mode: 'grid', reason: '旋律音符不足，已回退节拍驱动' };
    }
    return { mode: 'notes', reason: '用户选择音符驱动' };
  }

  if (!melody) return { mode: 'grid', reason: '自动：旋律音符不足' };
  if (melody.source !== 'basic-pitch') {
    return { mode: 'grid', reason: '旋律模型不可用，已回退节拍驱动' };
  }

  const notes = melody.notes;
  const density = notes.length / Math.max(1, res.duration);
  if (notes.length < 24 || density < 0.2) {
    return { mode: 'grid', reason: '自动：旋律音符不足' };
  }

  // 鼓组优先：看高频瞬态占比。钢琴独奏实测 0.04–0.06，流行/鼓组 0.11–0.26。
  // 阈值取 0.09，留出两边各 0.03 的余量；误判可由用户手动覆盖。
  const high = res.highRatio ?? 0;
  if (high >= 0.09) {
    return { mode: 'grid', reason: '自动：高频瞬态明显（鼓组/打击乐），使用节拍网格' };
  }

  return { mode: 'notes', reason: '自动：未检测到明显鼓组，使用音符起音' };
}
