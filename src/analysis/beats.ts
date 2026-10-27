import { clamp } from '../util/math.ts';

export interface BeatTrack {
  /** 帧索引（整数） */
  frames: number[];
  /** 回溯评分，用作整体置信度的参考 */
  score: number;
}

/**
 * Ellis (2007) 动态规划节拍跟踪。
 *
 * 相比「全局 BPM 网格 + 吸附到最近 onset」，DP 不假设曲速恒定：
 * 每个拍点都独立地在「前一个拍点 + 一个合理间隔」里找累计得分最高的位置。
 * 因此变速、rubato、真鼓组的微小漂移都不会累积成几十毫秒的偏移。
 *
 *   C[n] = env[n] + max_{τ ∈ [0.55P, 1.7P]} ( C[n-τ] - λ·(log(τ/P))² )
 */
export function trackBeats(
  env: Float32Array,
  periodFrames: number,
  opts: { tightness?: number; beatCost?: number } = {},
): BeatTrack {
  const n = env.length;
  if (n === 0) return { frames: [], score: 0 };

  const P = Math.max(2, periodFrames);
  const lo = Math.max(1, Math.round(0.55 * P));
  const hi = Math.max(lo + 1, Math.round(1.7 * P));

  // λ 相对包络强度自适应。固定常数在不同响度的歌上表现会差一个量级。
  let peak = 0;
  for (let i = 0; i < n; i++) if (env[i] > peak) peak = env[i];
  const lambda = (opts.tightness ?? 0.6) * (peak || 1);

  // 每拍固定成本 —— 这是密度正则项。
  // 没有它，DP 会偏爱「密集的弱拍」：把一拍拆成两个 8 分音符时包络值之和更大，
  // 于是 100BPM 的段落会被跟踪成 200BPM 的 8 分格。加上成本之后，
  // 弱拍必须自身足够强才值得插入。
  const ref = typicalPeak(env, peak);
  const beatCost = (opts.beatCost ?? 0.45) * ref;

  const penalty = new Float64Array(hi + 2);
  for (let tau = lo; tau <= hi; tau++) {
    const d = Math.log(tau / P);
    penalty[tau] = lambda * d * d;
  }

  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    let best = 0;
    let bestPrev = -1;
    const from = i - hi;
    const to = i - lo;
    for (let prev = Math.max(0, from); prev <= to; prev++) {
      const cand = score[prev] - penalty[i - prev];
      if (cand > best) {
        best = cand;
        bestPrev = prev;
      }
    }
    score[i] = env[i] - beatCost + best;
    back[i] = bestPrev;
  }

  // 终点选在最后 1.5 个周期内的最高分处，避免尾部淡出把终点拉偏
  let endIdx = n - 1;
  let endScore = -Infinity;
  const endFrom = Math.max(0, n - 1 - Math.round(1.5 * P));
  for (let i = endFrom; i < n; i++) {
    if (score[i] > endScore) {
      endScore = score[i];
      endIdx = i;
    }
  }

  const frames: number[] = [];
  let cur = endIdx;
  while (cur >= 0) {
    frames.push(cur);
    cur = back[cur];
  }
  frames.reverse();

  return { frames, score: endScore };
}

/**
 * 局部极大包络强度的 75 分位，作为「一个典型拍值多少分」的基准。
 * 用分位数而不是均值，避免被大量接近 0 的帧拉低。
 */
function typicalPeak(env: Float32Array, peak: number): number {
  const n = env.length;
  const vals: number[] = [];
  const floor = peak * 0.08;
  for (let i = 1; i < n - 1; i++) {
    const v = env[i];
    if (v > floor && v >= env[i - 1] && v >= env[i + 1]) vals.push(v);
  }
  if (vals.length === 0) return peak * 0.5;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length * 0.75)] || peak * 0.5;
}

/** 对拍点帧序列做单调性与最小间隔清洗（NaN / 0 间隔会让下游 g 变成 Infinity） */
export function sanitizeFrames(frames: number[], minGapFrames: number): number[] {
  const out: number[] = [];
  for (const f of frames) {
    if (!Number.isFinite(f)) continue;
    if (out.length > 0 && f - out[out.length - 1] < minGapFrames) continue;
    out.push(f);
  }
  return out;
}

/** 用中位数间隔把帧索引换算成 BPM（用于交叉校验） */
export function medianGapBpm(frames: number[], hopSec: number): number {
  if (frames.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < frames.length; i++) gaps.push(frames[i] - frames[i - 1]);
  gaps.sort((a, b) => a - b);
  const med = gaps[gaps.length >> 1];
  return med > 0 ? 60 / (med * hopSec) : 0;
}

export const clampBpm = (bpm: number): number => clamp(bpm, 40, 220);
