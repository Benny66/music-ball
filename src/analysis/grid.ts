import { clamp } from '../util/math.ts';
import type { Beat } from '../types.ts';
import type { LowBandOnsets } from './lowband.ts';

export interface Onset {
  t: number;
  strength: number;
}

export interface GridOptions {
  /** 吸附窗硬顶（秒）。40ms ≈ 视觉上「算踩中」容差（±1/16 拍）的 1.3 倍 */
  maxSnap?: number;
  /** 吸附窗相对拍长的比例 */
  snapRatio?: number;
  /** 输出时的最小拍间隔（秒），必须 > 下游的 dtMin */
  minGap?: number;
}

export interface GridResult {
  beats: Beat[];
  /** 拟合出的拍长（秒） */
  period: number;
  /** 稳健拟合后，内点相对网格的最大残差（单位：拍） */
  drift: number;
  /** 被判为离群、不参与拟合的拍比例 */
  outlierRatio: number;
  /** 最终被吸附到 onset 的拍比例 */
  snappedRatio: number;
}

const DEF = { maxSnap: 0.04, snapRatio: 0.1, minGap: 0.1 };

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const idx = clamp(q, 0, 1) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/** 截尾均值：对「0.75×/1.25× 交替」这种抖动给出正确的 1.0×，又能把「跳过一拍」的 2× 剔掉 */
function trimmedMean(values: number[], trim = 0.25): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const cut = Math.floor(s.length * trim);
  const slice = s.slice(cut, s.length - cut);
  const use = slice.length > 0 ? slice : s;
  let sum = 0;
  for (const v of use) sum += v;
  return sum / use.length;
}

/**
 * 稳健网格拟合 + 小窗吸附。
 *
 * 为什么需要这一步：DP 的问题不是「找错拍」，而是在正确拍附近 ±25% 乱跳
 * （实测真实曲目有 12%–23% 的间隔落在 0.75×/1.25×）。
 * 直接把链吸附到最近的 onset 只会把抖动搬个地方，必须先拟合出一条规则网格，
 * 再用 ±40ms 的小窗把网格点拉回真实鼓点。
 *
 * 1) 用截尾均值估周期 → 展开每拍的「拍序号 k」→ Theil-Sen 稳健直线拟合 t = a + b·k
 * 2) 残差 > 0.25 拍的判为外点、剔除后重拟合
 * 3) 每个网格点在 ±min(0.1P, 40ms) 内找最近的强 onset，门控不满足就留在网格上
 */
export function regularizeBeats(
  beats: Beat[],
  low: LowBandOnsets,
  broad: Onset[],
  opts: GridOptions = {},
  strengthAt?: (t: number) => number,
): GridResult {
  const cfg = { ...DEF, ...opts };
  const n = beats.length;
  if (n < 4) {
    return { beats: beats.slice(), period: 0, drift: 0, outlierRatio: 0, snappedRatio: 0 };
  }

  // ---- 1) 初估周期 ----
  const rawGaps: number[] = [];
  for (let i = 1; i < n; i++) rawGaps.push(beats[i].t - beats[i - 1].t);
  let period = trimmedMean(rawGaps);
  if (!(period > 0.15)) period = 0.5;

  // ---- 2) 先剔掉「伪拍」----
  // DP 会在两个真拍之间插进一个多余点（实测 0.5× 间隔）。这类点必须删掉，
  // 否则它会让后面的拍序号整体错位，拟合斜率直接减半。
  const kept: Beat[] = [beats[0]];
  let dropped = 0;
  for (let i = 1; i < n; i++) {
    if (beats[i].t - kept[kept.length - 1].t < period * 0.7) {
      dropped++;
      continue;
    }
    kept.push(beats[i]);
  }
  const m = kept.length;
  if (m < 4) {
    return { beats: beats.slice(), period, drift: 0, outlierRatio: 0, snappedRatio: 0 };
  }

  const times = kept.map((b) => b.t);

  // ---- 3) 局部周期（截尾均值，窗口 ±8 拍）----
  // 截尾均值对「0.75×/1.25× 交替」给出正确的 1.0×，又把「跳过一拍」的 2× 剔掉。
  const gLocal = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const lo = Math.max(0, i - 8);
    const hi = Math.min(m - 1, i + 8);
    const gs: number[] = [];
    for (let j = lo; j < hi; j++) gs.push(times[j + 1] - times[j]);
    gLocal[i] = trimmedMean(gs, 0.25);
  }

  // ---- 4) 锁相环网格 ----
  // 全局的「周期 + 相位」在变速曲上必然失败：一首歌里 100→140 BPM，一个固定周期
  // 不可能同时匹配两段。改用锁相环 —— 预测 = 上一格 + 局部周期，
  // 误差限幅 ±0.3 拍、只吸收 30%：抖动被抹平，慢速变速被跟随，跳拍也不会把网格拽飞。
  const grid = new Float64Array(m);
  grid[0] = times[0];
  let drift = 0;
  for (let i = 1; i < m; i++) {
    const P = clamp(gLocal[i - 1], 0.25, 1.3);
    const pred = grid[i - 1] + P;
    const err = clamp(times[i] - pred, -0.3 * P, 0.3 * P);
    let t = pred + 0.3 * err;
    if (t - grid[i - 1] < cfg.minGap) t = grid[i - 1] + cfg.minGap;
    grid[i] = t;
    drift = Math.max(drift, Math.abs(times[i] - t) / P);
  }

  const gridGaps: number[] = [];
  for (let i = 1; i < m; i++) gridGaps.push(grid[i] - grid[i - 1]);
  period = percentile(gridGaps, 0.5);
  if (!(period > 0.15)) period = 0.5;

  // ---- 5) 小窗吸附 ----
  const lowList: Onset[] = low.times.map((t, i) => ({ t, strength: low.strength[i] }));
  const lowFloor = percentile(low.strength, 0.3);
  const broadFloor = percentile(broad.map((o) => o.strength), 0.3);

  const nearest = (list: Onset[], t: number, w: number): Onset | null => {
    let best: Onset | null = null;
    let bestScore = -1;
    for (const o of list) {
      const d = Math.abs(o.t - t);
      if (d > w) continue;
      const score = o.strength * (1 - (d / w) * 0.5);
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    return best;
  };

  const out: Beat[] = [];
  let prevT = -1e9;
  let snapped = 0;

  for (let i = 0; i < m; i++) {
    const gridT = grid[i];
    const w = Math.min(cfg.maxSnap, cfg.snapRatio * period);

    let pick: Onset | null = null;
    const lo = nearest(lowList, gridT, w);
    const br = nearest(broad, gridT, w);
    // 低频优先：kick 才是「拍」的本体，中高频更多是人声与镲
    if (lo && lo.strength >= lowFloor) pick = lo;
    if (br && br.strength >= broadFloor && (!pick || br.strength > pick.strength * 1.5)) pick = br;

    let t = pick ? pick.t : gridT;
    t = Math.max(t, prevT + cfg.minGap);
    if (pick) snapped++;

    const prev = out[out.length - 1];
    out.push({
      t: clamp(t, 0, times[m - 1] + period),
      power: strengthAt ? clamp(strengthAt(t), 0.02, 1) : (kept[i].power ?? prev?.power ?? 0.6),
      band: kept[i].band,
      synthetic: kept[i].synthetic,
    });
    prevT = out[out.length - 1].t;
  }

  if (out.length < 2) {
    return { beats: beats.slice(), period, drift, outlierRatio: dropped / n, snappedRatio: 0 };
  }

  return {
    beats: out,
    period,
    drift,
    outlierRatio: dropped / n,
    snappedRatio: snapped / Math.max(1, out.length),
  };
}
