import { clamp } from '../util/math.ts';
import type { AnalysisResult } from '../types.ts';

/**
 * 音乐驱动下落速度的纯函数。
 *
 * V = 基础速度 × BPM 因子 × 活跃度因子 × 长段落因子，全部按 drama 缩放。
 * 本文件不碰 Chart，只负责“这一段应该多快”；落点仍由 Δy=V·Δt 的闭式抛物线保证。
 */

/** 全曲谱通量包络的 p90，用于把 activity 归一化到 0..1。空包络回退 1。 */
export function envelopeP90(a: AnalysisResult): number {
  const env = a.envelope;
  if (!env || env.length === 0) return 1;
  const step = Math.max(1, Math.floor(env.length / 2000));
  const sample: number[] = [];
  for (let i = 0; i < env.length; i += step) sample.push(env[i]);
  sample.sort((x, y) => x - y);
  return sample[Math.floor(sample.length * 0.9)] || 1;
}

/**
 * 段落后 75% 的谱通量均值 / p90。
 * 跳过起音本身，避免长音/休止段被开头的 attack 抬高；空包络或非法段返回 0.5。
 */
export function activityAt(
  a: AnalysisResult,
  t0: number,
  t1: number,
  p90 = envelopeP90(a),
): number {
  const env = a.envelope;
  const hop = a.hopSec;
  if (!env || env.length === 0 || !(t1 > t0) || !(hop > 0)) return 0.5;

  const from = Math.max(0, t0 + 0.25 * (t1 - t0));
  const f0 = Math.max(0, Math.floor(from / hop));
  const f1 = Math.min(env.length - 1, Math.ceil(t1 / hop));
  if (f1 < f0) return 0.5;

  let sum = 0;
  let n = 0;
  for (let i = f0; i <= f1; i++) {
    sum += env[i];
    n++;
  }
  const mean = n > 0 ? sum / n : 0;
  return clamp(mean / (p90 > 0 ? p90 : 1), 0, 1);
}

/** 谱通量活跃度与音符力度的融合：包络抓段落/休止，power 抓单音强弱。 */
export function combineActivity(envAct: number, wBase: number): number {
  return clamp(0.6 * clamp(envAct, 0, 1) + 0.4 * clamp(wBase, 0, 1), 0, 1);
}

/** 原始长音/休止间隔（split 成 ghost 之前）越长，额外减速越多。 */
export function longFactorFor(gap: number, drama: number): number {
  const d = clamp(drama, 0, 1);
  return 1 - d * 0.3 * clamp((gap - 0.8) / 2.5, 0, 1);
}

/**
 * 本段未平滑的速度。
 * @param longFactor 长音/休止额外减速；由 003 提供，001 默认 1
 */
export function speedFor(
  baseV: number,
  bpm: number,
  activity: number,
  drama: number,
  longFactor = 1,
): number {
  const d = clamp(drama, 0, 1);
  const safeBpm = Number.isFinite(bpm) ? bpm : 120;
  const tempo = 1 + d * (clamp(safeBpm / 120, 0.7, 1.5) - 1);
  const act = 1 + d * 0.5 * (2 * clamp(activity, 0, 1) - 1);
  const minV = baseV * (1 - 0.55 * d);
  const maxV = baseV * (1 + 0.9 * d);
  return clamp(baseV * tempo * act * clamp(longFactor, 0.5, 1), minV, maxV);
}
