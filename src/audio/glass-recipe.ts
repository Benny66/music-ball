import { clamp } from '../util/math.ts';

/**
 * 玻璃敲击的共享配方（浏览器 OfflineAudioContext 与 Node 纯 JS 共用）。
 *
 * 旧版的问题：五个分音里基频权重最高、包络 0.12–0.6s 就掉到 0.0001，
 * 实际 10% 衰减只有 0.05s，听起来是低频点击而不是玻璃。新版：
 *   - 七个强不谐和模态，2–3 次模态最亮，基频不再压过一切
 *   - 余音 0.6–1.6s，高次模态衰减更快，留下低频长尾
 *   - 所有音高统一按 accent 控音量，不再用 kick/hat 频段压扁玻璃声
 */
export const GLASS_RATIOS = [1, 1.59, 2.14, 2.65, 3.32, 4.5, 5.7];
export const GLASS_AMPS = [0.55, 0.8, 0.65, 0.45, 0.3, 0.2, 0.12];
export const GLASS_DECAY_MUL = [1, 0.85, 0.7, 0.55, 0.42, 0.3, 0.2];
export const GLASS_ATTACK_SEC = 0.0015;
export const GLASS_FADE_SEC = 0.05;
export const GLASS_MASTER = 0.45;

export interface GlassNoiseSpec {
  fc: number;
  dur: number;
  gain: number;
}

export const GLASS_NOISE: GlassNoiseSpec[] = [
  { fc: 5000, dur: 0.02, gain: 0.12 },
  { fc: 8000, dur: 0.1, gain: 0.06 },
];

/** 余音长度：稀疏时更长，密集时短一些，但最短也有 0.6s。 */
export function glassRing(dt: number): number {
  return clamp(0.5 + 0.7 * dt, 0.6, 1.6);
}

/** 所有音高统一按 accent 控制音量。 */
export function glassGain(accent: number): number {
  return 0.4 + 0.6 * clamp(accent, 0, 1);
}

export function glassPartialDecay(ring: number, k: number): number {
  return ring * GLASS_DECAY_MUL[k];
}

/** 与 Node 端一致的软限幅，避免长余音叠加后削波。 */
export function softClip(v: number): number {
  if (v > 1) return 1 - 1 / (v + 1);
  if (v < -1) return -1 + 1 / (1 - v);
  return v;
}
