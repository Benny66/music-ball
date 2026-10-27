import { clamp } from '../util/math.ts';

export interface TempoEstimate {
  bpm: number;
  periodSec: number;
  /** 以帧为单位的周期（浮点） */
  periodFrames: number;
  /** 0..1，越低说明倍/半速歧义越严重 */
  confidence: number;
}

/**
 * 用节拍强度包络的自相关估全局周期，再用对数正态先验压制倍/半速歧义。
 *
 * 先验的意义：ACF 在 T、T/2、2T 处都有峰，纯取最大必然在 60/120/240 之间乱跳。
 * 用「以 120BPM 为中心、σ = 0.75 个八度」的对数正态分布做权重，能把明显不合理的
 * 2 倍速结果压下去，同时不至于把真正的 90/150BPM 也一起拧到 120。
 */
export function estimateTempo(
  env: Float32Array,
  hopSec: number,
  opts: { minBpm?: number; maxBpm?: number; hintBpm?: number; sigmaOctaves?: number } = {},
): TempoEstimate {
  const minBpm = opts.minBpm ?? 50;
  const maxBpm = opts.maxBpm ?? 200;
  const hint = opts.hintBpm ?? 120;
  const sigma = opts.sigmaOctaves ?? 0.75;

  const n = env.length;
  const lagMin = Math.max(2, Math.round(60 / maxBpm / hopSec));
  const lagMax = Math.min(n - 2, Math.round(60 / minBpm / hopSec));
  if (lagMax <= lagMin) {
    return { bpm: hint, periodSec: 60 / hint, periodFrames: 60 / hint / hopSec, confidence: 0 };
  }

  // 去均值，否则 ACF 会被直流分量淹没
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= Math.max(1, n);

  const centerLag = 60 / hint / hopSec;
  const scores = new Float64Array(lagMax + 2);
  let bestLag = lagMin;
  let bestScore = -Infinity;

  for (let lag = lagMin; lag <= lagMax; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += (env[i] - mean) * (env[i + lag] - mean);
    const acf = acc / (n - lag);
    const octaves = Math.log2(lag / centerLag);
    const prior = Math.exp(-0.5 * (octaves / sigma) * (octaves / sigma));
    const s = acf * prior;
    scores[lag] = s;
    if (s > bestScore) {
      bestScore = s;
      bestLag = lag;
    }
  }

  // 抛物线细化周期
  const a = scores[bestLag - 1] ?? bestScore;
  const b = bestScore;
  const c = scores[bestLag + 1] ?? bestScore;
  const denom = a - 2 * b + c;
  const delta = denom !== 0 ? clamp((0.5 * (a - c)) / denom, -0.5, 0.5) : 0;
  const periodFrames = bestLag + delta;
  const periodSec = periodFrames * hopSec;

  // 置信度：最佳峰 / 距它 >15% 的最强次峰。倍/半速歧义会让这个比值接近 1。
  let second = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    if (Math.abs(lag - bestLag) < bestLag * 0.15) continue;
    if (scores[lag] > second) second = scores[lag];
  }
  const ratio = second > 0 ? bestScore / second : 3;
  const confidence = clamp((ratio - 1) / 1.2, 0, 1);

  return {
    bpm: 60 / periodSec,
    periodSec,
    periodFrames,
    confidence,
  };
}
