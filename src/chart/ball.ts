import { clamp, h00, h01, h10, h11 } from '../util/math.ts';
import type { BallState, Chart, Segment } from '../types.ts';

/**
 * 定位 t 所在的段。
 * hint 用于顺序播放时的 O(1) 快速命中；seek 时退化到二分。
 */
export function segIndexAt(chart: Chart, t: number, hint = -1): number {
  const segs = chart.segs;
  const n = segs.length;
  if (n === 0) return -1;

  if (hint >= 0 && hint < n) {
    const s = segs[hint];
    if (t >= s.t0 && t <= s.t1) return hint;
    const next = segs[hint + 1];
    if (next && t >= next.t0 && t <= next.t1) return hint + 1;
  }

  if (t <= segs[0].t0) return 0;
  if (t >= segs[n - 1].t1) return n - 1;

  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].t0 <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** 球在段内的归一化进度 u ∈ [0,1] */
export function localU(seg: Segment, t: number): number {
  const dt = seg.t1 - seg.t0;
  return dt > 0 ? clamp((t - seg.t0) / dt, 0, 1) : 0;
}

/**
 * 球在 t 时刻的世界坐标。
 *
 * 垂直：y(s) = y0 + dy*(s/dt) + ½g·s·(s−dt)
 *   s=0 严格给 y0，s=dt 严格给 y0+dy —— 与 g 的取值无关。
 *   这就是「球必然精确落在拍点上」的全部数学依据。
 *
 * 水平：三次 Hermite，u=0/1 严格给 x0/x1，段边界速度连续。
 */
export function evalBall(chart: Chart, t: number, out: BallState, hint = -1): number {
  const i = segIndexAt(chart, t, hint);
  if (i < 0) {
    out.x = 0;
    out.y = 0;
    out.seg = 0;
    return 0;
  }
  const seg = chart.segs[i];
  const dt = seg.t1 - seg.t0;
  const s = clamp(t - seg.t0, 0, dt);
  const u = dt > 0 ? s / dt : 0;

  out.y = seg.y0 + seg.dy * u + 0.5 * seg.g * s * (s - dt);
  out.x =
    h00(u) * seg.x0 + h10(u) * seg.m0 * dt + h01(u) * seg.x1 + h11(u) * seg.m1 * dt;
  out.seg = i;
  return i;
}

/**
 * 相机世界 y。
 *
 * 刻意做成「拍点 y 值的分段线性插值」（= 抛物线两端点的弦），而不是平滑跟随：
 * - 平滑跟随有滞后，球会永远偏离锚点，且帧率相关、不可 seek；
 * - 弦线插值在 t_i 处严格等于 y_i → 撞击那一帧球精确停在屏幕 65% 线上。
 * 段内球只在弦上方偏移一个有界量（顶点处 (2/3)Δy），视觉上就是「球弹起来了」。
 */
export function evalCamera(chart: Chart, t: number, hint = -1): number {
  const i = segIndexAt(chart, t, hint);
  if (i < 0) return 0;
  const seg = chart.segs[i];
  const dt = seg.t1 - seg.t0;
  const s = clamp(t - seg.t0, 0, dt);
  return seg.y0 + (dt > 0 ? seg.dy * (s / dt) : 0);
}

/** 撞击瞬间的「年龄」（秒）。不在撞击点附近时返回负数。 */
export function hitAge(chart: Chart, segIndex: number, t: number): number {
  const seg = chart.segs[segIndex];
  if (!seg) return -1;
  return t - seg.t1;
}

/** 最后一个「已经被撞到」的板索引（board.t <= t）。用二分，供震动与特效使用。 */
export function boardIndexAt(chart: Chart, t: number): number {
  const boards = chart.boards;
  const n = boards.length;
  if (n === 0) return -1;
  if (t < boards[0].t) return -1;
  if (t >= boards[n - 1].t) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (boards[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}
