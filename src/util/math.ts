export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 0..1 的三次平滑，端点导数为 0 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Hermite 基函数，u ∈ [0,1]。u=0 严格给 p0，u=1 严格给 p1。 */
export const h00 = (u: number): number => 2 * u * u * u - 3 * u * u + 1;
export const h10 = (u: number): number => u * u * u - 2 * u * u + u;
export const h01 = (u: number): number => -2 * u * u * u + 3 * u * u;
export const h11 = (u: number): number => u * u * u - u * u;

/** 三点中值滤波，原地返回新数组 */
export function median3(src: ArrayLike<number>): Float64Array {
  const n = src.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  if (n < 3) {
    for (let i = 0; i < n; i++) out[i] = src[i];
    return out;
  }
  out[0] = src[0];
  out[n - 1] = src[n - 1];
  for (let i = 1; i < n - 1; i++) {
    const a = src[i - 1];
    const b = src[i];
    const c = src[i + 1];
    out[i] = a < b ? (b < c ? b : a < c ? c : a) : b < c ? (a < c ? a : c) : b;
  }
  return out;
}

/** 前缀和，用于 O(1) 滑窗均值 */
export function prefixSum(src: ArrayLike<number>): Float64Array {
  const n = src.length;
  const out = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) out[i + 1] = out[i] + src[i];
  return out;
}

/** 用前缀和求 [i-radius, i+radius] 的均值 */
export function windowMean(prefix: Float64Array, i: number, radius: number): number {
  const n = prefix.length - 1;
  const lo = Math.max(0, i - radius);
  const hi = Math.min(n, i + radius + 1);
  return hi > lo ? (prefix[hi] - prefix[lo]) / (hi - lo) : 0;
}

/** 指数衰减包络，age 为秒 */
export const decay = (age: number, tau: number): number => (age < 0 ? 0 : Math.exp(-age / tau));
