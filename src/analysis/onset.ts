import { fftRadix2, hannWindow } from './fft.ts';
import { prefixSum, windowMean } from '../util/math.ts';

export const FFT_N = 1024;
export const FFT_HOP = 256;

/** 三个频段的边界（Hz）。high 段提供最锐的瞬态定时，low 段用于 kick 分类。 */
const BAND_LO = [20, 200, 2000];
const BAND_HI = [200, 2000, 8000];

export interface BandFlux {
  /** 每帧一个标量的正向谱通量（已做局部均值白化，未做全局归一化） */
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  /** 三频段加权合成后的总包络 */
  env: Float32Array;
  /** 每帧的短时能量（线性幅度和），用于判断「有没有声音」 */
  energy: Float32Array;
  hopSec: number;
  /** 第 i 帧的代表时刻 = (i*hop + N/2) / sr 中的 N/2 部分（秒） */
  centerOffsetSec: number;
  sr: number;
}

/**
 * 分频段谱通量。
 *
 * 关键点：
 * - 只用 max(0, m[n]-m[n-1]) 的正半波，负半波是能量衰减，不是起音。
 * - 幅度做 log1p 压缩，否则 20–200Hz 会独占 70%+ 能量，visual 会变成「只有底鼓在动」。
 * - 时间戳必须加 N/2 窗中心补偿，否则全曲恒定滞后 11.6ms（最常见的「总觉得慢半拍」）。
 */
export function bandFlux(pcm: Float32Array, sr: number): BandFlux {
  const N = FFT_N;
  const hop = FFT_HOP;
  const len = pcm.length;
  const frames = len >= N ? Math.floor((len - N) / hop) + 1 : 0;

  const win = hannWindow(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const mag = new Float64Array(N >> 1);

  const bins = N >> 1;
  const nyquist = sr / 2;
  // 只算到 8kHz，其余 bin 不参与任何计算（省 60%+ 的 log 开销）
  const topBin = Math.max(1, Math.min(bins, Math.ceil((BAND_HI[2] / nyquist) * bins)));

  const bandBin: number[][] = [];
  for (let b = 0; b < 3; b++) {
    const lo = Math.max(1, Math.round((BAND_LO[b] / nyquist) * bins));
    const hi = Math.max(lo + 1, Math.min(topBin, Math.round((BAND_HI[b] / nyquist) * bins)));
    const idx: number[] = [];
    for (let k = lo; k < hi; k++) idx.push(k);
    bandBin.push(idx);
  }

  const low = new Float32Array(frames);
  const mid = new Float32Array(frames);
  const high = new Float32Array(frames);
  const energy = new Float32Array(frames);

  const prevLow = new Float64Array(bins);
  const prevMid = new Float64Array(bins);
  const prevHigh = new Float64Array(bins);

  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let k = 0; k < N; k++) {
      re[k] = pcm[off + k] * win[k];
      im[k] = 0;
    }
    fftRadix2(re, im);

    for (let k = 0; k < topBin; k++) {
      const r = re[k];
      const i2 = im[k];
      mag[k] = Math.log1p(Math.sqrt(r * r + i2 * i2));
    }

    let sum = 0;
    let cnt = 0;
    for (let j = 0; j < bandBin[0].length; j++) {
      const k = bandBin[0][j];
      const d = mag[k] - prevLow[k];
      if (d > 0) sum += d;
      prevLow[k] = mag[k];
      cnt++;
    }
    low[f] = sum / cnt;

    sum = 0;
    cnt = 0;
    for (let j = 0; j < bandBin[1].length; j++) {
      const k = bandBin[1][j];
      const d = mag[k] - prevMid[k];
      if (d > 0) sum += d;
      prevMid[k] = mag[k];
      cnt++;
    }
    mid[f] = sum / cnt;

    sum = 0;
    cnt = 0;
    for (let j = 0; j < bandBin[2].length; j++) {
      const k = bandBin[2][j];
      const d = mag[k] - prevHigh[k];
      if (d > 0) sum += d;
      prevHigh[k] = mag[k];
      cnt++;
    }
    high[f] = sum / cnt;

    let e = 0;
    for (let k = 0; k < topBin; k++) e += mag[k];
    energy[f] = e / topBin;
  }

  // 局部均值白化：每段独立减掉 ±0.4s 的滑动均值，再做全局归一化。
  // 这是峰值拾取在整首歌里保持稳定的关键 —— 副歌比主歌响 10 倍也不会漏检。
  const hopSec = hop / sr;
  const radius = Math.max(1, Math.round(0.4 / hopSec));
  const whiten = (src: Float32Array): Float32Array => {
    const prefix = prefixSum(src);
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const v = src[i] - windowMean(prefix, i, radius);
      out[i] = v > 0 ? v : 0;
    }
    return out;
  };

  const lowN = whiten(low);
  const midN = whiten(mid);
  const highN = whiten(high);

  // 各频段归一化到同一量级后加权。high 权重稍高，因为它的瞬态最锐。
  const env = new Float32Array(frames);
  const norm = (src: Float32Array): number => {
    let m = 0;
    for (let i = 0; i < src.length; i++) if (src[i] > m) m = src[i];
    return m > 0 ? m : 1;
  };
  const nl = norm(lowN);
  const nm = norm(midN);
  const nh = norm(highN);
  for (let i = 0; i < frames; i++) {
    env[i] = (lowN[i] / nl) * 1.0 + (midN[i] / nm) * 0.8 + (highN[i] / nh) * 0.6;
  }

  return {
    low: lowN,
    mid: midN,
    high: highN,
    env,
    energy,
    hopSec,
    centerOffsetSec: N / 2 / sr,
    sr,
  };
}

/** 帧索引 → 秒（含窗中心补偿） */
export const frameToSec = (f: BandFlux, frame: number): number =>
  (frame * FFT_HOP) / f.sr + f.centerOffsetSec;

/** 秒 → 帧索引（浮点） */
export const secToFrame = (f: BandFlux, t: number): number =>
  ((t - f.centerOffsetSec) * f.sr) / FFT_HOP;

export interface Peak {
  /** 帧索引（已做抛物线亚帧细化，可为小数） */
  frame: number;
  t: number;
  strength: number;
}

/**
 * 自适应阈值峰值拾取。
 * 阈值 = 局部均值 + k * 局部标准差，配合最小间隔与抛物线细化。
 */
export function pickPeaks(
  src: Float32Array,
  flux: BandFlux,
  opts: { k?: number; winSec?: number; minGapSec?: number } = {},
): Peak[] {
  const k = opts.k ?? 1.2;
  const winSec = opts.winSec ?? 0.35;
  const minGap = opts.minGapSec ?? 0.06;

  const n = src.length;
  if (n < 5) return [];
  const radius = Math.max(1, Math.round(winSec / flux.hopSec));
  const minGapFrames = Math.max(1, Math.round(minGap / flux.hopSec));

  const prefix = prefixSum(src);
  const prefixSq = prefixSum(
    (() => {
      const sq = new Float32Array(n);
      for (let i = 0; i < n; i++) sq[i] = src[i] * src[i];
      return sq;
    })(),
  );

  const peaks: Peak[] = [];
  let lastKept = -1e9;

  for (let i = 2; i < n - 2; i++) {
    const v = src[i];
    if (v <= 0) continue;
    // 局部极大（±2 帧）
    if (v < src[i - 1] || v < src[i - 2] || v < src[i + 1] || v < src[i + 2]) continue;

    const mean = windowMean(prefix, i, radius);
    const meanSq = windowMean(prefixSq, i, radius);
    const std = Math.sqrt(Math.max(0, meanSq - mean * mean));
    if (v < mean + k * std) continue;

    if (i - lastKept < minGapFrames) {
      // 与上一个峰太近，保留更强的那个
      if (peaks.length > 0) {
        const prev = peaks[peaks.length - 1];
        if (v > prev.strength) {
          peaks.pop();
        } else {
          continue;
        }
      }
    }

    // 抛物线插值细化峰位
    const a = src[i - 1];
    const b = v;
    const c = src[i + 1];
    const denom = a - 2 * b + c;
    const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    const frame = i + Math.max(-0.5, Math.min(0.5, delta));

    peaks.push({ frame, t: frameToSec(flux, frame), strength: v });
    lastKept = i;
  }

  return peaks;
}
