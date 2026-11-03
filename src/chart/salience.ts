import { boardsFromNotes } from './notes.ts';
import { estimateBar } from './styles.ts';
import type { MelodyNote } from '../analysis/melody.ts';
import type { Beat } from '../types.ts';
import { clamp } from '../util/math.ts';

/**
 * 表面节奏选点：钢琴/器乐的撞击候选是**音符起音**，拍点只做节拍权重。
 *
 * 只从拍点里选会漏掉三连音、切分和装饰音：真实钢琴 150–160s 的音符起音
 * 间隔约 0.31–0.37s，而主拍是 0.557s，拍点候选根本表达不了这段流动。
 * 改成板起音候选后，撞击仍落在真实音符上，同时能跟到细分位置。
 */

export interface SurfaceImpactOptions {
  duration: number;
  /** 拍点（含 synthetic 也可，内部只取真实拍） */
  beats?: Beat[];
  /** 宽频 onset 峰值，用于区分「响的起音」和「被盖住的起音」 */
  onsets?: Array<{ t: number; strength: number }>;
  /** 目标密度（次/秒），默认 1.2 —— 20s 约 24 次，与已验收的自然滚动一致 */
  density?: number;
  /** 相邻撞击最短间隔（秒） */
  minGap?: number;
  /** 间隔超过这个值时补一个最高分候选（秒） */
  maxGap?: number;
}

const DEF = { density: 1.2, minGap: 0.5, maxGap: 1.8 };
/** 细分位置（1/3、2/3 拍）的节拍权重：跟表面节奏，但不和正拍平权 */
const SUBDIVISION_WEIGHT = 0.75;

interface Candidate {
  t: number;
  midi: number;
  power: number;
  band: Beat['band'];
  dyn?: number;
  score: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** 每个候选的 onset 强度（前后 0.1s 内最近的峰值，按全曲 p90 归一化） */
function onsetStrengths(onsets: Array<{ t: number; strength: number }>): (t: number) => number {
  if (onsets.length === 0) return () => 0;
  const sorted = onsets.slice().sort((a, b) => a.t - b.t);
  const strengths = sorted.map((o) => o.strength).sort((a, b) => a - b);
  const p90 = strengths[Math.floor(strengths.length * 0.9)] || 1;

  let cursor = 0;
  return (t: number): number => {
    while (cursor < sorted.length && sorted[cursor].t < t - 0.1) cursor++;
    let best = 0;
    let bestD = Infinity;
    for (let i = cursor; i < sorted.length && sorted[i].t <= t + 0.1; i++) {
      const d = Math.abs(sorted[i].t - t);
      if (d < bestD) {
        bestD = d;
        best = sorted[i].strength;
      }
    }
    return bestD <= 0.1 ? Math.min(1, best / p90) : 0;
  };
}

function metreWeights(beats: Beat[] | undefined): {
  weightAt: (t: number) => number;
} {
  const real = (beats ?? [])
    .filter((b) => !b.synthetic && Number.isFinite(b.t))
    .slice()
    .sort((a, b) => a.t - b.t);
  if (real.length < 4) return { weightAt: () => 0.6 };

  const times = real.map((b) => b.t);
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  const period = median(gaps) || 0.5;
  const bar = estimateBar(
    real.map((b, i) => ({ ordinal: i, band: b.band, power: b.power })),
  );
  const thirdTol = 0.06;

  return {
    weightAt: (t: number): number => {
      // 最近拍
      let lo = 0;
      let hi = times.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] < t) lo = mid + 1;
        else hi = mid;
      }
      const next = times[lo];
      const prev = lo > 0 ? times[lo - 1] : null;
      const dist = Math.min(Math.abs(next - t), prev === null ? Infinity : Math.abs(t - prev));

      if (dist <= 0.07) {
        const idx = Math.abs(next - t) <= Math.abs(t - (prev ?? Infinity)) ? lo : lo - 1;
        const pos = (((idx - bar.phase) % bar.L) + bar.L) % bar.L;
        return pos === 0 ? 1 : pos === bar.L / 2 ? 0.78 : 0.55;
      }

      // 细分位置按「从上一拍起算的相位」判定，兼容三连音与附点
      if (prev !== null) {
        const frac = (t - prev) / period;
        const nearThird = Math.min(Math.abs(frac - 1 / 3), Math.abs(frac - 2 / 3));
        if (nearThird * period <= thirdTol) return SUBDIVISION_WEIGHT;
      }
      return 0.5;
    },
  };
}

/**
 * 选出撞击时刻（严格等于某个音符板的起音）。
 * 固定目标密度 + 最短间隔，用 O(K·N) 的加权区间 DP 最大化显著性总分；
 * 大空隙再按最高分补点，保证画面不长时间空着。
 */
export function selectSurfaceImpacts(
  notes: MelodyNote[],
  opts: SurfaceImpactOptions,
): Beat[] {
  const cfg = { ...DEF, ...opts };
  const duration = Math.max(0, cfg.duration);
  if (notes.length === 0 || duration <= 0) return [];

  const boards = boardsFromNotes(notes, {
    minGap: 0.125,
    chordWindow: 0.06,
    minDur: 0.08,
  }).filter((b) => Number.isFinite(b.t) && b.t >= 0 && b.t <= duration + 0.6);
  if (boards.length < 2) return [];

  const onsetAt = onsetStrengths(opts.onsets ?? []);
  const { weightAt } = metreWeights(opts.beats);

  const candidates: Candidate[] = boards.map((b, i) => {
    const prev = i > 0 ? boards[i - 1] : b;
    const low = (b.midi ?? 64) < 60 ? 1 : 0;
    const change = Math.tanh(Math.abs((b.midi ?? 64) - (prev.midi ?? 64)) / 12);
    const score =
      0.35 * onsetAt(b.t) + 0.25 * b.power + 0.2 * weightAt(b.t) + 0.1 * low + 0.1 * change;
    return {
      t: b.t,
      midi: b.midi ?? 64,
      power: b.power,
      band: b.band,
      dyn: b.dyn,
      score,
    };
  });

  const n = candidates.length;
  const minGap = cfg.minGap;
  let K = clamp(Math.round(duration * cfg.density), 2, n);

  // 最短间隔下最多能放几个（贪心取最早），防止 K 不可行
  let feasible = 1;
  let last = candidates[0].t;
  for (let i = 1; i < n; i++) {
    if (candidates[i].t - last >= minGap) {
      feasible++;
      last = candidates[i].t;
    }
  }
  K = Math.min(K, feasible);

  // prev[i] = 满足 t[i]-t[j] >= minGap 的最大 j
  const prev = new Int32Array(n);
  let j = -1;
  for (let i = 0; i < n; i++) {
    while (j + 1 < i && candidates[i].t - candidates[j + 1].t >= minGap) j++;
    prev[i] = j;
  }

  const parent = new Int32Array((K + 1) * n).fill(-1);
  const NEG = -Infinity;
  let prevDp = new Float64Array(n);
  for (let i = 0; i < n; i++) prevDp[i] = candidates[i].score;

  let endIdx = 0;
  for (let i = 1; i < n; i++) if (prevDp[i] > prevDp[endIdx]) endIdx = i;

  for (let k = 2; k <= K; k++) {
    const cur = new Float64Array(n).fill(NEG);
    let p = 0;
    let bestVal = NEG;
    let bestJ = -1;
    let bestEnd = -1;
    for (let i = 0; i < n; i++) {
      const lim = prev[i];
      while (p <= lim) {
        if (prevDp[p] > bestVal) {
          bestVal = prevDp[p];
          bestJ = p;
        }
        p++;
      }
      if (bestJ >= 0) {
        cur[i] = bestVal + candidates[i].score;
        parent[k * n + i] = bestJ;
        if (bestEnd < 0 || cur[i] > cur[bestEnd]) bestEnd = i;
      }
    }
    if (bestEnd < 0) {
      K = k - 1;
      break;
    }
    prevDp = cur;
    endIdx = bestEnd;
  }

  const picked: Candidate[] = [];
  for (let k = K, i = endIdx; k >= 1 && i >= 0; k--) {
    picked.push(candidates[i]);
    i = parent[k * n + i];
  }
  picked.reverse();

  // 大空隙补点：优先补高分候选，且与两侧都保持 minGap
  const times = picked.map((c) => c.t);
  const chosen = new Set(times);
  for (let guard = 0; guard < 2000; guard++) {
    let inserted = false;
    for (let i = 0; i < times.length - 1; i++) {
      const a = times[i];
      const b = times[i + 1];
      if (b - a <= cfg.maxGap + 1e-9) continue;
      let bestT: number | null = null;
      let bestScore = -Infinity;
      for (const c of candidates) {
        if (c.t <= a + minGap || c.t >= b - minGap) continue;
        if (chosen.has(c.t)) continue;
        if (c.score > bestScore) {
          bestScore = c.score;
          bestT = c.t;
        }
      }
      if (bestT === null) continue;
      const idx = candidates.findIndex((c) => c.t === bestT);
      if (idx >= 0) {
        picked.push(candidates[idx]);
        chosen.add(bestT);
        times.push(bestT);
        times.sort((x, y) => x - y);
        inserted = true;
        break;
      }
    }
    if (!inserted) break;
  }

  picked.sort((a, b) => a.t - b.t);
  return picked.map((c) => ({
    t: c.t,
    power: c.power,
    band: c.band,
    synthetic: false,
    midi: c.midi,
    dyn: c.dyn,
  }));
}
